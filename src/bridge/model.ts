/**
 * Hosted-model adapters.
 *
 * Two wire formats cover essentially everything users will have:
 *
 *   openai     — /chat/completions with `tools` + `tool_calls`. DeepSeek,
 *                Moonshot, Zhipu, Qwen, Groq, OpenRouter, vLLM, Ollama, and
 *                LM Studio all speak this, so one adapter serves them all by
 *                changing the base URL.
 *   anthropic  — /v1/messages with `tools` + `tool_use` blocks.
 *
 * The loop in `bridge.ts` is written against a single neutral message shape so
 * neither path leaks into the other.
 */

import type { FunctionDefinition } from "./schema.js";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments; empty object when the model sent none. */
  arguments: Record<string, unknown>;
}

/** Provider-neutral conversation turn. */
export interface Turn {
  role: Role;
  content: string;
  /** Assistant tool requests, in order. */
  toolCalls?: ToolCall[];
  /** Set on `role: "tool"`: which call this result answers. */
  toolCallId?: string;
}

export interface ModelReply {
  text: string;
  toolCalls: ToolCall[];
  /** Present when the provider stopped for a reason worth surfacing. */
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ModelClient {
  readonly label: string;
  complete(turns: Turn[], tools: FunctionDefinition[]): Promise<ModelReply>;
}

export interface ModelOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 180_000;

class ModelHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ModelHttpError";
    this.status = status;
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const reason = (error as Error)?.name === "AbortError"
      ? `timed out after ${timeoutMs}ms`
      : (error as Error).message;
    throw new ModelHttpError(`cannot reach ${url}: ${reason}`, 0);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    // Surface the provider's own message: "invalid api key" and "model not
    // found" are the two failures users actually hit.
    throw new ModelHttpError(
      `${url} returned HTTP ${response.status}: ${text.slice(0, 400)}`,
      response.status,
    );
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ModelHttpError(`${url} returned non-JSON: ${text.slice(0, 200)}`, response.status);
  }
}

/** Normalize a base URL to a specific endpoint. */
export function endpointFor(baseUrl: string, path: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  // Already the full endpoint.
  if (trimmed.endsWith(path)) return trimmed;

  // Anthropic's path is absolute: /v1/messages always includes its version.
  if (path.startsWith("/v1/")) {
    // If the base already carries a version segment, strip it so /v1 is not doubled.
    const withoutVersion = trimmed.replace(/\/v\d+$/, "");
    return `${withoutVersion}${path}`;
  }

  if (/\/v\d+$/.test(trimmed)) return `${trimmed}${path}`;
  return `${trimmed}${path}`;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

interface OpenAiMessage {
  role: string;
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export class OpenAiCompatibleClient implements ModelClient {
  readonly label: string;
  private readonly options: ModelOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ModelOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.label = `${options.model} @ ${options.baseUrl}`;
  }

  async complete(turns: Turn[], tools: FunctionDefinition[]): Promise<ModelReply> {
    const messages: OpenAiMessage[] = [];
    for (const turn of turns) {
      if (turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: turn.content || null,
          tool_calls: turn.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
          })),
        });
      } else if (turn.role === "tool") {
        messages.push({
          role: "tool",
          content: turn.content,
          tool_call_id: turn.toolCallId ?? "",
        });
      } else {
        messages.push({ role: turn.role, content: turn.content });
      }
    }

    const payload: Record<string, unknown> = {
      model: this.options.model,
      messages,
    };
    if (tools.length > 0) {
      payload.tools = tools.map((tool) => ({ type: "function", function: tool }));
      payload.tool_choice = "auto";
    }
    if (this.options.maxTokens) payload.max_tokens = this.options.maxTokens;
    if (this.options.temperature !== undefined) payload.temperature = this.options.temperature;

    const body = await postJson(
      endpointFor(this.options.baseUrl, "/chat/completions"),
      { authorization: `Bearer ${this.options.apiKey}` },
      payload,
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      this.fetchImpl,
    );

    const choices = Array.isArray(body.choices) ? body.choices : [];
    const message = (choices[0] as { message?: Record<string, unknown>; finish_reason?: string })
      ?.message ?? {};
    const rawCalls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as OpenAiMessage["tool_calls"] ?? [])
      : [];

    const toolCalls: ToolCall[] = rawCalls.map((call, index) => ({
      id: call.id || `call_${index}`,
      name: call.function?.name ?? "",
      arguments: parseArguments(call.function?.arguments),
    }));

    const usage = body.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    return {
      text: typeof message.content === "string" ? message.content : "",
      toolCalls,
      stopReason: (choices[0] as { finish_reason?: string })?.finish_reason,
      usage: usage
        ? { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
        : undefined,
    };
  }
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A model that emits malformed JSON should see the error and retry, so keep
    // the raw text where the loop can report it.
    return { __raw: raw };
  }
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

export class AnthropicClient implements ModelClient {
  readonly label: string;
  private readonly options: ModelOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ModelOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.label = `${options.model} @ ${options.baseUrl} (anthropic)`;
  }

  async complete(turns: Turn[], tools: FunctionDefinition[]): Promise<ModelReply> {
    // Anthropic takes the system prompt separately, not as a message.
    const system = turns.filter((turn) => turn.role === "system").map((t) => t.content).join("\n\n");
    const messages: { role: "user" | "assistant"; content: AnthropicBlock[] }[] = [];

    for (const turn of turns) {
      if (turn.role === "system") continue;
      if (turn.role === "tool") {
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: turn.toolCallId ?? "",
            content: turn.content,
          }],
        });
        continue;
      }
      if (turn.role === "assistant") {
        const blocks: AnthropicBlock[] = [];
        if (turn.content) blocks.push({ type: "text", text: turn.content });
        for (const call of turn.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
        }
        if (blocks.length > 0) messages.push({ role: "assistant", content: blocks });
        continue;
      }
      messages.push({ role: "user", content: [{ type: "text", text: turn.content }] });
    }

    const payload: Record<string, unknown> = {
      model: this.options.model,
      max_tokens: this.options.maxTokens ?? 4096,
      messages,
    };
    if (system) payload.system = system;
    if (tools.length > 0) {
      payload.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    if (this.options.temperature !== undefined) payload.temperature = this.options.temperature;

    const body = await postJson(
      endpointFor(this.options.baseUrl, "/v1/messages"),
      {
        "x-api-key": this.options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      payload,
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      this.fetchImpl,
    );

    const blocks = Array.isArray(body.content) ? (body.content as AnthropicBlock[]) : [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const toolCalls: ToolCall[] = blocks
      .filter((b) => b.type === "tool_use")
      .map((block, index) => ({
        id: block.id || `toolu_${index}`,
        name: block.name ?? "",
        arguments: block.input && typeof block.input === "object"
          ? (block.input as Record<string, unknown>)
          : {},
      }));

    const usage = body.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    return {
      text,
      toolCalls,
      stopReason: typeof body.stop_reason === "string" ? body.stop_reason : undefined,
      usage: usage
        ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
        : undefined,
    };
  }
}

/** Build the adapter for a provider id. */
export function createModelClient(provider: string, options: ModelOptions): ModelClient {
  switch (provider) {
    case "anthropic":
      return new AnthropicClient(options);
    case "openai":
    case "deepseek":
    case "openai-compatible":
      return new OpenAiCompatibleClient(options);
    default:
      throw new Error(
        `unknown provider "${provider}" (expected openai, deepseek, openai-compatible, or anthropic)`,
      );
  }
}
