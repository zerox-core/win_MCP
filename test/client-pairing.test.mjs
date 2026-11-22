import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.APPROVAL_STATE_SECRET = "client-pairing-test-secret-0123456789";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const { ClientRegistry, PairingCodeRegistry, formatPairCode } = await import(
  "../dist/security/clientPairing.js"
);
const { isValidPublicHost, guidePublicHost } = await import(
  "../dist/security/publicHostGuide.js"
);

// ---------------------------------------------------------------------------
// Client registry (per-client, revocable)
// ---------------------------------------------------------------------------

test("registry mints a distinct client per pairing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-"));
  try {
    const registry = new ClientRegistry(dir);
    const first = registry.create("laptop");
    const second = registry.create("phone");
    assert.notEqual(first.clientKey, second.clientKey);
    assert.notEqual(first.client.id, second.client.id);
    assert.equal(registry.count(), 2);
    assert.deepEqual(
      registry.list().map((client) => client.label),
      ["laptop", "phone"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only hashes are persisted, never the key itself", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-hash-"));
  try {
    const registry = new ClientRegistry(dir);
    const { clientKey } = registry.create("hashed");
    const raw = fs.readFileSync(registry.filePath, "utf8");
    assert.equal(raw.includes(clientKey), false, "plaintext key must not be stored");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.clients[0].keyHash.length, 64);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a client key survives a new registry instance (restart)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-restart-"));
  try {
    const first = new ClientRegistry(dir);
    const created = first.create("persisted");
    const reopened = new ClientRegistry(dir);
    assert.equal(reopened.matches(created.clientKey), true);
    assert.equal(reopened.count(), 1);
    assert.equal(reopened.list()[0].label, "persisted");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revoking one client leaves the others working", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-revoke-"));
  try {
    const registry = new ClientRegistry(dir);
    const laptop = registry.create("laptop");
    const phone = registry.create("phone");

    const revoked = registry.revoke("laptop");
    assert.equal(revoked?.label, "laptop");

    assert.equal(registry.matches(laptop.clientKey), false, "revoked key must stop working");
    assert.equal(registry.matches(phone.clientKey), true, "other client must keep working");
    assert.equal(registry.count(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revocation works by id as well as label", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-id-"));
  try {
    const registry = new ClientRegistry(dir);
    const created = registry.create("by-id");
    assert.equal(registry.revoke(created.client.id)?.id, created.client.id);
    assert.equal(registry.matches(created.clientKey), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revoking an unknown client reports nothing revoked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-missing-"));
  try {
    const registry = new ClientRegistry(dir);
    registry.create("only");
    assert.equal(registry.revoke("nope"), undefined);
    assert.equal(registry.count(), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revocation persists across a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-revoke-persist-"));
  try {
    const registry = new ClientRegistry(dir);
    const created = registry.create("gone");
    registry.revoke("gone");
    const reopened = new ClientRegistry(dir);
    assert.equal(reopened.matches(created.clientKey), false);
    assert.equal(reopened.count(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown and malformed keys never match", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-reject-"));
  try {
    const registry = new ClientRegistry(dir);
    registry.create("real");
    assert.equal(registry.matches(""), false);
    assert.equal(registry.matches(undefined), false);
    assert.equal(registry.matches("f".repeat(64)), false);
    assert.equal(registry.matches("short"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lastUsedAt is recorded but throttled", () => {
  let now = 1_700_000_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-touch-"));
  try {
    const registry = new ClientRegistry(dir, {
      now: () => now,
      lastUsedThrottleMs: 1_000,
    });
    const created = registry.create("touched");
    assert.equal(created.client.lastUsedAt, undefined);

    assert.equal(registry.matches(created.clientKey), true);
    const firstUse = registry.list()[0].lastUsedAt;
    assert.ok(firstUse, "first use must be recorded");

    // Within the throttle window the timestamp must not move.
    now += 500;
    registry.matches(created.clientKey);
    assert.equal(registry.list()[0].lastUsedAt, firstUse);

    // Past the window it advances.
    now += 600;
    registry.matches(created.clientKey);
    assert.notEqual(registry.list()[0].lastUsedAt, firstUse);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt registry file fails closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-corrupt-"));
  try {
    const registry = new ClientRegistry(dir);
    const created = registry.create("before-corruption");
    fs.writeFileSync(registry.filePath, "{ not json", "utf8");

    const reopened = new ClientRegistry(dir);
    assert.equal(reopened.count(), 0);
    assert.equal(reopened.matches(created.clientKey), false, "corrupt store must not authorize");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("revokeAll clears every client and persists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "client-registry-all-"));
  try {
    const registry = new ClientRegistry(dir);
    const a = registry.create("a");
    const b = registry.create("b");
    assert.equal(registry.revokeAll(), 2);
    assert.equal(registry.count(), 0);
    assert.equal(registry.matches(a.clientKey), false);
    assert.equal(registry.matches(b.clientKey), false);

    const reopened = new ClientRegistry(dir);
    assert.equal(reopened.count(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pairing codes
// ---------------------------------------------------------------------------

test("a fresh code redeems once and returns the client key", () => {
  const registry = new PairingCodeRegistry();
  const issued = registry.issue();
  const first = registry.redeem(issued.code, "key-material");
  assert.equal(first.ok, true);
  assert.equal(first.clientKey, "key-material");

  // Single use: the same code must not work twice.
  const second = registry.redeem(issued.code, "key-material");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "no_code");
});

test("codes ignore grouping and case so operators can retype them", () => {
  const registry = new PairingCodeRegistry();
  const issued = registry.issue();
  const messy = ` ${issued.display.toLowerCase()} `;
  assert.equal(registry.redeem(messy, "key").ok, true);
});

test("an expired code is rejected", () => {
  let now = 1_000_000;
  const registry = new PairingCodeRegistry({ ttlMs: 1_000, now: () => now });
  const issued = registry.issue();
  now += 1_001;
  const outcome = registry.redeem(issued.code, "key");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "expired");
});

test("wrong guesses exhaust the code and then lock out", () => {
  const registry = new PairingCodeRegistry({ maxAttempts: 3 });
  registry.issue();
  assert.equal(registry.redeem("00000000", "key").reason, "mismatch");
  assert.equal(registry.redeem("00000000", "key").reason, "mismatch");
  const third = registry.redeem("00000000", "key");
  assert.equal(third.ok, false);
  assert.equal(third.reason, "locked_out");
  // Even the real code is refused while locked out.
  assert.equal(registry.redeem("00000000", "key").reason, "locked_out");
});

test("issuing a new code invalidates the previous one", () => {
  const registry = new PairingCodeRegistry();
  const first = registry.issue();
  registry.issue();
  assert.equal(registry.redeem(first.code, "key").ok, false);
});

test("status reports pending state without revealing the code", () => {
  const registry = new PairingCodeRegistry();
  assert.equal(registry.status().pending, false);
  const issued = registry.issue();
  const status = registry.status();
  assert.equal(status.pending, true);
  assert.equal(JSON.stringify(status).includes(issued.code), false);
});

test("formatPairCode groups digits and strips separators", () => {
  assert.equal(formatPairCode("k7m3px9q"), "K7M3-PX9Q");
  assert.equal(formatPairCode("K7M3-PX9Q"), "K7M3-PX9Q");
  assert.equal(formatPairCode("k7m3 px9q"), "K7M3-PX9Q");
});

// ---------------------------------------------------------------------------
// Public host validation and guidance
// ---------------------------------------------------------------------------

test("isValidPublicHost accepts bare hostnames only", () => {
  for (const good of ["mcp.example.com", "a-b.example.co.uk", "example.com"]) {
    assert.equal(isValidPublicHost(good), true, good);
  }
  for (const bad of [
    "",
    "localhost",
    "http://example.com",
    "example.com/path",
    "example.com:3000",
    "user@example.com",
    ".example.com",
    "example.com.",
    "exa mple.com",
    "exam_ple.com",
  ]) {
    assert.equal(isValidPublicHost(bad), false, bad);
  }
});

test("guide persists a valid host into .env", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "host-guide-"));
  try {
    const envPath = path.join(dir, ".env");
    await writeFile(envPath, "AUTH_MODE=pin\n", "utf8");
    const answers = ["mcp.example.com"];
    const result = await guidePublicHost({
      currentHost: "",
      envPath,
      output: { write() { return true; } },
      ask: async () => answers.shift() ?? "",
    });
    assert.equal(result.persisted, true);
    assert.equal(result.publicHost, "mcp.example.com");
    const content = await readFile(envPath, "utf8");
    assert.match(content, /^PUBLIC_HOST=mcp\.example\.com$/m);
    // Pre-existing settings must survive.
    assert.match(content, /^AUTH_MODE=pin$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("guide replaces an existing PUBLIC_HOST instead of duplicating it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "host-guide-replace-"));
  try {
    const envPath = path.join(dir, ".env");
    await writeFile(envPath, "PUBLIC_HOST=old.example.com\n", "utf8");
    await guidePublicHost({
      currentHost: "old.example.com",
      envPath,
      output: { write() { return true; } },
      // First answer declines keeping the current value, second supplies a new one.
      ask: (() => {
        const answers = ["n", "new.example.com"];
        return async () => answers.shift() ?? "";
      })(),
    });
    const content = await readFile(envPath, "utf8");
    assert.equal((content.match(/^PUBLIC_HOST=/gm) ?? []).length, 1);
    assert.match(content, /^PUBLIC_HOST=new\.example\.com$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-interactive guidance never prompts and writes nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "host-guide-noninteractive-"));
  try {
    const envPath = path.join(dir, ".env");
    await writeFile(envPath, "AUTH_MODE=pin\n", "utf8");
    const result = await guidePublicHost({
      currentHost: "",
      envPath,
      nonInteractive: true,
      ask: async () => {
        throw new Error("must not prompt when non-interactive");
      },
    });
    assert.equal(result.skipped, true);
    assert.equal(result.persisted, false);
    const content = await readFile(envPath, "utf8");
    assert.doesNotMatch(content, /PUBLIC_HOST/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("guide rejects invalid input and skips on empty answer", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "host-guide-invalid-"));
  try {
    const envPath = path.join(dir, ".env");
    const result = await guidePublicHost({
      currentHost: "",
      envPath,
      output: { write() { return true; } },
      ask: (() => {
        const answers = ["http://bad.example.com", ""];
        return async () => answers.shift() ?? "";
      })(),
    });
    assert.equal(result.skipped, true);
    assert.equal(result.persisted, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
