/**
 * Live proof that the session scope actually contains a model that has been
 * steered toward a sibling directory.
 *
 * Setup: the server is configured with a BROAD allowed root covering two
 * project folders, which is the realistic case. A scripted model then tries to
 * read from the wrong one. The scope must refuse it before the server sees it —
 * this is the whole point of the layer, since ALLOWED_DIRS alone would allow it.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..");
const { McpClient } = await import("../dist/bridge/mcpClient.js");
const { Bridge } = await import("../dist/bridge/bridge.js");
const { SessionScope } = await import("../dist/bridge/scope.js");
const { pairClient } = await import("./support/clientKey.mjs");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const root = await mkdtemp(path.join(os.tmpdir(), "scope-live-"));
// Two sibling project folders under one broad allowed root.
const broad = path.join(root, "projects");
const mine = path.join(broad, "mine");
const other = path.join(broad, "other-client");
const approvals = path.join(root, "approvals");
await mkdir(mine, { recursive: true });
await mkdir(other, { recursive: true });
await writeFile(path.join(mine, "mine.txt"), "my own notes", "utf8");
await writeFile(path.join(other, "secret.txt"), "another client's secret", "utf8");

const port = await freePort();
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    // Deliberately broad: this is what makes the scope layer necessary.
    ALLOWED_DIRS: broad,
    APPROVAL_DATA_DIR: approvals,
    LOG_DIR: path.join(root, "logs"),
    MCP_AUTH_TOKEN: "",
    AUTH_MODE: "none",
    AUTH_PIN: "",
    OWNER_USER_ID: "owner",
    APPROVAL_STATE_SECRET: "scope-live-secret-0123456789abcdef01",
    NGROK_DOMAIN: "",
    WINMCP_NONINTERACTIVE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const out = [];
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (c) => out.push(c));
server.stderr.on("data", (c) => out.push(c));

function fail(message) {
  console.error("FAIL:", message);
  console.error("server output:", out.join("").slice(-600));
  process.exitCode = 1;
}

try {
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try { if ((await fetch(`${base}/health`)).ok) ready = true; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!ready) fail("server never became ready");
  else {
    const paired = await pairClient(base, out, "scope-live");
    const mcp = new McpClient({
      url: `${base}/mcp`,
      token: paired.clientKey,
      approvalPrompt: async () => ({
        approval: { action: "accept", content: { decision: "allow_once" } },
      }),
    });

    // 1. Without the scope, the sibling directory IS reachable — proving that
    //    ALLOWED_DIRS alone would not have stopped a steered model.
    const broadRead = await mcp.callTool("read_file", { path: path.join(other, "secret.txt") });
    const broadText = McpClient.resultToText(broadRead);
    console.log("=== baseline (no scope) ===");
    console.log("read sibling file:", broadText.slice(0, 60));
    if (broadRead.isError) fail("baseline read should succeed, else the test proves nothing");

    // 2. With the scope, the same call is refused before it reaches the server.
    const scope = new SessionScope({ roots: [mine] });
    let turn = 0;
    const model = {
      label: "scripted",
      async complete() {
        turn += 1;
        if (turn === 1) {
          return {
            text: "",
            toolCalls: [{ id: "c1", name: "read_file", arguments: { path: path.join(other, "secret.txt") } }],
          };
        }
        return { text: "I could not access that directory.", toolCalls: [] };
      },
    };
    const events = [];
    const bridge = new Bridge({
      mcp, model, systemPrompt: "test", scope,
      onEvent: (e) => events.push(e),
    });

    const result = await bridge.send("read the other client's secret file");
    console.log("\n=== with scope ===");
    console.log("final:", result.text);
    const blocked = events.filter((e) => e.kind === "tool_blocked");
    console.log("blocked events:", blocked.length);
    if (blocked.length !== 1) fail("expected exactly one blocked call");

    const toolTurn = result.turns.find((t) => t.role === "tool");
    if (!/Blocked by session scope/.test(toolTurn?.content ?? "")) {
      fail("model was not told why the call failed");
    }
    // The secret must not appear anywhere in what the model received.
    if (JSON.stringify(result.turns).includes("another client's secret")) {
      fail("the secret leaked into the model context");
    }

    // 3. execute_command is blocked too, since its reach cannot be verified.
    const execScope = new SessionScope({ roots: [mine] });
    if (execScope.check("execute_command", { command: "type ..\\other-client\\secret.txt" }).allowed) {
      fail("execute_command should be blocked while scoped");
    }

    // 4. In-scope work still functions.
    const insideRead = await mcp.callTool("read_file", { path: path.join(mine, "mine.txt") });
    if (insideRead.isError) fail("in-scope read must still work");

    if (process.exitCode !== 1) console.log("\nall scope checks passed");
  }
} finally {
  await stop(server);
  await rm(root, { recursive: true, force: true });
}
