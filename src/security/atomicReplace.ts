/**
 * Windows-safe atomic file replacement.
 *
 * `rename(2)` over an existing file is not reliably atomic on Windows: if any
 * process holds the target open without `FILE_SHARE_DELETE` — including a
 * concurrent reader in the same process, an antivirus scanner, or the search
 * indexer — the rename fails with `EPERM`/`EBUSY`/`EACCES` instead of waiting.
 * The failure is transient: it disappears once the other handle closes.
 *
 * A bare `renameSync` therefore turns an ordinary read/write race into a hard
 * task failure. Task metadata, heartbeats, and approval stores are all written
 * this way while other processes poll them, which is exactly that race.
 *
 * Retrying a bounded number of times with a short backoff converts the
 * transient sharing violation back into the success the caller expects. Only
 * the specific Windows sharing codes are retried, so genuine permission errors
 * still surface immediately.
 */

import fs from "node:fs";

/** Windows sharing-violation codes; POSIX rename never produces these. */
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface AtomicReplaceOptions {
  /** Total attempts, including the first. */
  attempts?: number;
  /** Delay before the second attempt; doubled afterwards. */
  baseDelayMs?: number;
  /** Upper bound for a single backoff, keeping the blocking wait short. */
  maxDelayMs?: number;
  /** Test hooks. */
  rename?: (source: string, destination: string) => void;
  sleep?: (ms: number) => void;
}

/**
 * Sleep synchronously. Atomic writes are deliberately synchronous (the store
 * is read on the same tick by callers that hold no async context), so the
 * backoff must block rather than return a promise.
 */
function blockingSleep(ms: number): void {
  if (!(ms > 0)) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function isTransient(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * Rename `source` onto `destination`, retrying transient sharing violations.
 *
 * The default budget (about five seconds of bounded blocking, never more than
 * 400ms in a single wait) covers measured conflicts, which are tens to
 * hundreds of milliseconds when a scanner or a peer process holds the target.
 *
 * Throws the final error unchanged when every attempt fails, so callers keep
 * their existing error handling and messages.
 */
export function renameWithRetry(
  source: string,
  destination: string,
  options: AtomicReplaceOptions = {},
): void {
  const attempts = Math.max(1, options.attempts ?? 40);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 25);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 400);
  const rename = options.rename ?? ((from, to) => fs.renameSync(from, to));
  const sleep = options.sleep ?? blockingSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransient(error) || attempt === attempts) break;
      sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
