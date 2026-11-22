/**
 * Pairing and client-management HTTP routes.
 *
 *   POST /pair               redeem a one-time code, mint a client key
 *   GET  /pair/status        whether an unexpired code is outstanding
 *   GET  /clients            list paired clients (authenticated)
 *   POST /clients/revoke     revoke one client by id or label (authenticated)
 *
 * The /pair endpoints are unauthenticated by design: the code *is* the
 * credential being exchanged, and requiring an existing credential would
 * defeat the point. The /clients endpoints are authenticated, because listing
 * or revoking clients is an administrative action.
 */

import type { Express, Request, Response } from "express";
import { logger } from "../security/logger.js";
import type { ClientRegistry, PairingCodeRegistry } from "../security/clientPairing.js";
import { extractToken, isAuthorizedToken } from "../security/auth.js";

export interface PairingRoutesOptions {
  app: Express;
  registry: PairingCodeRegistry;
  clients: ClientRegistry;
  /** Absolute public base URL used to print a copyable pairing hint. */
  publicBaseUrl: () => string;
}

const MAX_BODY_BYTES = 512;

function bodyOf(req: Request): Record<string, unknown> {
  const raw = req.body;
  if (!raw || typeof raw !== "object") return {};
  return raw as Record<string, unknown>;
}

export function registerPairingRoutes(options: PairingRoutesOptions): void {
  const { app, registry, clients, publicBaseUrl } = options;

  const requireAdmin = (req: Request, res: Response): boolean => {
    if (isAuthorizedToken(extractToken(req.headers.authorization))) return true;
    logger.warn("client_admin_unauthenticated", { ip: req.ip });
    res.status(401).json({ ok: false, error: "authentication required" });
    return false;
  };

  app.post("/pair", (req: Request, res: Response) => {
    const body = bodyOf(req);
    const code = body.code;
    if (typeof code !== "string" || code.length === 0 || code.length > MAX_BODY_BYTES) {
      res.status(400).json({ ok: false, error: "code is required" });
      return;
    }
    const rawLabel = body.label;
    const label = typeof rawLabel === "string" ? rawLabel : undefined;

    const outcome = registry.redeem(code);
    if (!outcome.ok) {
      // One generic message: distinguishing "expired" from "wrong" would let a
      // caller confirm a partial guess.
      logger.warn("client_pairing_failed", { reason: outcome.reason });
      const status = outcome.reason === "locked_out" ? 429 : 401;
      res.status(status).json({
        ok: false,
        error: "pairing code is not valid",
        hint: "restart the server to print a fresh pairing code",
      });
      return;
    }

    // Each redemption mints a distinct client, so revoking one leaves the
    // others working.
    const created = clients.create(label);
    logger.info("client_paired", { clientId: created.client.id, label: created.client.label });
    res.json({
      ok: true,
      clientKey: created.clientKey,
      client: created.client,
      tokenType: "Bearer",
      usage: "Authorization: Bearer <clientKey>",
      mcpEndpoint: `${publicBaseUrl()}/mcp`,
      note: "Store this key in the client. It does not change across restarts.",
    });
  });

  app.get("/pair/status", (_req: Request, res: Response) => {
    const status = registry.status();
    res.json({
      ok: true,
      pairingPending: status.pending,
      expiresAt: status.expiresAt ?? null,
      lockedOut: status.lockedOut,
      pairedClients: clients.count(),
    });
  });

  app.get("/clients", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    res.json({ ok: true, clients: clients.list() });
  });

  app.post("/clients/revoke", (req: Request, res: Response) => {
    if (!requireAdmin(req, res)) return;
    const body = bodyOf(req);
    if (body.all === true) {
      const removed = clients.revokeAll();
      logger.info("client_revoked_all", { removed });
      res.json({ ok: true, revokedAll: true, removed });
      return;
    }
    const identifier = body.id ?? body.label;
    if (typeof identifier !== "string" || identifier.trim().length === 0) {
      res.status(400).json({ ok: false, error: "id or label is required" });
      return;
    }
    const revoked = clients.revoke(identifier);
    if (!revoked) {
      res.status(404).json({ ok: false, error: "client not found" });
      return;
    }
    logger.info("client_revoked", { clientId: revoked.id, label: revoked.label });
    res.json({ ok: true, revoked });
  });
}
