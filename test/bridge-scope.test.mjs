import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

const { SessionScope, isInside } = await import("../dist/bridge/scope.js");
const { Bridge } = await import("../dist/bridge/bridge.js");

const ROOT = process.platform === "win32" ? "F:\\projects\\mine" : "/projects/mine";
const INSIDE = path.join(ROOT, "src", "index.ts");
const OUTSIDE = process.platform === "win32" ? "F:\\projects\\other\\secret.txt" : "/projects/other/secret.txt";

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

test("isInside accepts the root itself and its descendants", () => {
  assert.equal(isInside(ROOT, ROOT), true);
  assert.equal(isInside(INSIDE, ROOT), true);
});

test("isInside rejects siblings and parents", () => {
  assert.equal(isInside(OUTSIDE, ROOT), false);
  const parent = path.dirname(ROOT);
  assert.equal(isInside(parent, ROOT), false, "the parent directory is outside");
});

test("isInside is not fooled by a name that shares a prefix", () => {
  // "F:\projects\mine-evil" must not count as inside "F:\projects\mine".
  const sibling = `${ROOT}-evil${path.sep}x.txt`;
  assert.equal(isInside(sibling, ROOT), false);
});

// ---------------------------------------------------------------------------
// Scope decisions
// ---------------------------------------------------------------------------

test("an unconfigured scope allows everything (layer is opt-in)", () => {
  const scope = new SessionScope();
  assert.equal(scope.active, false);
  assert.equal(scope.check("read_file", { path: OUTSIDE }).allowed, true);
});

test("an in-scope path is allowed", () => {
  const scope = new SessionScope({ roots: [ROOT] });
  assert.equal(scope.active, true);
  assert.equal(scope.check("read_file", { path: INSIDE }).allowed, true);
});

test("an out-of-scope path is refused and names the offender", () => {
  const scope = new SessionScope({ roots: [ROOT] });
  const decision = scope.check("read_file", { path: OUTSIDE });
  assert.equal(decision.allowed, false);
  assert.equal(decision.offendingPath, OUTSIDE);
  // The reason must be usable by the model, not just a code.
  assert.match(decision.reason, /outside this session's scope/);
  assert.match(decision.reason, /tell the user/i);
});

test("traversal attempts resolve before comparison", () => {
  const scope = new SessionScope({ roots: [ROOT] });
  // "..\..\other\secret.txt" from inside the root escapes it.
  const escape = path.join(ROOT, "..", "..", "other", "secret.txt");
  assert.equal(scope.check("read_file", { path: escape }).allowed, false);
});

test("every path argument of a multi-path tool is checked", () => {
  const scope = new SessionScope({ roots: [ROOT] });
  // compare_files takes two paths; one escaping must block the whole call.
  const decision = scope.check("compare_files", { path_a: INSIDE, path_b: OUTSIDE });
  assert.equal(decision.allowed, false);
  assert.equal(scope.check("compare_files", { path_a: INSIDE, path_b: INSIDE }).allowed, true);
});

test("move_file checks both source and destination", () => {
  const scope = new SessionScope({ roots: [ROOT] });
  assert.equal(scope.check("move_file", { source: INSIDE, destination: OUTSIDE }).allowed, false);
  assert.equal(scope.check("move_file", { source: OUTSIDE, destination: INSIDE }).allowed, false);
  assert.equal(scope.check("move_file", { source: INSIDE, destination: INSIDE }).allowed, true);
});

test("array-valued path arguments are checked element by element", () => {
  const scope = new SessionScope({ roots: [ROOT] });
  assert.equal(scope.check("run_local_workflow", { testFiles: [INSIDE] }).allowed, true);
  assert.equal(scope.check("run_local_workflow", { testFiles: [INSIDE, OUTSIDE] }).allowed, false);
});

test("tools without path arguments pass through", () => {
  const scope = new SessionScope({ roots: [ROOT] });
  for (const name of ["ping", "todo_write", "manage_clients", "web_fetch"]) {
    assert.equal(scope.check(name, {}).allowed, true, name);
  }
});

test("execute_command is blocked while a scope is active", () => {
  const scope = new SessionScope({ roots: [ROOT] });
  const decision = scope.check("execute_command", { command: "dir C:\\", workdir: ROOT });
  // Even with an in-scope workdir: the command itself reaches anywhere.
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /can affect files outside this session's scope/);
  assert.match(decision.reason, /MCP_BRIDGE_SCOPE_ALLOW_EXEC/);
});

test("execute_command can be opted back in explicitly", () => {
  const scope = new SessionScope({ roots: [ROOT], allowUnconfinedTools: true });
  assert.equal(scope.check("execute_command", { command: "npm test", workdir: ROOT }).allowed, true);
});

test("multiple roots are all honoured", () => {
  const other = process.platform === "win32" ? "F:\\projects\\second" : "/projects/second";
  const scope = new SessionScope({ roots: [ROOT, other] });
  assert.equal(scope.check("read_file", { path: INSIDE }).allowed, true);
  assert.equal(scope.check("read_file", { path: path.join(other, "a.txt") }).allowed, true);
  assert.equal(scope.check("read_file", { path: OUTSIDE }).allowed, false);
});

test("describe reports the roots or unrestricted", () => {
  assert.equal(new SessionScope().describe(), "(unrestricted)");
  assert.match(new SessionScope({ roots: [ROOT] }).describe(), /mine/);
});

// ---------------------------------------------------------------------------
// Bridge integration — the scope must block before the server is called
// ---------------------------------------------------------------------------

function fakeMcp() {
  const calls = [];
  return {
    calls,
    async listTools() {
      return [
        { name: "read_file", description: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
        { name: "execute_command", description: "exec", inputSchema: { type: "object", properties: { command: { type: "string" } } } },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "ok" }] };
    },
  };
}

function fakeModel(replies) {
  const seen = [];
  return {
    label: "fake",
    seen,
    async complete(turns) {
      seen.push(turns.map((t) => ({ role: t.role, content: t.content, toolCallId: t.toolCallId })));
      const next = replies.shift();
      if (!next) throw new Error("exhausted");
      return next;
    },
  };
}

test("the bridge refuses an out-of-scope call without reaching the server", async () => {
  const mcp = fakeMcp();
  const model = fakeModel([
    { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: OUTSIDE } }] },
    { text: "I cannot read that.", toolCalls: [] },
  ]);
  const events = [];
  const bridge = new Bridge({
    mcp, model, systemPrompt: "test",
    scope: new SessionScope({ roots: [ROOT] }),
    onEvent: (e) => events.push(e),
  });

  await bridge.send("read the other project's secret");
  // The critical property: the call never left the bridge.
  assert.equal(mcp.calls.length, 0, "out-of-scope call must not reach the server");
  assert.ok(events.some((e) => e.kind === "tool_blocked"));

  const toolTurn = model.seen[1].find((t) => t.role === "tool");
  assert.match(toolTurn.content, /Blocked by session scope/);
});

test("the bridge allows an in-scope call through", async () => {
  const mcp = fakeMcp();
  const model = fakeModel([
    { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: INSIDE } }] },
    { text: "done", toolCalls: [] },
  ]);
  const bridge = new Bridge({
    mcp, model, systemPrompt: "test",
    scope: new SessionScope({ roots: [ROOT] }),
  });

  await bridge.send("read my file");
  assert.equal(mcp.calls.length, 1);
});

test("an inactive scope does not interfere", async () => {
  const mcp = fakeMcp();
  const model = fakeModel([
    { text: "", toolCalls: [{ id: "c1", name: "execute_command", arguments: { command: "echo hi" } }] },
    { text: "done", toolCalls: [] },
  ]);
  const bridge = new Bridge({ mcp, model, systemPrompt: "test" });
  await bridge.send("run echo");
  assert.equal(mcp.calls.length, 1);
});
