/**
 * Test helper: read the persisted client key and produce auth headers.
 *
 * `/health` returns liveness only unless the caller presents a credential, so
 * tests that assert on the full diagnostics body must authenticate. The key is
 * created on first server start under APPROVAL_DATA_DIR.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readClientKey(approvalDataDir) {
  const raw = await readFile(path.join(approvalDataDir, "client-key.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.clientKey !== "string" || parsed.clientKey.length < 32) {
    throw new Error("client key missing from store");
  }
  return parsed.clientKey;
}

/** Poll until the key file exists (the server writes it during startup). */
export async function waitForClientKey(approvalDataDir, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readClientKey(approvalDataDir);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`client key never appeared: ${lastError?.message}`);
}

export function bearer(clientKey) {
  return { authorization: `Bearer ${clientKey}` };
}
