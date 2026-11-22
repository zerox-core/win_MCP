#!/usr/bin/env node
/**
 * win-mcp bridge CLI.
 *
 * Two modes:
 *   one-shot   a single instruction, then exit — for scripting and quick tests
 *   repl       interactive; keeps conversation context across messages
 *
 * Configuration comes from environment variables so nothing sensitive is
 * passed on the command line (where it would land in shell history):
 *
 *   MCP_BRIDGE_URL        MCP endpoint, e.g. https://mcp.example.com/mcp
 *   MCP_BRIDGE_TOKEN      paired client key (or MCP_AUTH_TOKEN)
 *   MCP_BRIDGE_PROVIDER   openai | deepseek | openai-compatible | anthropic
 *   MCP_BRIDGE_MODEL      model id, e.g. deepseek-chat
 *   MCP_BRIDGE_BASE_URL   provider base URL (defaults per provider)
 *   MCP_BRIDGE_API_KEY    provider API key
 *   MCP_BRIDGE_MAX_TURNS  optional model round-trip cap (default 24)
 */

import process from "node:process";
import readline from "node:readline";
import { McpClient, McpTransportError } from "./mcpClient.js";
import { Bridge, buildSystemPrompt, type BridgeEvent } from "./bridge.js";
import { createModelClient } from "./model.js";
import { createTerminalApproval } from "./approval.js";
import { SessionScope } from "./scope.js";

interface CliConfig {
  url: string;
  token?: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTurns?: number;
  verbose: boolean;
  /** ask | allow_once | allow_session | allow_permanent | deny | off */
  approve: string;
  /** Directories this run may touch; empty means no extra confinement. */
  scopeRoots: string[];
  /** Permit execute_command even though its effects escape the scope. */
  allowUnconfined: boolean;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  anthropic: "https://api.anthropic.com",
};

const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  anthropic: "claude-sonnet-4-20250514",
};

class UsageError extends Error {}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

export function readConfig(argv: string[]): { config: CliConfig; instructions: string[] } {
  const url = env("MCP_BRIDGE_URL");
  if (!url) {
    throw new UsageError(
      "MCP_BRIDGE_URL is required, e.g. http://127.0.0.1:3000/mcp\n" +
      "Set it in your shell or in a .env file next to the bridge.",
    );
  }

  const provider = env("MCP_BRIDGE_PROVIDER") ?? "deepseek";
  const model = env("MCP_BRIDGE_MODEL") ?? DEFAULT_MODELS[provider];
  if (!model) {
    throw new UsageError(`MCP_BRIDGE_MODEL is required for provider "${provider}"`);
  }

  const baseUrl = env("MCP_BRIDGE_BASE_URL") ?? DEFAULT_BASE_URLS[provider];
  if (!baseUrl) {
    throw new UsageError(
      `MCP_BRIDGE_BASE_URL is required for provider "${provider}"`,
    );
  }

  const apiKey = env("MCP_BRIDGE_API_KEY");
  if (!apiKey) {
    throw new UsageError("MCP_BRIDGE_API_KEY is required");
  }

  const maxTurnsRaw = env("MCP_BRIDGE_MAX_TURNS");
  const maxTurns = maxTurnsRaw ? Number.parseInt(maxTurnsRaw, 10) : undefined;
  if (maxTurnsRaw && (!Number.isFinite(maxTurns) || (maxTurns as number) <= 0)) {
    throw new UsageError("MCP_BRIDGE_MAX_TURNS must be a positive integer");
  }

  const approve = (env("MCP_BRIDGE_APPROVE") ?? "ask").toLowerCase();
  const approvalModes = ["ask", "allow_once", "allow_session", "allow_permanent", "deny", "off"];
  if (!approvalModes.includes(approve)) {
    throw new UsageError(
      `MCP_BRIDGE_APPROVE must be one of: ${approvalModes.join(", ")}`,
    );
  }

  // Comma- or semicolon-separated so Windows paths with drive letters stay
  // readable (a colon separator would collide with "F:\").
  const scopeRaw = env("MCP_BRIDGE_SCOPE");
  const scopeRoots = scopeRaw
    ? scopeRaw.split(/[;,]/).map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];

  return {
    config: {
      url,
      token: env("MCP_BRIDGE_TOKEN"),
      provider,
      model,
      baseUrl,
      apiKey,
      maxTurns,
      verbose: process.env.MCP_BRIDGE_VERBOSE === "1",
      approve,
      scopeRoots,
      allowUnconfined: process.env.MCP_BRIDGE_SCOPE_ALLOW_EXEC === "1",
    },
    instructions: argv,
  };
}

function makeEventPrinter(verbose: boolean) {
  return (event: BridgeEvent): void => {
    switch (event.kind) {
      case "tool_call":
        process.stdout.write(
          `  \u2192 ${event.name}(${summarizeArgs(event.arguments)})\n`,
        );
        break;
      case "tool_result":
        if (event.isError) {
          process.stdout.write(`    \u2717 ${firstLine(event.text)}\n`);
        } else if (verbose) {
          process.stdout.write(`    \u2713 ${firstLine(event.text)}\n`);
        } else {
          process.stdout.write("    \u2713\n");
        }
        break;
      case "tool_blocked":
        process.stdout.write(`    \u2298 blocked by session scope\n`);
        if (verbose) process.stdout.write(`      ${firstLine(event.reason)}\n`);
        break;
      case "limit":
        process.stdout.write(`\n[stopped: ${event.reason}]\n`);
        break;
      case "usage":
        if (verbose && (event.inputTokens || event.outputTokens)) {
          process.stdout.write(
            `    [tokens in=${event.inputTokens ?? "?"} out=${event.outputTokens ?? "?"}]\n`,
          );
        }
        break;
      case "assistant_text":
        break;
    }
  };
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => {
      const rendered = typeof value === "string"
        ? value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`
        : JSON.stringify(value);
      return `${key}=${rendered}`;
    })
    .join(", ")
    .slice(0, 160);
}

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim() !== "") ?? "";
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

function usage(): string {
  return [
    "win-mcp bridge",
    "",
    "Usage:",
    "  node dist/bridge/cli.js \"list the files in my project\"   one-shot",
    "  node dist/bridge/cli.js                                    interactive",
    "",
    "Required environment:",
    "  MCP_BRIDGE_URL        http(s)://host/mcp",
    "  MCP_BRIDGE_API_KEY    hosted model API key",
    "",
    "Optional:",
    "  MCP_BRIDGE_TOKEN      paired client key (omit if the server has auth off)",
    "  MCP_BRIDGE_PROVIDER   openai | deepseek | openai-compatible | anthropic (default deepseek)",
    "  MCP_BRIDGE_MODEL      model id",
    "  MCP_BRIDGE_BASE_URL   provider base URL",
    "  MCP_BRIDGE_MAX_TURNS  model round-trip cap per message (default 24)",
    "  MCP_BRIDGE_APPROVE    ask (default) | allow_once | allow_session |",
    "                        allow_permanent | deny | off",
    "                        `ask` prompts in the terminal for every write/command;",
    "                        `off` leaves approvals to the server's own policy",
    "  MCP_BRIDGE_VERBOSE    set to 1 for token and result detail",
    "  MCP_BRIDGE_SCOPE      comma-separated directories this run may touch;",
    "                        any tool call outside them is refused before reaching",
    "                        the server. Example: MCP_BRIDGE_SCOPE=F:\\proj\\a,F:\\proj\\b",
    "  MCP_BRIDGE_SCOPE_ALLOW_EXEC",
    "                        set to 1 to allow execute_command while a scope is",
    "                        active (its effects cannot be verified against it)",
  ].join("\n");
}

async function main(): Promise<void> {
  let config: CliConfig;
  let instructions: string[];
  try {
    ({ config, instructions } = readConfig(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`\n${error.message}\n\n${usage()}\n`);
      process.exit(2);
    }
    throw error;
  }

  // Wire the approval path before creating the client: without it the server
  // refuses every write and command as "client cannot display a form".
  const approvalPrompt = config.approve === "off"
    ? undefined
    : createTerminalApproval({
        always: config.approve === "ask" ? undefined : config.approve,
        nonInteractive: config.approve === "ask" && !process.stdin.isTTY,
      });

  const mcp = new McpClient({ url: config.url, token: config.token, approvalPrompt });
  const model = createModelClient(config.provider, {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });

  const scope = new SessionScope({
    roots: config.scopeRoots,
    allowUnconfinedTools: config.allowUnconfined,
  });

  const bridge = new Bridge({
    mcp,
    model,
    systemPrompt: buildSystemPrompt({
      hostDescription: `reachable through the win_mcp MCP server at ${config.url}`,
      extraInstructions: scope.active
        ? `This session is confined to: ${scope.scopeRoots.join(", ")}. ` +
          "Paths outside those directories will be refused; do not try variations."
        : undefined,
    }),
    maxTurns: config.maxTurns,
    scope,
    onEvent: makeEventPrinter(config.verbose),
  });

  // Fail fast with an actionable message rather than a stack trace from the
  // first model turn.
  try {
    const tools = await bridge.prepare();
    process.stderr.write(
      `win-mcp bridge \u2014 ${tools.length} tools \u2014 model ${model.label}\n` +
      `MCP: ${config.url}\n` +
      `Scope: ${scope.describe()}` +
      (scope.active && !config.allowUnconfined ? " (execute_command blocked)" : "") +
      "\n\n",
    );
  } catch (error) {
    const message = error instanceof McpTransportError
      ? error.message
      : (error as Error).message;
    process.stderr.write(
      `\ncannot reach the MCP server: ${message}\n\n` +
      "Checklist:\n" +
      `  1. Is the server running and is ${config.url} correct?\n` +
      "  2. If it is remote, is the tunnel up?\n" +
      "  3. 401 means the token is wrong \u2014 pair a client and use its clientKey.\n\n",
    );
    process.exit(1);
  }

  const prompt = instructions.join(" ").trim();
  if (prompt) {
    const result = await bridge.send(prompt);
    process.stdout.write(`\n${result.text}\n`);
    if (result.stopped !== "complete") {
      process.stderr.write(`\n[stopped early: ${result.stopped}]\n`);
    }
    return;
  }

  await runRepl(bridge);
}

async function runRepl(bridge: Bridge): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
  });
  let history: Awaited<ReturnType<Bridge["send"]>>["turns"] = [];
  let closed = false;
  rl.once("close", () => { closed = true; });

  // Resolve on close as well as on a line, otherwise Ctrl-D leaves the loop
  // awaiting a promise that never settles.
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      if (closed) {
        resolve("/exit");
        return;
      }
      rl.question(question, resolve);
    });

  process.stderr.write("Type an instruction. /exit to quit, /reset to clear context.\n\n");

  while (!closed) {
    const line = (await ask("you> ")).trim();
    if (line === "") continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") {
      history = [];
      process.stderr.write("(context cleared)\n");
      continue;
    }

    try {
      const result = await bridge.send(line, history);
      history = [...history, ...result.turns];
      process.stdout.write(`\n${result.text}\n\n`);
      if (result.stopped !== "complete") {
        process.stderr.write(`[stopped early: ${result.stopped}]\n`);
      }
    } catch (error) {
      process.stderr.write(`\nerror: ${(error as Error).message}\n\n`);
    }
  }
  rl.close();
}

// Only run when invoked directly, so tests can import the helpers.
const invokedDirectly = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href
  : false;

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`\nfatal: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
