import assert from "node:assert/strict";
import test from "node:test";

const { toFlatParameters, toFunctionDefinitions, buildNameMap } = await import(
  "../dist/bridge/schema.js"
);
const { truncateForModel, Bridge, buildSystemPrompt } = await import("../dist/bridge/bridge.js");
const { parseSsePayload } = await import("../dist/bridge/mcpClient.js");
const { endpointFor } = await import("../dist/bridge/model.js");

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

test("parseSsePayload unwraps data: lines", () => {
  const body = 'event: message\ndata: {"result":{"ok":true}}\n\n';
  assert.deepEqual(parseSsePayload(body), { result: { ok: true } });
});

test("parseSsePayload joins multi-line data and falls back to bare JSON", () => {
  const multi = 'data: {"a":1,\ndata: "b":2}\n';
  assert.deepEqual(parseSsePayload(multi), { a: 1, b: 2 });
  // Proxies sometimes strip the SSE envelope entirely.
  assert.deepEqual(parseSsePayload('{"plain":true}'), { plain: true });
});

// ---------------------------------------------------------------------------
// Schema flattening — the piece that decides whether a hosted model can call
// the discriminated tools at all.
// ---------------------------------------------------------------------------

const gitWorkflowSchema = {
  type: "object",
  oneOf: [
    {
      type: "object",
      properties: { action: { type: "string", const: "status" }, path: { type: "string" } },
      required: ["action", "path"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { type: "string", const: "diff" }, path: { type: "string" } },
      required: ["action", "path"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { type: "string", const: "log" }, path: { type: "string" }, max: { type: "integer" } },
      required: ["action", "path"],
      additionalProperties: false,
    },
  ],
};

test("oneOf discriminators become a flat enum the model can emit", () => {
  const flat = toFlatParameters(gitWorkflowSchema);
  assert.equal(flat.type, "object");
  assert.equal(flat.oneOf, undefined, "oneOf must not survive: hosted APIs reject it");
  const action = flat.properties.action;
  assert.deepEqual(action.enum, ["status", "diff", "log"]);
  assert.equal(action.type, "string");
  // The discriminator must be required so the model always states the action.
  assert.ok(flat.required.includes("action"));
  // Properties unique to one branch still appear in the shared bag.
  assert.ok("max" in flat.properties);
});

test("flattening keeps only properties required by every branch", () => {
  const flat = toFlatParameters({
    type: "object",
    oneOf: [
      { type: "object", properties: { action: { const: "a" }, x: { type: "string" } }, required: ["action", "x"] },
      { type: "object", properties: { action: { const: "b" }, y: { type: "string" } }, required: ["action", "y"] },
    ],
  });
  // Requiring x or y would make the other branch impossible to satisfy.
  assert.deepEqual([...flat.required].sort(), ["action"]);
  assert.ok("x" in flat.properties);
  assert.ok("y" in flat.properties);
});

test("plain object schemas pass through with required intact", () => {
  const flat = toFlatParameters({
    type: "object",
    properties: { path: { type: "string" }, encoding: { type: "string" } },
    required: ["path"],
  });
  assert.deepEqual(flat.required, ["path"]);
  assert.deepEqual(Object.keys(flat.properties).sort(), ["encoding", "path"]);
  assert.equal(flat.additionalProperties, false);
});

test("a missing schema degrades to an empty object rather than throwing", () => {
  assert.deepEqual(toFlatParameters(undefined), {
    type: "object",
    properties: {},
    additionalProperties: false,
  });
});

test("nested unions inside a property are widened instead of leaking oneOf", () => {
  const flat = toFlatParameters({
    type: "object",
    properties: { config: { oneOf: [{ type: "object" }, { type: "string" }] } },
  });
  assert.equal(JSON.stringify(flat).includes("oneOf"), false);
});

test("toFunctionDefinitions trims long descriptions and sanitizes names", () => {
  const definitions = toFunctionDefinitions(
    [{ name: "read_file", description: "x".repeat(500), inputSchema: { type: "object", properties: {} } }],
    { maxDescription: 50 },
  );
  assert.ok(definitions[0].description.length <= 50);
  assert.equal(definitions[0].name, "read_file");
});

test("buildNameMap maps sanitized names back to originals", () => {
  const map = buildNameMap([{ name: "manage_clients" }, { name: "read_file" }]);
  assert.equal(map.get("manage_clients"), "manage_clients");
  assert.equal(map.size, 2);
});

// ---------------------------------------------------------------------------
// Model plumbing
// ---------------------------------------------------------------------------

test("endpointFor handles base URLs with and without /v1", () => {
  assert.equal(endpointFor("https://api.deepseek.com", "/chat/completions"), "https://api.deepseek.com/chat/completions");
  assert.equal(endpointFor("https://api.deepseek.com/v1", "/chat/completions"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(endpointFor("https://api.anthropic.com", "/v1/messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(endpointFor("http://localhost:11434/v1/", "/chat/completions"), "http://localhost:11434/v1/chat/completions");
});

test("truncateForModel keeps head and tail of oversized output", () => {
  const text = "H".repeat(9000) + "MIDDLE" + "T".repeat(9000);
  const cut = truncateForModel(text, 2000);
  assert.ok(cut.length < text.length);
  assert.ok(cut.startsWith("H"));
  assert.ok(cut.endsWith("T"));
  assert.match(cut, /truncated \d+ characters/);
  // Small payloads are untouched.
  assert.equal(truncateForModel("short", 2000), "short");
});

test("system prompt states the trust boundary", () => {
  const prompt = buildSystemPrompt({ hostDescription: "a Windows box" });
  assert.match(prompt, /really executes/);
  assert.match(prompt, /approval/);
  assert.match(prompt, /allowed directories/);
});

// ---------------------------------------------------------------------------
// Bridge loop, driven by fake MCP + fake model
// ---------------------------------------------------------------------------

function fakeMcp(responses) {
  const calls = [];
  return {
    calls,
    async listTools() {
      return [
        { name: "read_file", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
        { name: "write_file", description: "write", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      const handler = responses[name];
      if (!handler) return { content: [{ type: "text", text: "ok" }] };
      return typeof handler === "function" ? handler(args) : handler;
    },
  };
}

function fakeModel(replies) {
  const seen = [];
  return {
    label: "fake",
    seen,
    async complete(turns) {
      seen.push(turns.map((t) => ({
        role: t.role,
        content: t.content,
        toolCalls: t.toolCalls,
        toolCallId: t.toolCallId,
      })));
      const next = replies.shift();
      if (!next) throw new Error("fake model ran out of replies");
      return next;
    },
  };
}

test("bridge executes a tool call and returns the final answer", async () => {
  const mcp = fakeMcp({
    read_file: { content: [{ type: "text", text: "file contents" }] },
  });
  const model = fakeModel([
    { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
    { text: "The file says: file contents", toolCalls: [] },
  ]);
  const events = [];
  const bridge = new Bridge({
    mcp, model, systemPrompt: "test",
    onEvent: (event) => events.push(event),
  });

  const result = await bridge.send("read a.txt");
  assert.equal(result.text, "The file says: file contents");
  assert.equal(result.toolCallCount, 1);
  assert.equal(result.stopped, "complete");
  assert.deepEqual(mcp.calls, [{ name: "read_file", args: { path: "a.txt" } }]);

  // The tool result must be fed back, or the model answers blind.
  const secondTurn = model.seen[1];
  const toolTurn = secondTurn.find((t) => t.role === "tool");
  assert.equal(toolTurn.content, "file contents");

  assert.ok(events.some((e) => e.kind === "tool_call" && e.name === "read_file"));
  assert.ok(events.some((e) => e.kind === "tool_result" && e.isError === false));
});

test("a failing tool is reported to the model instead of aborting", async () => {
  const mcp = fakeMcp({
    read_file: { content: [{ type: "text", text: "ENOENT: no such file" }], isError: true },
  });
  const model = fakeModel([
    { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "missing.txt" } }] },
    { text: "That file does not exist.", toolCalls: [] },
  ]);
  const bridge = new Bridge({ mcp, model, systemPrompt: "test" });

  const result = await bridge.send("read missing.txt");
  assert.equal(result.text, "That file does not exist.");
  const toolTurn = model.seen[1].find((t) => t.role === "tool");
  assert.match(toolTurn.content, /Tool reported an error/);
  assert.match(toolTurn.content, /ENOENT/);
});

test("multiple tool calls in one turn are all answered", async () => {
  const mcp = fakeMcp({});
  const model = fakeModel([
    {
      text: "",
      toolCalls: [
        { id: "c1", name: "read_file", arguments: { path: "a" } },
        { id: "c2", name: "read_file", arguments: { path: "b" } },
      ],
    },
    { text: "done", toolCalls: [] },
  ]);
  const bridge = new Bridge({ mcp, model, systemPrompt: "test" });

  const result = await bridge.send("read both");
  assert.equal(result.toolCallCount, 2);
  const toolTurns = model.seen[1].filter((t) => t.role === "tool");
  // Every call needs a matching result or providers reject the request.
  assert.equal(toolTurns.length, 2);
  assert.deepEqual(toolTurns.map((t) => t.toolCallId), ["c1", "c2"]);
});

test("unknown tool names are rejected without hitting the server", async () => {
  const mcp = fakeMcp({});
  const model = fakeModel([
    { text: "", toolCalls: [{ id: "c1", name: "delete_everything", arguments: {} }] },
    { text: "I cannot do that.", toolCalls: [] },
  ]);
  const bridge = new Bridge({ mcp, model, systemPrompt: "test" });

  await bridge.send("delete everything");
  assert.equal(mcp.calls.length, 0, "an invented tool must not reach the server");
  const toolTurn = model.seen[1].find((t) => t.role === "tool");
  assert.match(toolTurn.content, /Unknown tool/);
  assert.match(toolTurn.content, /read_file/, "the error should list real tools");
});

test("malformed JSON arguments are reported to the model", async () => {
  const mcp = fakeMcp({});
  const model = fakeModel([
    { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { __raw: '{"path": ' } }] },
    { text: "Let me retry.", toolCalls: [] },
  ]);
  const bridge = new Bridge({ mcp, model, systemPrompt: "test" });

  await bridge.send("read");
  assert.equal(mcp.calls.length, 0);
  const toolTurn = model.seen[1].find((t) => t.role === "tool");
  assert.match(toolTurn.content, /not valid JSON/);
});

test("the turn budget stops a runaway loop", async () => {
  const mcp = fakeMcp({});
  // Always asks for another tool: without a cap this never ends.
  const model = fakeModel(
    Array.from({ length: 10 }, () => ({
      text: "",
      toolCalls: [{ id: "c", name: "read_file", arguments: { path: "x" } }],
    })),
  );
  const bridge = new Bridge({ mcp, model, systemPrompt: "test", maxTurns: 3 });

  const result = await bridge.send("loop forever");
  assert.equal(result.stopped, "max_turns");
  assert.equal(result.modelTurns, 3);
});

test("the tool-call budget stops even within the turn budget", async () => {
  const mcp = fakeMcp({});
  const model = fakeModel([
    {
      text: "",
      toolCalls: Array.from({ length: 5 }, (_, i) => ({
        id: `c${i}`, name: "read_file", arguments: { path: `f${i}` },
      })),
    },
    { text: "done", toolCalls: [] },
  ]);
  const bridge = new Bridge({ mcp, model, systemPrompt: "test", maxToolCalls: 2 });

  const result = await bridge.send("read five");
  assert.equal(result.stopped, "max_tool_calls");
  assert.equal(result.toolCallCount, 2);
  assert.equal(mcp.calls.length, 2, "only the budgeted calls may reach the server");

  // The skipped call still gets a result so the history stays replayable.
  const toolTurns = result.turns.filter((t) => t.role === "tool");
  assert.equal(toolTurns.length, 3);
  assert.match(toolTurns.at(-1).content, /Skipped/);
  assert.equal(toolTurns.at(-1).toolCallId, "c2");
});

test("conversation history carries across messages", async () => {
  const mcp = fakeMcp({});
  const model = fakeModel([
    { text: "First answer.", toolCalls: [] },
    { text: "Second answer.", toolCalls: [] },
  ]);
  const bridge = new Bridge({ mcp, model, systemPrompt: "test" });

  const first = await bridge.send("hello");
  const second = await bridge.send("and again", first.turns);

  const secondRequest = model.seen[1];
  const userTurns = secondRequest.filter((t) => t.role === "user").map((t) => t.content);
  assert.deepEqual(userTurns, ["hello", "and again"]);
  assert.ok(secondRequest.some((t) => t.role === "assistant" && t.content === "First answer."));
  assert.equal(second.text, "Second answer.");
});
