/**
 * One-time pairing codes and the long-lived client key.
 *
 * Two different secrets with two different lifetimes:
 *
 *   client key  — generated once on first start, persisted, never rotated.
 *                 Clients send it as a Bearer token and store it permanently,
 *                 so operators configure a client exactly once.
 *   pair code   — short, human-typable, single use, minutes-long. It exists
 *                 only so the client key never has to be typed by hand.
 *
 * The key file is 0600 under the protected approval data directory. It is
 * never logged, never returned by `/health`, and never written to the repo.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { renameWithRetry } from "./atomicReplace.js";

/** Crockford-style alphabet: no I, L, O, U, so codes are unambiguous. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_GROUPS = 2;
const CODE_GROUP_LEN = 4;

export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const PAIR_CODE_MAX_ATTEMPTS = 5;
const PAIR_CODE_LOCKOUT_MS = 5 * 60_000;

export interface PairingOptions {
  /** Attempts allowed per code before it is discarded. */
  maxAttempts?: number;
  /** Lifetime of a freshly issued code. */
  ttlMs?: number;
  now?: () => number;
}

export interface PairAttemptResult {
  ok: boolean;
  /** Populated only on success. */
  clientKey?: string;
  reason?: "no_code" | "expired" | "mismatch" | "locked_out";
}

function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** Render the canonical grouped form used for display, e.g. K7M3-PX9Q. */
export function formatPairCode(raw: string): string {
  const clean = normalizeCode(raw);
  const groups: string[] = [];
  for (let index = 0; index < clean.length; index += CODE_GROUP_LEN) {
    groups.push(clean.slice(index, index + CODE_GROUP_LEN));
  }
  return groups.join("-");
}

function generateCode(): string {
  let code = "";
  for (let index = 0; index < CODE_GROUPS * CODE_GROUP_LEN; index += 1) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Persisted client key.
 *
 * Creation is `wx` (exclusive): if two processes race on first start, one wins
 * and the other reads the winner's key instead of silently replacing it. That
 * matters because a replaced key would invalidate every already-paired client.
 */
export class ClientKeyStore {
  readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(path.resolve(dataDir), "client-key.json");
  }

  /** Read the existing key without creating one. */
  read(): string | undefined {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: number; clientKey?: unknown };
      if (parsed?.version !== 1 || typeof parsed.clientKey !== "string") return undefined;
      return parsed.clientKey.length >= 32 ? parsed.clientKey : undefined;
    } catch {
      return undefined;
    }
  }

  /** Return the persisted key, generating and persisting one on first use. */
  ensure(): { clientKey: string; created: boolean } {
    const existing = this.read();
    if (existing) return { clientKey: existing, created: false };

    const clientKey = randomBytes(32).toString("hex");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = path.join(
      path.dirname(this.filePath),
      `.client-key-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify({ version: 1, clientKey }, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      renameWithRetry(temporary, this.filePath);
      try { fs.chmodSync(this.filePath, 0o600); } catch {}
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      // Lost the creation race: adopt whatever the winner persisted.
      const winner = this.read();
      if (winner) return { clientKey: winner, created: false };
      throw error;
    }
    return { clientKey, created: true };
  }

  /** True when the candidate matches the persisted key. */
  matches(candidate: string | undefined | null): boolean {
    if (!candidate) return false;
    const expected = this.read();
    if (!expected) return false;
    return constantTimeEquals(candidate, expected);

  }
}

/**
 * In-memory one-time pairing codes.
 *
 * Deliberately not persisted: a code that survives a restart would let a stale
 * code be redeemed after the operator believed it was consumed. Restarting the
 * server invalidates outstanding codes, which is the safer failure mode.
 */
export class PairingCodeRegistry {
  private readonly options: Required<PairingOptions>;
  private current:
    | { code: string; issuedAt: number; attempts: number; consumed: boolean }
    | undefined;
  private lockedUntil = 0;

  constructor(options: PairingOptions = {}) {
    this.options = {
      maxAttempts: options.maxAttempts ?? PAIR_CODE_MAX_ATTEMPTS,
      ttlMs: options.ttlMs ?? PAIR_CODE_TTL_MS,
      now: options.now ?? (() => Date.now()),
    };
  }

  /** Issue a fresh code, replacing any outstanding one. */
  issue(): { code: string; display: string; expiresAt: string } {
    const code = generateCode();
    const now = this.options.now();
    this.current = { code, issuedAt: now, attempts: 0, consumed: false };
    this.lockedUntil = 0;
    return {
      code,
      display: formatPairCode(code),
      expiresAt: new Date(now + this.options.ttlMs).toISOString(),
    };
  }

  /** Describe the outstanding code without revealing it. */
  status(): { pending: boolean; expiresAt?: string; lockedOut: boolean } {
    const now = this.options.now();
    const lockedOut = now < this.lockedUntil;
    if (!this.current || this.current.consumed) return { pending: false, lockedOut };
    if (now - this.current.issuedAt >= this.options.ttlMs) return { pending: false, lockedOut };
    return {
      pending: true,
      expiresAt: new Date(this.current.issuedAt + this.options.ttlMs).toISOString(),
      lockedOut,
    };
  }

  /**
   * Redeem a code.
   *
   * A code is discarded after `maxAttempts` mismatches, so an attacker guessing
   * online cannot extend their budget, and every failure costs a full code
   * rotation rather than a slow brute force.
   *
   * `clientKey` is optional and only echoed back for callers that mint keys
   * themselves; the registry does not decide what credential a client gets.
   */
  redeem(input: string, clientKey?: string): PairAttemptResult {
    const now = this.options.now();
    if (now < this.lockedUntil) return { ok: false, reason: "locked_out" };

    const state = this.current;
    if (!state || state.consumed) return { ok: false, reason: "no_code" };
    if (now - state.issuedAt >= this.options.ttlMs) {
      this.current = undefined;
      return { ok: false, reason: "expired" };
    }

    const candidate = normalizeCode(input);
    if (!constantTimeEquals(candidate, state.code)) {
      state.attempts += 1;
      if (state.attempts >= this.options.maxAttempts) {
        this.current = undefined;
        this.lockedUntil = now + PAIR_CODE_LOCKOUT_MS;
        return { ok: false, reason: "locked_out" };
      }
      return { ok: false, reason: "mismatch" };
    }

    state.consumed = true;
    this.current = undefined;
    return clientKey === undefined ? { ok: true } : { ok: true, clientKey };
  }

  /** Discard any outstanding code (used by the rotation endpoint). */
  clear(): void {
    this.current = undefined;
    this.lockedUntil = 0;
  }
}

// ---------------------------------------------------------------------------
// Per-client registry (revocable)
// ---------------------------------------------------------------------------

export interface PairedClient {
  id: string;
  /** Operator-supplied or auto-generated label, shown by list/revoke. */
  label: string;
  /** SHA-256 of the client key. The key itself is never persisted. */
  keyHash: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface ClientRegistryFile {
  version: 2;
  clients: PairedClient[];
}

export interface ClientRegistryOptions {
  /** Refresh `lastUsedAt` at most this often, to avoid a write per request. */
  lastUsedThrottleMs?: number;
  now?: () => number;
}

export interface PairedClientSummary {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

const DEFAULT_LAST_USED_THROTTLE_MS = 60_000;

function hashKey(clientKey: string): string {
  return createHash("sha256").update(clientKey, "utf8").digest("hex");
}

/**
 * Registry of paired clients, each with an independently revocable key.
 *
 * Keys are stored only as SHA-256 digests: the registry file is a durable
 * secret-adjacent artifact, and hashing means a copy of it cannot be replayed
 * as a credential. Revoking one client leaves the others working, which is the
 * whole point of tracking them individually.
 */
export class ClientRegistry {
  readonly filePath: string;
  private readonly lastUsedThrottleMs: number;
  private readonly now: () => number;
  private clients: PairedClient[] = [];
  private readonly lastWrite = new Map<string, number>();

  constructor(dataDir: string, options: ClientRegistryOptions = {}) {
    this.filePath = path.join(path.resolve(dataDir), "clients.json");
    this.lastUsedThrottleMs = options.lastUsedThrottleMs ?? DEFAULT_LAST_USED_THROTTLE_MS;
    this.now = options.now ?? (() => Date.now());
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ClientRegistryFile>;
      if (parsed?.version !== 2 || !Array.isArray(parsed.clients)) return;
      this.clients = parsed.clients.filter((entry): entry is PairedClient =>
        Boolean(
          entry &&
          typeof entry.id === "string" &&
          typeof entry.label === "string" &&
          typeof entry.keyHash === "string" &&
          entry.keyHash.length === 64 &&
          typeof entry.createdAt === "string",
        ),
      );
    } catch {
      // Missing or corrupt registry starts empty. A corrupt file is not proof of
      // a valid pairing, so failing closed here is correct.
      this.clients = [];
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data: ClientRegistryFile = { version: 2, clients: this.clients };
    const temporary = path.join(dir, `.clients-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      renameWithRetry(temporary, this.filePath);
      try { fs.chmodSync(this.filePath, 0o600); } catch {}
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }

  /** Mint a new client and return its plaintext key (the only time it exists). */
  create(label?: string): { client: PairedClientSummary; clientKey: string } {
    const clientKey = randomBytes(32).toString("hex");
    const cleanLabel = (label ?? "").trim().slice(0, 64);
    const client: PairedClient = {
      id: randomUUID(),
      label: cleanLabel || `client-${this.clients.length + 1}`,
      keyHash: hashKey(clientKey),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.clients.push(client);
    this.persist();
    return { client: this.summarize(client), clientKey };
  }

  /** True when the candidate matches a non-revoked client; refreshes lastUsedAt. */
  matches(candidate: string | undefined | null): boolean {
    if (!candidate) return false;
    const candidateHash = hashKey(candidate);
    let hit: PairedClient | undefined;
    let sameLength = false;
    for (const client of this.clients) {
      if (client.keyHash.length !== candidateHash.length) continue;
      sameLength = true;
      // Compare digests in constant time for every entry so timing does not
      // reveal which client matched, or how many are registered.
      if (constantTimeEquals(candidateHash, client.keyHash)) hit = client;
    }
    if (!sameLength) return false;
    if (!hit) return false;
    this.touch(hit);
    return true;
  }

  private touch(client: PairedClient): void {
    const now = this.now();
    const previous = this.lastWrite.get(client.id) ?? 0;
    if (now - previous < this.lastUsedThrottleMs) return;
    this.lastWrite.set(client.id, now);
    client.lastUsedAt = new Date(now).toISOString();
    try {
      this.persist();
    } catch {
      // Usage bookkeeping must never fail a request.
    }
  }

  list(): PairedClientSummary[] {
    return [...this.clients]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((client) => this.summarize(client));
  }

  /** Revoke by id or label. Returns the revoked client, or undefined. */
  revoke(identifier: string): PairedClientSummary | undefined {
    const needle = identifier.trim();
    if (!needle) return undefined;
    const index = this.clients.findIndex(
      (client) => client.id === needle || client.label === needle,
    );
    if (index < 0) return undefined;
    const [removed] = this.clients.splice(index, 1);
    this.lastWrite.delete(removed.id);
    this.persist();
    return this.summarize(removed);
  }

  /** Revoke every client (used by "start over" and tests). */
  revokeAll(): number {
    const count = this.clients.length;
    this.clients = [];
    this.lastWrite.clear();
    this.persist();
    return count;
  }

  count(): number {
    return this.clients.length;
  }

  private summarize(client: PairedClient): PairedClientSummary {
    return {
      id: client.id,
      label: client.label,
      createdAt: client.createdAt,
      ...(client.lastUsedAt ? { lastUsedAt: client.lastUsedAt } : {}),
    };
  }
}
