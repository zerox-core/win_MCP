/**
 * Bridge loop: hosted model <-> local win_mcp server.
 *
 * The model has no network path to the user's machine. This process is the
 * hands: it teaches the model which tools exist, executes the calls it asks
 * for, and feeds results back until the model stops asking.
 *
 * Loop invariants worth preserving:
 *   - A tool that *fails* still returns its text to the model (isError), so the
 *     model can correct itself. Only transport failures abort.
 *   - Every tool call must get a matching result message, or providers reject
 *     the next request. Unanswered calls are filled explicitly.
 *   - The turn budget is a hard stop, because a confused model will otherwise
 *     call tools until the context or the bill runs out.
 */

import { McpClient, McpTransportError, type McpToolDefinition } from "./mcpClient.js";
import { buildNameMap, toFunctionDefinitions, type FunctionDefinition } from "./schema.js";
import type { ModelClient, Turn, ToolCall } from "./model.js";

export interface BridgeOptions {
  mcp: McpClient;
  model: ModelClient;
  systemPrompt: string;
  /** Maximum model round-trips per user message. */
  maxTurns?: number;
  /** Maximum total tool executions per user message. */
  maxToolCalls?: number;
  /** Called for progress display; defaults to a no-op. */
  onEvent?: (event: BridgeEvent) => void;
}

export type BridgeEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { kind: "tool_result"; name: string; text: string; isError: boolean }
  | { kind: "limit"; reason: string }
  | { kind: "usage"; inputTokens?: number; outputTokens?: number };

export interface BridgeResult {
  /** Final assistant text for this user message. */
  text: string;
  turns: Turn[];
  toolCallCount: number;
  modelTurns: number;
  stopped: "complete" | "max_turns" | "max_tool_calls";
}

const DEFAULT_MAX_TURNS = 24;
const DEFAULT_MAX_TOOL_CALLS = 60;

/**
 * Convert a tool result into text for the model.
 *
 * Large outputs (whole files, test logs) are truncated from the middle: the
 * head usually identifies the content and the tail usually holds the error.
 */
export function truncateForModel(text: string, limit = 12_000): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head - 80;
  return (
    `${text.slice(0, head)}\n\n` +
    `[... truncated ${text.length - head - tail} characters ...]\n\n` +
    text.slice(-tail)
  );
}

export class Bridge {
  private readonly mcp: McpClient;
  private readonly model: ModelClient;
  private readonly systemPrompt: string;
  private readonly maxTurns: number;
  private readonly maxToolCalls: number;
  private readonly onEvent: (event: BridgeEvent) => void;
  private tools?: McpToolDefinition[];
  private definitions?: FunctionDefinition[];
  private nameMap?: Map<string, string>;

  constructor(options: BridgeOptions) {
    this.mcp = options.mcp;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    this.onEvent = options.onEvent ?? (() => {});
  }

  /** Load the tool inventory once and derive the API-facing definitions. */
  async prepare(): Promise<McpToolDefinition[]> {
    this.tools = await this.mcp.listTools();
    this.definitions = toFunctionDefinitions(this.tools);
    this.nameMap = buildNameMap(this.tools);
    return this.tools;
  }

  get toolCount(): number {
    return this.tools?.length ?? 0;
  }

  /**
   * Run one user message to completion.
   *
   * `history` is mutated and returned so a REPL keeps context across messages.
   */
  async send(userMessage: string, history: Turn[] = []): Promise<BridgeResult> {
    if (!this.definitions) await this.prepare();

    const turns: Turn[] = [
      { role: "system", content: this.systemPrompt },
      ...history,
      { role: "user", content: userMessage },
    ];

    let toolCallCount = 0;
    let modelTurns = 0;
    let finalText = "";
    const collected: Turn[] = [{ role: "user", content: userMessage }];

    for (;;) {
      if (modelTurns >= this.maxTurns) {
        this.onEvent({ kind: "limit", reason: `reached ${this.maxTurns} model turns` });
        return { text: finalText, turns: collected, toolCallCount, modelTurns, stopped: "max_turns" };
      }

      const reply = await this.model.complete(turns, this.definitions ?? []);
      modelTurns += 1;
      if (reply.usage) this.onEvent({ kind: "usage", ...reply.usage });
      if (reply.text) {
        finalText = reply.text;
        this.onEvent({ kind: "assistant_text", text: reply.text });
      }

      if (reply.toolCalls.length === 0) {
        turns.push({ role: "assistant", content: reply.text });
        collected.push({ role: "assistant", content: reply.text });
        return { text: reply.text, turns: collected, toolCallCount, modelTurns, stopped: "complete" };
      }

      // Record the assistant's request, then answer every call.
      const assistantTurn: Turn = {
        role: "assistant",
        content: reply.text,
        toolCalls: reply.toolCalls.map((call) => ({
          id: call.id,
          // Store the original name so history stays readable and replayable.
          name: call.name,
          arguments: call.arguments,
        })),
      };
      turns.push(assistantTurn);
      collected.push(assistantTurn);

      for (const call of reply.toolCalls) {
        if (toolCallCount >= this.maxToolCalls) {
          this.onEvent({ kind: "limit", reason: `reached ${this.maxToolCalls} tool calls` });
          // Still answer the outstanding call so the history stays valid.
          const notice = `Skipped: tool-call budget of ${this.maxToolCalls} exhausted.`;
          turns.push({ role: "tool", content: notice, toolCallId: call.id });
          collected.push({ role: "tool", content: notice, toolCallId: call.id });
          return {
            text: finalText,
            turns: collected,
            toolCallCount,
            modelTurns,
            stopped: "max_tool_calls",
          };
        }

        const result = await this.executeToolCall(call);
        turns.push({ role: "tool", content: result.text, toolCallId: call.id });
        collected.push({ role: "tool", content: result.text, toolCallId: call.id });
        toolCallCount += 1;
      }
    }
  }

  private async executeToolCall(call: ToolCall): Promise<{ text: string; isError: boolean }> {
    const original = this.nameMap?.get(call.name) ?? call.name;
    const args = call.arguments ?? {};

    // A model that emitted unparseable JSON gets told so instead of the server
    // receiving garbage and producing a confusing validation error.
    if (Object.prototype.hasOwnProperty.call(args, "__raw")) {
      const message =
        `Your arguments were not valid JSON: ${String((args as { __raw: unknown }).__raw).slice(0, 300)}. ` +
        "Call the tool again with a JSON object.";
      this.onEvent({ kind: "tool_call", name: original, arguments: args });
      this.onEvent({ kind: "tool_result", name: original, text: message, isError: true });
      return { text: message, isError: true };
    }

    this.onEvent({ kind: "tool_call", name: original, arguments: args });

    if (!this.nameMap?.has(call.name)) {
      const known = [...(this.nameMap?.keys() ?? [])].join(", ");
      const message = `Unknown tool "${call.name}". Available tools: ${known}`;
      this.onEvent({ kind: "tool_result", name: call.name, text: message, isError: true });
      return { text: message, isError: true };
    }

    try {
      const result = await this.mcp.callTool(original, args);
      const text = truncateForModel(McpClient.resultToText(result));
      const isError = Boolean(result.isError);
      this.onEvent({ kind: "tool_result", name: original, text, isError });
      return { text: isError ? `Tool reported an error:\n${text}` : text, isError };
    } catch (error) {
      // Transport failure is reported to the model rather than thrown: a single
      // bad call should not end the conversation, but the model must know.
      const message = error instanceof McpTransportError
        ? `Transport error: ${error.message}`
        : `Tool failed: ${(error as Error).message}`;
      this.onEvent({ kind: "tool_result", name: original, text: message, isError: true });
      return { text: message, isError: true };
    }
  }
}

/** Default system prompt: states the trust boundary explicitly. */
export function buildSystemPrompt(options: {
  hostDescription: string;
  extraInstructions?: string;
}): string {
  const base = [
    "You are controlling a real Windows desktop through a tool bridge.",
    "",
    `The machine: ${options.hostDescription}`,
    "",
    "How this works:",
    "- Every tool you call really executes on that machine, as the user's own account.",
    "- File writes, command execution, and Git operations take effect immediately.",
    "- Some tools ask the user for approval and will return a pending/denied result; " +
      "report that to the user instead of retrying repeatedly.",
    "- Paths must stay inside the configured allowed directories. If a call is refused " +
      "for being outside them, tell the user which directory is missing rather than " +
      "trying variations of the path.",
    "",
    "Working style:",
    "- Prefer reading before writing, and show the user what you changed.",
    "- When a tool fails, read its error text carefully; it usually names the fix.",
    "- Do not invent tool names or arguments. Only use the tools provided.",
    "- Keep answers short. The user can see the tool calls already.",
  ].join("\n");
  return options.extraInstructions
    ? `${base}\n\n${options.extraInstructions}`
    : base;
}
