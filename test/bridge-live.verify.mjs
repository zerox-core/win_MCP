/**
 * Live verification of the bridge CLI against a real server and a stub model
 * API. Proves the whole path a user takes: pair -> run CLI -> tool executes.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..");

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

const root = await mkdtemp(path.join(os.tmpdir(), "bridge-live-"));
const workspace = path.join(root, "workspace");
const approvals = path.join(root, "approvals");
const serverPort = await freePort();
const modelPort = await freePort();

// ---------------------------------------------------------------------------
// Stub OpenAI-compatible model: first asks for write_file, then reports done.
// ---------------------------------------------------------------------------
let modelTurn = 0;
const modelSeen = [];
const modelServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = JSON.parse(raw || "{}");
    modelSeen.push(body);
    modelTurn += 1;
    const reply = modelTurn === 1
      ? {
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: {
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: path.join(workspace, "from-model.txt"),
                    content: "written by the stub model through the bridge",
                  }),
                },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }
      : {
          choices: [{
            message: { content: "Done — the file was created.", tool_calls: [] },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 150, completion_tokens: 10 },
        };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
});
await new Promise((resolve) => modelServer.listen(modelPort, "127.0.0.1", resolve));

// ---------------------------------------------------------------------------
// Real win_mcp server
// ---------------------------------------------------------------------------
const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: projectDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(serverPort),
    ALLOWED_DIRS: workspace,
    APPROVAL_DATA_DIR: approvals,
    LOG_DIR: path.join(root, "logs"),
    MCP_AUTH_TOKEN: "",
    AUTH_MODE: "none",
    AUTH_PIN: "",
    OWNER_USER_ID: "owner",
    APPROVAL_STATE_SECRET: "bridge-live-secret-0123456789abcdef01",
    NGROK_DOMAIN: "",
    WINMCP_NONINTERACTIVE: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const serverOut = [];
server.stdout.setEncoding("utf8");
server.stderr.setEncoding("utf8");
server.stdout.on("data", (c) => serverOut.push(c));
server.stderr.on("data", (c) => serverOut.push(c));

function fail(message) {
  console.error("FAIL:", message);
  console.error("server output:", serverOut.join("").slice(-800));
  process.exitCode = 1;
}

try {
  const base = `http://127.0.0.1:${serverPort}`;
  const deadline = Date.now() + 15_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    try { if ((await fetch(`${base}/health`)).ok) ready = true; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!ready) { fail("server never became ready"); }
  else {
    const codeMatch = serverOut.join("").match(/One-time code:\s+([0-9A-Z]{4}-[0-9A-Z]{4})/);
    if (!codeMatch) { fail("pairing code not printed"); }
    else {
      const paired = await (await fetch(`${base}/pair`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: codeMatch[1], label: "bridge-live" }),
      })).json();
      if (!paired.ok) { fail(`pairing failed: ${JSON.stringify(paired)}`); }
      else {
        // Run the real CLI exactly as a user would.
        const cli = spawn(process.execPath, ["dist/bridge/cli.js", "create a file"], {
          cwd: projectDir,
          env: {
            ...process.env,
            MCP_BRIDGE_URL: `${base}/mcp`,
            MCP_BRIDGE_TOKEN: paired.clientKey,
            MCP_BRIDGE_PROVIDER: "openai",
            MCP_BRIDGE_MODEL: "stub-model",
            MCP_BRIDGE_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
            MCP_BRIDGE_API_KEY: "stub-key",
            MCP_BRIDGE_APPROVE: "allow_once",
            MCP_BRIDGE_VERBOSE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const cliOut = [];
        cli.stdout.setEncoding("utf8");
        cli.stderr.setEncoding("utf8");
        cli.stdout.on("data", (c) => cliOut.push(c));
        cli.stderr.on("data", (c) => cliOut.push(c));
        const exitCode = await new Promise((resolve) => cli.once("exit", resolve));
        const transcript = cliOut.join("");

        console.log("--- bridge transcript ---");
        console.log(transcript.trim());
        console.log("--- assertions ---");

        const target = path.join(workspace, "from-model.txt");
        let written;
        try { written = await readFile(target, "utf8"); } catch { written = undefined; }

        if (exitCode !== 0) fail(`CLI exited ${exitCode}`);
        if (!transcript.includes("Done — the file was created.")) fail("final answer missing");
        if (!transcript.includes("write_file")) fail("tool call not shown");
        // The whole point: a stub API made the real server write a real file.
        if (written !== "written by the stub model through the bridge") {
          fail(`file content wrong: ${JSON.stringify(written)}`);
        }
        // The tool list must have been sent to the model, or it could not call.
        const sentTools = modelSeen[0]?.tools;
        if (!Array.isArray(sentTools) || sentTools.length !== 43) {
          fail(`model received ${sentTools?.length} tools, expected 43`);
        }
        // oneOf must not survive into the payload; hosted APIs reject it.
        if (JSON.stringify(sentTools).includes('"oneOf"')) {
          fail("oneOf leaked into the model payload");
        }
        if (process.exitCode !== 1) console.log("all live checks passed");
      }
    }
  }
} finally {
  await stop(server);
  await new Promise((resolve) => modelServer.close(resolve));
  await rm(root, { recursive: true, force: true });
}
