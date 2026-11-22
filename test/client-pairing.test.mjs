import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.APPROVAL_STATE_SECRET = "client-pairing-test-secret-0123456789";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const { ClientKeyStore, PairingCodeRegistry, formatPairCode } = await import(
  "../dist/security/clientPairing.js"
);
const { isValidPublicHost, guidePublicHost } = await import(
  "../dist/security/publicHostGuide.js"
);

// ---------------------------------------------------------------------------
// Client key
// ---------------------------------------------------------------------------

test("client key is created once and reused across stores", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "client-key-"));
  try {
    const first = new ClientKeyStore(dir).ensure();
    assert.equal(first.created, true);
    assert.equal(first.clientKey.length, 64);

    // A second store over the same directory (a restart) must reuse the key.
    const second = new ClientKeyStore(dir).ensure();
    assert.equal(second.created, false);
    assert.equal(second.clientKey, first.clientKey);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("client key file is owner-only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "client-key-mode-"));
  try {
    const store = new ClientKeyStore(dir);
    store.ensure();
    // Windows does not report POSIX modes; only assert where they are meaningful.
    if (process.platform !== "win32") {
      const info = await stat(store.filePath);
      assert.equal(info.mode & 0o077, 0, "key file must not be group/world readable");
    }
    const raw = await readFile(store.filePath, "utf8");
    assert.equal(JSON.parse(raw).version, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("client key matching is exact", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "client-key-match-"));
  try {
    const store = new ClientKeyStore(dir);
    const { clientKey } = store.ensure();
    assert.equal(store.matches(clientKey), true);
    assert.equal(store.matches(clientKey.slice(0, -1)), false);
    assert.equal(store.matches(`${clientKey}x`), false);
    assert.equal(store.matches(""), false);
    assert.equal(store.matches(undefined), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("corrupt key file is not treated as a valid key", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "client-key-corrupt-"));
  try {
    const store = new ClientKeyStore(dir);
    await writeFile(store.filePath, "{ not json", "utf8");
    assert.equal(store.read(), undefined);
    assert.equal(store.matches("anything"), false);
    // ensure() must recover by minting a usable key rather than staying broken.
    const recovered = store.ensure();
    assert.equal(recovered.clientKey.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
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
