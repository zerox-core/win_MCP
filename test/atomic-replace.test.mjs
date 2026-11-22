import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.APPROVAL_STATE_SECRET = "atomic-replace-test-secret-0123456789";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const { renameWithRetry } = await import("../dist/security/atomicReplace.js");

function sharingViolation() {
  const error = new Error("EPERM: operation not permitted, rename");
  error.code = "EPERM";
  return error;
}

test("renameWithRetry succeeds when a transient sharing violation clears", () => {
  const waits = [];
  let attempts = 0;
  renameWithRetry("source", "target", {
    rename() {
      attempts += 1;
      if (attempts < 4) throw sharingViolation();
    },
    sleep: (ms) => waits.push(ms),
  });
  assert.equal(attempts, 4);
  // Backoff must grow and stay bounded.
  assert.deepEqual(waits, [25, 50, 100]);
});

test("renameWithRetry gives up after the attempt budget and rethrows the original error", () => {
  let attempts = 0;
  let thrown;
  try {
    renameWithRetry("source", "target", {
      attempts: 3,
      rename() {
        attempts += 1;
        throw sharingViolation();
      },
      sleep: () => {},
    });
  } catch (error) {
    thrown = error;
  }
  assert.equal(attempts, 3);
  assert.equal(thrown?.code, "EPERM");
});

test("renameWithRetry does not retry non-transient errors", () => {
  for (const code of ["ENOENT", "ENOTDIR", "EXDEV", "EINVAL"]) {
    let attempts = 0;
    const error = new Error(`${code}: nope`);
    error.code = code;
    assert.throws(
      () => renameWithRetry("source", "target", {
        rename() { attempts += 1; throw error; },
        sleep: () => { throw new Error("must not sleep"); },
      }),
      (thrown) => thrown === error,
    );
    assert.equal(attempts, 1, `${code} must fail fast`);
  }
});

test("renameWithRetry retries EBUSY and EACCES as well as EPERM", () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    let attempts = 0;
    const error = new Error(`${code}: locked`);
    error.code = code;
    renameWithRetry("source", "target", {
      rename() {
        attempts += 1;
        if (attempts < 3) throw error;
      },
      sleep: () => {},
    });
    assert.equal(attempts, 3, `${code} must be retried`);
  }
});

test("renameWithRetry waits are bounded by maxDelayMs", () => {
  const waits = [];
  let attempts = 0;
  renameWithRetry("source", "target", {
    attempts: 8,
    baseDelayMs: 100,
    maxDelayMs: 250,
    rename() {
      attempts += 1;
      if (attempts < 8) throw sharingViolation();
    },
    sleep: (ms) => waits.push(ms),
  });
  assert.deepEqual(waits, [100, 200, 250, 250, 250, 250, 250]);
});

test("renameWithRetry replaces an existing target on the real filesystem", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "atomic-replace-"));
  try {
    const target = path.join(root, "metadata.json");
    const temporary = path.join(root, ".metadata.tmp");
    await writeFile(target, "old", "utf8");
    await writeFile(temporary, "new", "utf8");
    renameWithRetry(temporary, target);
    assert.equal(await readFile(target, "utf8"), "new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("development task metadata survives a contended rename", async () => {
  const { DevelopmentTaskStore } = await import("../dist/development/tasks/store.js");
  const { developmentOwnerKey } = await import("../dist/development/tasks/coordinator.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "atomic-store-"));
  try {
    const store = new DevelopmentTaskStore(root);
    const ownerKey = developmentOwnerKey("owner");
    const record = store.create({
      ownerKey,
      tool: "windows_development",
      action: "contended",
      class: "default",
      resources: ["project:contended"],
    });
    // Two rapid transitions exercise the same replace path a worker and the
    // coordinator contend on.
    store.update(record.id, "queued", { state: "running" });
    const updated = store.update(record.id, "running", { state: "succeeded", endedAt: new Date().toISOString() });
    assert.equal(updated.state, "succeeded");
    assert.equal(store.get(record.id)?.state, "succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

