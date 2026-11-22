/**
 * Terminal approval prompt for the bridge.
 *
 * win_mcp fronts every write, command, and path grant with an approval form
 * that a browser or chat client would render. A plain API bridge has no such
 * surface, so this module draws the form in the terminal instead — the user
 * sees exactly what the model asked for and answers on their own keyboard,
 * which keeps the same trust boundary the Feishu client has.
 *
 * Declining is always available; when stdin is not a terminal the default is to
 * deny rather than to hang or to grant silently.
 */

import readline from "node:readline";
import type { ApprovalPrompt, McpInputRequest } from "./mcpClient.js";

export interface TerminalApprovalOptions {
  /** Where prompts are written. */
  output?: NodeJS.WritableStream;
  input?: NodeJS.ReadableStream & { isTTY?: boolean };
  /**
   * Pre-decide every prompt. Intended for automated runs (CI, scripted batch):
   *   "allow_once" / "allow_session" / "allow_permanent" / "deny"
   */
  always?: string;
  /** Answer without a terminal: grants are refused. */
  nonInteractive?: boolean;
}

const DECISION_LABELS: Record<string, string> = {
  allow_once: "Allow once",
  allow_session: "Allow for this session",
  allow_permanent: "Always allow",
  deny: "Deny",
};

function firstInputRequest(request: McpInputRequest): {
  key: string;
  message: string;
  choices: string[];
} {
  const entries = Object.entries(request.inputRequests ?? {});
  // win_mcp names its approval request "approval"; fall back to the first one.
  const [key, value] = entries.find(([name]) => name === "approval") ?? entries[0] ?? ["approval", {}];
  const schema = (value as McpInputRequest["inputRequests"][string])?.params?.requestedSchema;
  const decisionProp = schema?.properties?.decision;
  const choices = Array.isArray(decisionProp?.enum)
    ? decisionProp.enum.map(String)
    : ["allow_once", "deny"];
  const message = (value as McpInputRequest["inputRequests"][string])?.params?.message
    ?? "This operation requires approval.";
  return { key, message, choices };
}

/**
 * Render an approval request as readable text.
 *
 * The server's message already contains "Target:" and "Risk:" lines, so it is
 * passed through rather than reformatted.
 */
export function renderApproval(request: McpInputRequest): string {
  const { message, choices } = firstInputRequest(request);
  const lines = [
    "",
    "  \u2500\u2500 approval required \u2500\u2500",
    ...message.split("\n").map((line) => `  ${line}`),
    "",
  ];
  choices.forEach((choice, index) => {
    lines.push(`  [${index + 1}] ${DECISION_LABELS[choice] ?? choice}`);
  });
  lines.push("");
  return lines.join("\n");
}

/** Map a typed answer ("1", "allow_once", "y", "n") to a decision value. */
export function resolveChoice(input: string, choices: string[]): string | undefined {
  const raw = input.trim().toLowerCase();
  if (raw === "") return undefined;
  const asIndex = Number.parseInt(raw, 10);
  if (Number.isFinite(asIndex) && asIndex >= 1 && asIndex <= choices.length) {
    return choices[asIndex - 1];
  }
  const direct = choices.find((choice) => choice.toLowerCase() === raw);
  if (direct) return direct;
  // Convenience aliases.
  if (raw === "y" || raw === "yes") return choices[0];
  if (raw === "n" || raw === "no") {
    return choices.includes("deny") ? "deny" : choices[choices.length - 1];
  }
  return undefined;
}

/** Build a prompt function for McpClient. */
export function createTerminalApproval(
  options: TerminalApprovalOptions = {},
): ApprovalPrompt {
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;

  return async (request: McpInputRequest) => {
    const { key, choices } = firstInputRequest(request);

    // A fixed decision skips the terminal entirely; useful for scripted runs.
    if (options.always) {
      const resolved = resolveChoice(options.always, choices);
      if (!resolved) return undefined;
      output.write(renderApproval(request).replace(/\n/g, "\n"));
      output.write(`  auto-answer: ${resolved}\n\n`);
      return { [key]: { action: "accept", content: { decision: resolved } } };
    }

    if (options.nonInteractive || input.isTTY !== true) {
      output.write(renderApproval(request));
      output.write("  (no terminal available; denying this operation)\n\n");
      return { [key]: { action: "accept", content: { decision: "deny" } } };
    }

    output.write(renderApproval(request));
    const rl = readline.createInterface({ input, output, terminal: true });
    try {
      for (;;) {
        const answer = await new Promise<string>((resolve) => rl.question("  choose> ", resolve));
        const decision = resolveChoice(answer, choices);
        if (decision) {
          output.write(`  \u2192 ${DECISION_LABELS[decision] ?? decision}\n\n`);
          return { [key]: { action: "accept", content: { decision } } };
        }
        // An empty answer is a deliberate decline, not a typo.
        if (answer.trim() === "") {
          output.write("  \u2192 denied (empty answer)\n\n");
          return { [key]: { action: "accept", content: { decision: "deny" } } };
        }
        output.write(`  not a valid choice; enter 1-${choices.length}\n`);
      }
    } finally {
      rl.close();
    }
  };
}
