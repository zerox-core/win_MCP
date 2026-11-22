/**
 * MCP tool for managing paired clients.
 *
 * Pairing happens over HTTP (`POST /pair`) because the client has no
 * credential yet. Managing clients is different: it needs an authenticated
 * owner, and doing it from chat is far more convenient than curling the
 * admin endpoints from a terminal.
 *
 * Operations:
 *   list    — show paired clients (id, label, timestamps)
 *   revoke  — revoke one client by id or label
 *   revoke_all — revoke every client
 *
 * Revocation is owner-only: it can disconnect other clients, which is a
 * destructive administrative action and must not be available to any
 * authenticated identity.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { authorizeOwnerToolCall } from "../security/toolAccess.js";
import type { ClientRegistry } from "../security/clientPairing.js";
import { logger } from "../security/logger.js";
import { toolError, toolJson } from "./results.js";

export interface PairingCodeSummary {
  code: string;
  display: string;
  expiresAt: string;
}

export interface ClientAdminOptions {
  clients: ClientRegistry;
  /** Counts pending pairing codes so the user can see if a code is live. */
  pairingStatus: () => { pending: boolean; expiresAt?: string; lockedOut: boolean };
  /** Issues a fresh one-time code, replacing any outstanding one. */
  issueCode: () => PairingCodeSummary;
  /** Absolute base URL used to print a copyable pairing command. */
  publicBaseUrl: () => string;
}

export function createManageClientsTool(options: ClientAdminOptions) {
  const { clients, pairingStatus, issueCode, publicBaseUrl } = options;

  return async function manageClients(
    args: { action: "list" | "revoke" | "revoke_all" | "issue_code"; id?: string; label?: string },
  ) {
    if (args.action === "list") {
      const status = pairingStatus();
      return toolJson({
        ok: true,
        pairedClients: clients.count(),
        clients: clients.list(),
        pairing: {
          pending: status.pending,
          expiresAt: status.expiresAt ?? null,
          lockedOut: status.lockedOut,
        },
        hint: "Each client has its own key and can be revoked independently.",
      });
    }

    if (args.action === "issue_code") {
      // Issuing a code is how a new client is onboarded without restarting the
      // server. The previous code (if any) stops working immediately. Query the
      // prior state first — after issuing, a code is always pending.
      const previousCodeExisted = pairingStatus().pending;
      const issued = issueCode();
      logger.info("pairing_code_issued_via_tool", { expiresAt: issued.expiresAt });
      return toolJson({
        ok: true,
        code: issued.display,
        expiresAt: issued.expiresAt,
        pairEndpoint: `${publicBaseUrl()}/pair`,
        pairCommand: `curl -X POST ${publicBaseUrl()}/pair -H "Content-Type: application/json" -d '{"code":"${issued.display}"}'`,
        previousCodeReplaced: previousCodeExisted,
        note:
          "Single use and short lived. Enter it once in the new client to bind it. " +
          "Already-paired clients are unaffected.",
      });
    }

    if (args.action === "revoke_all") {
      const removed = clients.revokeAll();
      logger.warn("client_revoked_all_via_tool", { removed });
      if (removed === 0) {
        return toolJson({ ok: true, removed: 0, note: "No paired clients to revoke." });
      }
      return toolJson({
        ok: true,
        removed,
        note: "All clients revoked. Every client must pair again using a new one-time code.",
      });
    }

    const identifier = args.id ?? args.label;
    if (!identifier || !identifier.trim()) {
      return toolError("INVALID_ARGUMENT", "Provide either id or label to revoke.");
    }

    const revoked = clients.revoke(identifier);
    if (!revoked) {
      // Listing the current clients makes the failure actionable instead of
      // forcing the user to guess what spelling to use.
      return toolError(
        "CLIENT_NOT_FOUND",
        `No paired client matches "${identifier}".`,
        false,
        { clients: clients.list().map((client) => ({ id: client.id, label: client.label })) },
      );
    }

    logger.warn("client_revoked_via_tool", { clientId: revoked.id, label: revoked.label });
    return toolJson({
      ok: true,
      revoked,
      remaining: clients.count(),
      note: "This client's key stopped working immediately; other clients are unaffected.",
    });
  };
}

export function registerClientAdminTool(
  server: McpServer,
  options: ClientAdminOptions,
): void {
  const manageClients = createManageClientsTool(options);

  server.registerTool("manage_clients", {
    description:
      "Manage paired MCP clients. `issue_code` prints a one-time pairing code so a new client can " +
      "bind without restarting the server; `list` shows paired clients; `revoke` disconnects one " +
      "(others keep working); `revoke_all` disconnects all. Owner-only.",
    inputSchema: {
      action: z.enum(["list", "revoke", "revoke_all", "issue_code"]),
      id: z.string().trim().min(1).max(64).optional()
        .describe("Client id from action=list. Use this or label."),
      label: z.string().trim().min(1).max(64).optional()
        .describe("Client label from action=list. Use this or id."),
    },
  }, async (args) =>
    authorizeOwnerToolCall("manage_clients", args) ?? manageClients(args));
}
