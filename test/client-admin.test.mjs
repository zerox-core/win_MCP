import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.AUTH_MODE = "none";
process.env.APPROVAL_STATE_SECRET = "client-admin-test-secret-0123456789ab";
process.env.OWNER_USER_ID = "owner";
process.env.LOG_LEVEL = "error";

const { ClientRegistry, PairingCodeRegistry } = await import(
  "../dist/security/clientPairing.js"
);
const { createManageClientsTool } = await import("../dist/tools/clientAdmin.js");

function parse(result) {
  return JSON.parse(result.content[0].text);
}

async function withRegistry(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "client-admin-"));
  try {
    const clients = new ClientRegistry(dir);
    const pairing = new PairingCodeRegistry();
    const manage = createManageClientsTool({
      clients,
      pairingStatus: () => pairing.status(),
    });
    await run({ clients, pairing, manage });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("list reports paired clients and pairing state", async () => {
  await withRegistry(async ({ clients, pairing, manage }) => {
    clients.create("laptop");
    clients.create("phone");
    pairing.issue();

    const body = parse(await manage({ action: "list" }));
    assert.equal(body.ok, true);
    assert.equal(body.pairedClients, 2);
    assert.deepEqual(body.clients.map((client) => client.label), ["laptop", "phone"]);
    assert.equal(body.pairing.pending, true);
    // The list must never expose key material.
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("keyHash"), false);
    assert.equal(serialized.includes("clientKey"), false);
  });
});

test("revoke by label stops only that client", async () => {
  await withRegistry(async ({ clients, manage }) => {
    const laptop = clients.create("laptop");
    const phone = clients.create("phone");

    const body = parse(await manage({ action: "revoke", label: "laptop" }));
    assert.equal(body.ok, true);
    assert.equal(body.revoked.label, "laptop");
    assert.equal(body.remaining, 1);
    assert.equal(clients.matches(laptop.clientKey), false);
    assert.equal(clients.matches(phone.clientKey), true);
  });
});

test("revoke by id works too", async () => {
  await withRegistry(async ({ clients, manage }) => {
    const created = clients.create("by-id");
    const body = parse(await manage({ action: "revoke", id: created.client.id }));
    assert.equal(body.ok, true);
    assert.equal(body.revoked.id, created.client.id);
    assert.equal(clients.matches(created.clientKey), false);
  });
});

test("revoking an unknown client returns candidates instead of a bare failure", async () => {
  await withRegistry(async ({ clients, manage }) => {
    clients.create("laptop");
    const result = await manage({ action: "revoke", label: "typo" });
    const body = parse(result);
    assert.equal(body.ok, false);
    assert.equal(body.code, "CLIENT_NOT_FOUND");
    // The available labels make the error actionable.
    assert.deepEqual(body.clients.map((client) => client.label), ["laptop"]);
  });
});

test("revoke without an identifier is rejected", async () => {
  await withRegistry(async ({ clients, manage }) => {
    clients.create("only");
    const body = parse(await manage({ action: "revoke" }));
    assert.equal(body.ok, false);
    assert.equal(body.code, "INVALID_ARGUMENT");
    assert.equal(clients.count(), 1);
  });
});

test("revoke_all clears every client and says so", async () => {
  await withRegistry(async ({ clients, manage }) => {
    const a = clients.create("a");
    const b = clients.create("b");
    const body = parse(await manage({ action: "revoke_all" }));
    assert.equal(body.ok, true);
    assert.equal(body.removed, 2);
    assert.match(body.note, /pair again/i);
    assert.equal(clients.matches(a.clientKey), false);
    assert.equal(clients.matches(b.clientKey), false);
    assert.equal(clients.count(), 0);
  });
});

test("revoke_all on an empty registry is a harmless no-op", async () => {
  await withRegistry(async ({ manage }) => {
    const body = parse(await manage({ action: "revoke_all" }));
    assert.equal(body.ok, true);
    assert.equal(body.removed, 0);
  });
});
