/**
 * Test support: obtain a working client credential from a running server.
 *
 * Clients are per-pairing now, so a test cannot read a key off disk — only its
 * digest is persisted. Instead the helper redeems the pairing code the server
 * printed at startup, exactly as a real client would.
 *
 * The code is parsed from captured stdout; fixtures that keep their output in
 * memory pass it directly.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const CODE_RE = /One-time code:\s+([0-9A-Z]{4}-[0-9A-Z]{4})/;

/** Extract the pairing code from captured server output. */
export function pairCodeFromOutput(output) {
  const text = Array.isArray(output) ? output.join("") : String(output);
  const match = text.match(CODE_RE);
  return match ? match[1] : undefined;
}

/** Redeem a pairing code for a fresh client key. */
export async function redeemPairCode(baseUrl, code, label) {
  const response = await fetch(`${baseUrl}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(label ? { code, label } : { code }),
  });
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`pairing failed: ${payload.error ?? JSON.stringify(payload)}`);
  }
  return payload;
}

/** Poll for the printed pairing code, then redeem it. */
export async function pairClient(baseUrl, output, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let code;
  while (Date.now() < deadline) {
    code = pairCodeFromOutput(output);
    if (code) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!code) throw new Error("pairing code never appeared in server output");
  return redeemPairCode(baseUrl, code, label);
}

/** Read the paired-client list (needs an admin credential). */
export async function listClients(baseUrl, adminKey) {
  const response = await fetch(`${baseUrl}/clients`, {
    headers: { authorization: `Bearer ${adminKey}` },
  });
  return response.json();
}

export function bearer(clientKey) {
  return { authorization: `Bearer ${clientKey}` };
}

/**
 * Legacy shim: read the persisted registry and report how many clients exist.
 * Keys are not recoverable from disk, so callers must pair to get one.
 */
export async function readPairedClientCount(approvalDataDir) {
  try {
    const raw = await readFile(path.join(approvalDataDir, "clients.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.clients) ? parsed.clients.length : 0;
  } catch {
    return 0;
  }
}
