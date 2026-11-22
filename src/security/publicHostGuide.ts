/**
 * Interactive setup guide for the public transport hostname.
 *
 * The server only needs `PUBLIC_HOST` so its host/origin allowlists accept
 * requests arriving through a tunnel. Getting that value right is the step
 * operators most often get stuck on, so the guide walks them through it once
 * and writes the answer back to `.env`.
 *
 * Hard rules:
 *   - Never block a non-interactive process. CI, systemd, and `--check` runs
 *     must return immediately with a printed instruction instead of a prompt.
 *   - Never write a secret. Only `PUBLIC_HOST` is persisted.
 *   - Never overwrite an existing value without saying so.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface PublicHostGuideOptions {
  /** Current effective value (may come from the environment). */
  currentHost: string;
  /** Path to the `.env` the operator is expected to edit. */
  envPath: string;
  /** Only write, never prompt. */
  nonInteractive?: boolean;
  /** Injected for tests. */
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  output?: NodeJS.WritableStream;
  ask?: (question: string) => Promise<string>;
}

export interface PublicHostGuideResult {
  /** Effective host after the guide ran (empty when still unconfigured). */
  publicHost: string;
  /** True when the guide wrote `.env`. */
  persisted: boolean;
  /** True when the operator skipped. */
  skipped: boolean;
}

const NGROM_STYLE_HINT = [
  "Two supported options:",
  "",
  "  Cloudflare Tunnel (recommended, free, stable hostname)",
  "    1. cloudflared tunnel create win-mcp",
  "    2. cloudflared tunnel route dns win-mcp mcp.example.com",
  "    3. cloudflared tunnel run --url http://127.0.0.1:3000 win-mcp",
  "    -> PUBLIC_HOST=mcp.example.com",
  "",
  "  ngrok (quick trial, hostname changes unless you pay)",
  "    1. ngrok http 3000 --domain your-name.ngrok-free.app",
  "    -> PUBLIC_HOST=your-name.ngrok-free.app",
  "",
  "Enter the bare hostname only (no scheme, no path, no trailing slash).",
].join("\n");

/** True when the value looks like a bare hostname we can safely persist. */
export function isValidPublicHost(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/[\s/\\]/.test(trimmed)) return false;
  // Reject schemes, paths, ports, and credentials.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  if (trimmed.includes("@") || trimmed.includes(":")) return false;
  if (trimmed.startsWith(".") || trimmed.endsWith(".")) return false;
  // Require a dot so "localhost" style values are not silently accepted as a
  // tunnel hostname; those still work via the built-in local allowlist.
  if (!trimmed.includes(".")) return false;
  return /^[a-z0-9.-]+$/i.test(trimmed);
}

function upsertEnvValue(content: string, key: string, value: string): string {
  const linePattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  const next = `${key}=${value}`;
  if (linePattern.test(content)) return content.replace(linePattern, next);
  const suffix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return `${content}${suffix}${next}\n`;
}

export async function guidePublicHost(
  options: PublicHostGuideOptions,
): Promise<PublicHostGuideResult> {
  const { currentHost, envPath } = options;

  if (options.nonInteractive) {
    if (currentHost) return { publicHost: currentHost, persisted: false, skipped: false };
    process.stdout.write(
      [
        "",
        `PUBLIC_HOST is not configured. External clients will only work on localhost.`,
        NGROM_STYLE_HINT,
        "",
        `Then add it to ${envPath} and restart, or run this server interactively once.`,
        "",
      ].join("\n"),
    );
    return { publicHost: "", persisted: false, skipped: true };
  }

  const output = options.output ?? process.stdout;
  const ask = options.ask ?? createAsk(options.input);

  output.write("\n--- Public hostname setup ---\n");
  if (currentHost) {
    output.write(`Current PUBLIC_HOST: ${currentHost}\n`);
    const keep = (await ask("Keep this value? [Y/n]: ")).trim().toLowerCase();
    if (keep !== "n" && keep !== "no") {
      return { publicHost: currentHost, persisted: false, skipped: false };
    }
  } else {
    output.write("PUBLIC_HOST is not set, so only localhost clients are accepted.\n");
  }

  output.write(`${NGROM_STYLE_HINT}\n\n`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = (await ask("PUBLIC_HOST (empty to skip): ")).trim();
    if (!answer) return { publicHost: currentHost, persisted: false, skipped: true };
    if (!isValidPublicHost(answer)) {
      output.write("That does not look like a bare hostname. Example: mcp.example.com\n");
      continue;
    }
    const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    const updated = upsertEnvValue(existing, "PUBLIC_HOST", answer);
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(envPath, updated, { encoding: "utf8", mode: 0o600 });
    output.write(`Saved PUBLIC_HOST=${answer} to ${envPath}. Restart to apply.\n`);
    return { publicHost: answer, persisted: true, skipped: false };
  }
  output.write("Giving up after three invalid attempts; leaving PUBLIC_HOST unchanged.\n");
  return { publicHost: currentHost, persisted: false, skipped: true };
}

function createAsk(
  input: NodeJS.ReadableStream = process.stdin,
): (question: string) => Promise<string> {
  const rl = readline.createInterface({ input, terminal: false });
  const queue: string[] = [];
  const waiters: ((value: string) => void)[] = [];
  let closed = false;

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()?.("");
  });

  return (question: string) => {
    process.stdout.write(question);
    if (queue.length > 0) return Promise.resolve(queue.shift() as string);
    if (closed) return Promise.resolve("");
    return new Promise<string>((resolve) => waiters.push(resolve));
  };
}

/** Non-interactive detection: prompts must never stall a service start. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && process.env.WINMCP_NONINTERACTIVE !== "1";
}
