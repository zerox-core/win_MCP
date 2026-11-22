/**
 * Pairing HTTP routes.
 *
 *   POST /pair          redeem a one-time code for the persistent client key
 *   GET  /pair/status   whether an unexpired code is outstanding (no secrets)
 *
 * Both are unauthenticated by design: the code *is* the credential being
 * exchanged, and requiring an existing credential would defeat the point.
 * Every failure is deliberately vague to avoid confirming a guess, and the
 * endpoint is rate limited by the same middleware as the MCP transport.
 */

import type { Express, Request, Response } from "express";
import { logger } from "../security/logger.js";
import type { ClientKeyStore, PairingCodeRegistry } from "../security/clientPairing.js";

export interface PairingRoutesOptions {
  app: Express;
  registry: PairingCodeRegistry;
  keyStore: ClientKeyStore;
  /** Absolute public base URL used to print a copyable pairing hint. */
  publicBaseUrl: () => string;
}

const MAX_BODY_BYTES = 512;

function bodyOf(req: Request): { code?: unknown } {
  const raw = req.body;
  if (!raw || typeof raw !== "object") return {};
  return raw as { code?: unknown };
}

export function registerPairingRoutes(options: PairingRoutesOptions): void {
  const { app, registry, keyStore, publicBaseUrl } = options;

  app.post("/pair", (req: Request, res: Response) => {
    const { code } = bodyOf(req);
    if (typeof code !== "string" || code.length === 0 || code.length > MAX_BODY_BYTES) {
      res.status(400).json({ ok: false, error: "code is required" });
      return;
    }

    const outcome = registry.redeem(code, keyStore.read() ?? "");
    if (!outcome.ok) {
      // One generic message: distinguishing "expired" from "wrong" would let a
      // caller confirm a partial guess.
      logger.warn("client_pairing_failed", { reason: outcome.reason });
      const status = outcome.reason === "locked_out" ? 429 : 401;
      res.status(status).json({
        ok: false,
        error: "pairing code is not valid",
        // Tell the operator to re-read the console rather than keep guessing.
        hint: "restart-free: run `node dist/index.js --pair` in a terminal on the server machine for a fresh code",
      });
      return;
    }

    logger.info("client_paired");
    res.json({
      ok: true,
      clientKey: outcome.clientKey,
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
    });
  });
}
