/**
 * Minimal MCP client for the win_mcp HTTP transport.
 *
 * Deliberately dependency-free and stateless:
 *
 *   - `fetch` is built into Node 18+, so the bridge needs no install step and
 *     users can run it straight from a clone.
 *   - win_mcp accepts JSON-RPC without an `initialize` handshake and does not
 *     require a session id, verified against the running server. Skipping the
 *     handshake keeps the bridge a pure request/response shim.
 *
 * The one non-obvious part: the server always replies with
 * `text/event-stream`, and returns 406 if the client asks for plain JSON. So we
 * must send BOTH media types in `Accept` and then unwrap the SSE envelope.
 */

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpTextContent {
  type: string;
  text?: string;
}

export interface McpToolResult {
  content?: McpTextContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * A pending approval the server needs before it can run the tool.
 *
 * win_mcp returns `resultType: "input_required"` instead of a normal result
 * when a write/command needs confirmation. The client must show the form and
 * retry the same call with `requestState` plus the user's response.
 */
export interface McpInputRequest {
  requestState: string;
  inputRequests: Record<string, {
    method?: string;
    params?: {
      message?: string;
      requestedSchema?: {
        properties?: Record<string, { title?: string; enum?: unknown[] }>;
        required?: string[];
      };
    };
  }>;
}

export type McpCallOutcome =
  | { kind: "result"; result: McpToolResult }
  | { kind: "input_required"; request: McpInputRequest };

/**
 * Asks the user to authorise an operation. Supplied by the caller so the
 * transport never talks to a terminal itself.
 */
export type ApprovalPrompt = (request: McpInputRequest) => Promise<Record<string, unknown> | undefined>;

export class McpTransportError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "McpTransportError";
    this.status = status;
  }
}

export interface McpClientOptions {
  /** Full endpoint URL, e.g. https://host/mcp or http://127.0.0.1:3000/mcp */
  url: string;
  /** Bearer credential: a paired client key or MCP_AUTH_TOKEN. */
  token?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Resolves approval prompts. Without it the server refuses every operation
   * that needs confirmation, because it treats this client as unable to show
   * a form (`CLIENT_ELEICITATION_UNSUPPORTED`).
   */
  approvalPrompt?: ApprovalPrompt;
  /** Maximum approval round-trips per tool call. */
  maxApprovalRounds?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_APPROVAL_ROUNDS = 4;

/**
 * Advertise elicitation support.
 *
 * The server decides whether to send an approval form based on these request
 * `_meta` fields; omitting them yields CLIENT_ELICITATION_UNSUPPORTED instead
 * of a prompt.
 */
const CLIENT_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
  "io.modelcontextprotocol/clientInfo": { name: "win-mcp-bridge", version: "1.0.0" },
};

/** Parse an SSE body into the JSON payload of its `data:` lines. */
export function parseSsePayload(body: string): unknown {
  const dataLines: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).trim());
  }
  if (dataLines.length === 0) {
    // Some deployments, and proxies in front of them, return bare JSON.
    return JSON.parse(body);
  }
  const joined = dataLines.join("\n");
  return JSON.parse(joined);
}

export class McpClient {
  private readonly url: string;
  private readonly token?: string;
  private readonly timeoutMs: number;
  private readonly approvalPrompt?: ApprovalPrompt;
  private readonly maxApprovalRounds: number;
  private nextId = 1;
  private toolsCache?: McpToolDefinition[];

  constructor(options: McpClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.approvalPrompt = options.approvalPrompt;
    this.maxApprovalRounds = options.maxApprovalRounds ?? DEFAULT_MAX_APPROVAL_ROUNDS;
  }

  private headers(method?: string, params?: Record<string, unknown>): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // The server replies with SSE and returns 406 for application/json alone.
      accept: "application/json, text/event-stream",
    };
    // Only tools/call carries the per-request `_meta` envelope, so only it may
    // advertise the newer protocol revision. Announcing it on tools/list makes
    // the server demand an envelope that call does not carry (HTTP 400).
    if (method === "tools/call") {
      headers["mcp-protocol-version"] = "2026-07-28";
      headers["mcp-method"] = method;
      if (typeof params?.name === "string") headers["mcp-name"] = params.name;
    }
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async rpc(
    method: string,
    params: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: this.headers(method, params),
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params, ...extra }),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = (error as Error)?.name === "AbortError"
        ? `request timed out after ${this.timeoutMs}ms`
        : (error as Error).message;
      throw new McpTransportError(`cannot reach ${this.url}: ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    const body = await response.text();
    if (!response.ok) {
      // 401 is the common first-run mistake (no pairing), so name it clearly.
      const hint = response.status === 401
        ? " Check MCP_BRIDGE_TOKEN: pair a client first (POST /pair with a one-time code)."
        : "";
      throw new McpTransportError(
        `MCP returned HTTP ${response.status}: ${body.slice(0, 200)}${hint}`,
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = parseSsePayload(body);
    } catch {
      throw new McpTransportError(`MCP returned unparseable body: ${body.slice(0, 200)}`);
    }

    const envelope = payload as { error?: { message?: string }; result?: unknown };
    if (envelope.error) {
      throw new McpTransportError(`MCP error: ${envelope.error.message ?? JSON.stringify(envelope.error)}`);
    }
    return envelope.result;
  }

  /** List tools, cached after the first call. */
  async listTools(force = false): Promise<McpToolDefinition[]> {
    if (!this.toolsCache || force) {
      const result = await this.rpc("tools/list", {}) as { tools?: McpToolDefinition[] };
      this.toolsCache = result?.tools ?? [];
    }
    return this.toolsCache;
  }

  /**
   * Call a tool, handling approval prompts.
   *
   * `win_mcp` answers with `resultType: "input_required"` when an operation
   * needs confirmation. We show the form through the injected prompt, then
   * retry the identical call with `requestState` and the response. Declining
   * is reported back as a normal tool error so the model can explain it.
   *
   * Tool failures come back as `isError: true` rather than a transport error,
   * so the caller can show the model what went wrong and let it retry.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    let requestState: string | undefined;
    let inputResponses: Record<string, unknown> | undefined;

    for (let round = 0; round <= this.maxApprovalRounds; round += 1) {
      const params: Record<string, unknown> = {
        name,
        arguments: args,
        _meta: CLIENT_META,
        ...(requestState ? { requestState } : {}),
        ...(inputResponses ? { inputResponses } : {}),
      };

      const raw = await this.rpc("tools/call", params) as Record<string, unknown>;

      if (raw?.resultType !== "input_required") {
        return (raw ?? {}) as McpToolResult;
      }

      const pending: McpInputRequest = {
        requestState: String(raw.requestState ?? ""),
        inputRequests: (raw.inputRequests ?? {}) as McpInputRequest["inputRequests"],
      };

      if (!this.approvalPrompt) {
        return {
          content: [{
            type: "text",
            text:
              "This operation needs confirmation, but the bridge was not given an " +
              "approval prompt. Set MCP_BRIDGE_APPROVE=ask to allow interactive approval.",
          }],
          isError: true,
        };
      }

      const answer = await this.approvalPrompt(pending);
      if (!answer) {
        return {
          content: [{ type: "text", text: "The user declined this operation." }],
          isError: true,
        };
      }
      requestState = pending.requestState;
      inputResponses = answer;
    }

    return {
      content: [{
        type: "text",
        text: `Approval was still pending after ${this.maxApprovalRounds} rounds; giving up.`,
      }],
      isError: true,
    };
  }

  /** Flatten a tool result into text for feeding back to the model. */
  static resultToText(result: McpToolResult): string {
    const parts: string[] = [];
    for (const item of result.content ?? []) {
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
    }
    if (parts.length === 0 && result.structuredContent !== undefined) {
      parts.push(JSON.stringify(result.structuredContent));
    }
    const text = parts.join("\n").trim();
    return text.length > 0 ? text : "(no output)";
  }
}
