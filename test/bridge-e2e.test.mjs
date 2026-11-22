/**
 * End-to-end bridge verification against a real win_mcp server.
 *
 * Uses a scripted fake model (no API key, no network) so the test proves the
 * bridge really reaches the server and executes tools, which is the part unit
 * tests with a fake MCP cannot cover.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

const { McpClient } = await import("../dist/bridge/mcpClient.js");
const { Bridge } = await import("../dist/bridge/bridge.js");
const { pairClient } = await import("./support/clientKey.mjs");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

/** A model that plays a fixed script, so no external API is involved. */
function scriptedModel(replies) {
  return {
    label: "scripted",
    calls: 0,
    async complete() {
      const next = replies[this.calls];
      this.calls += 1;
      if (!next) throw new Error("scripted model exhausted");
      return next;
    },
  };
}

test("bridge drives a real server: pairs, reads a file, reports back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-e2e-"));
  const workspace = path.join(root, "workspace");
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ALLOWED_DIRS: workspace,
      APPROVAL_DATA_DIR: path.join(root, "approvals"),
      LOG_DIR: path.join(root, "logs"),
      MCP_AUTH_TOKEN: "",
      AUTH_MODE: "none",
      AUTH_PIN: "",
      OWNER_USER_ID: "owner",
      APPROVAL_STATE_SECRET: "bridge-e2e-secret-0123456789abcdef0123",
      NGROK_DOMAIN: "",
      WINMCP_NONINTERACTIVE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const paired = await pairClient(baseUrl, output, "bridge-test");
    const clientKey = paired.clientKey;

    // Approvals are auto-granted so the test can exercise a real write without
    // a terminal. The prompt path itself is covered by bridge-approval tests.
    const mcp = new McpClient({
      url: `${baseUrl}/mcp`,
      token: clientKey,
      approvalPrompt: async () => ({
        approval: { action: "accept", content: { decision: "allow_once" } },
      }),
    });
    const tools = await mcp.listTools();
    assert.equal(tools.length, 43, "bridge must see the whole inventory");

    const write = await mcp.callTool("write_file", {
      path: path.join(workspace, "hello.txt"),
      content: "hello from the bridge e2e test",
    });
    assert.equal(Boolean(write.isError), false, JSON.stringify(write));

    // Now let the scripted model ask for a read and summarise it.
    const model = scriptedModel([
      { text: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: path.join(workspace, "hello.txt") } }] },
      { text: "The file contains a greeting.", toolCalls: [] },
    ]);
    const bridge = new Bridge({ mcp, model, systemPrompt: "test" });
    const result = await bridge.send("what is in hello.txt?");

    assert.equal(result.text, "The file contains a greeting.");
    assert.equal(result.toolCallCount, 1);
    assert.equal(result.stopped, "complete");
    // The tool result actually made it back into the conversation.
    const toolTurn = result.turns.find((t) => t.role === "tool");
    assert.match(toolTurn.content, /hello from the bridge e2e test/);
  } finally {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});

test("bridge surfaces a wrong token as an actionable 401", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-401-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ALLOWED_DIRS: root,
      APPROVAL_DATA_DIR: path.join(root, "approvals"),
      LOG_DIR: path.join(root, "logs"),
      MCP_AUTH_TOKEN: "required-token-for-this-test-0123456789",
      AUTH_MODE: "none",
      AUTH_PIN: "",
      OWNER_USER_ID: "owner",
      APPROVAL_STATE_SECRET: "bridge-401-secret-0123456789abcdef01234",
      NGROK_DOMAIN: "",
      WINMCP_NONINTERACTIVE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));

  try {
    const deadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) ready = true;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, `server did not start: ${output.join("")}`);

    const mcp = new McpClient({ url: `http://127.0.0.1:${port}/mcp`, token: "wrong-token" });
    await assert.rejects(
      () => mcp.listTools(),
      (error) => {
        assert.equal(error.status, 401);
        // The hint is what makes this fixable without reading the source.
        assert.match(error.message, /pair a client/i);
        return true;
      },
    );
  } finally {
    await stop(child);
    await rm(root, { recursive: true, force: true });
  }
});
