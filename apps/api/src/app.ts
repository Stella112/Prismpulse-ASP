import cors from "cors";
import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";
import { createEvidenceSeal, evaluateTransaction } from "@prismpulse/core";
import { digestSchema, transactionIntentSchema } from "@prismpulse/schemas";
import type { TransactionIntent } from "@prismpulse/schemas";
import { z } from "zod";
import { createPaymentGate } from "./payments.js";
import { createSealRegistry, type SealRegistry } from "./registry.js";
import {
  createEvidenceSealStore,
  type EvidenceSealStore,
} from "./seals.js";
import {
  collectXLayerEvidence,
  EvidenceUnavailableError,
  type PulseInspection,
} from "./pulse.js";

const checkRequestSchema = z.object({
  intent: transactionIntentSchema,
});

export interface AppOptions {
  collectEvidence?: (intent: TransactionIntent) => Promise<PulseInspection>;
  sealStore?: EvidenceSealStore;
  sealRegistry?: SealRegistry;
}

function createPulseRateLimit(limit = 20, windowMs = 60_000): RequestHandler {
  const clients = new Map<string, { count: number; resetsAt: number }>();

  return (request, response, next) => {
    const now = Date.now();
    const key = request.ip ?? request.socket.remoteAddress ?? "unknown";
    const current = clients.get(key);
    const entry =
      current && current.resetsAt > now
        ? current
        : { count: 0, resetsAt: now + windowMs };
    entry.count += 1;
    clients.set(key, entry);

    response.setHeader("RateLimit-Limit", String(limit));
    response.setHeader("RateLimit-Remaining", String(Math.max(0, limit - entry.count)));
    response.setHeader("RateLimit-Reset", String(Math.ceil(entry.resetsAt / 1000)));

    if (entry.count > limit) {
      response.status(429).json({
        error: "RATE_LIMITED",
        message: "Pulse inspection limit reached. Try again shortly.",
      });
      return;
    }
    next();
  };
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const paymentGate = createPaymentGate(process.env);
  const collectEvidence = options.collectEvidence ?? collectXLayerEvidence;
  const sealStore = options.sealStore ?? createEvidenceSealStore(process.env);
  const sealRegistry = options.sealRegistry ?? createSealRegistry(process.env);
  const consoleIssuanceEnabled =
    process.env.NODE_ENV !== "production" || process.env.CONSOLE_ISSUANCE_ENABLED === "true";
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(cors({ origin: false }));
  app.use(express.json({ limit: "256kb" }));
  if (paymentGate.enabled) {
    app.use(paymentGate.middleware);
  }

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", service: "prismpulse-api" });
  });

  app.get("/v1/metadata", (_request, response) => {
    response.json({
      name: "PrismPulse Sentinel API",
      version: "0.1.0",
      network: "eip155:196",
      paidRoutesEnabled: paymentGate.enabled,
      consoleIssuanceEnabled,
      registry: {
        configured: sealRegistry.configured,
        address: sealRegistry.address,
        explorerUrl: sealRegistry.explorerUrl,
      },
      capabilities: [
        "pulse-inspection",
        "sentinel-check",
        "console-seal-issuance",
        "evidence-receipts",
        "registry-status",
      ],
    });
  });

  app.get("/v1/seals/:decisionDigest", async (request, response) => {
    const parsed = digestSchema.safeParse(request.params.decisionDigest);
    if (!parsed.success) {
      response.status(400).json({
        error: "INVALID_DIGEST",
        message: "A lowercase 32-byte decision digest is required.",
      });
      return;
    }

    try {
      const record = await sealStore.findByDecisionDigest(parsed.data);
      if (!record) {
        response.status(404).json({ error: "SEAL_NOT_FOUND" });
        return;
      }
      response.setHeader("Cache-Control", "public, max-age=30");
      response.json({
        ...record,
        anchoring: await sealRegistry.getStatus(record.seal.decisionDigest),
      });
    } catch {
      response.status(503).json({
        error: "SEAL_STORE_UNAVAILABLE",
        message: "Evidence Seal storage is temporarily unavailable.",
      });
    }
  });

  app.post("/v1/pulse/inspect", createPulseRateLimit(), async (request, response) => {
    const parsed = checkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "INVALID_REQUEST",
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      response.json(await collectEvidence(parsed.data.intent));
    } catch (error) {
      response.status(502).json({
        error: "EVIDENCE_UNAVAILABLE",
        message:
          error instanceof EvidenceUnavailableError
            ? error.message
            : "X Layer evidence collection failed.",
      });
    }
  });

  async function issueSeal(intent: TransactionIntent) {
    const inspection = await collectEvidence(intent);
    const verdict = evaluateTransaction(intent, inspection.signals, inspection.evidence);
    const seal = createEvidenceSeal(intent, verdict);
    const record = { verdict, seal, intent, storedAt: new Date().toISOString() };
    await sealStore.save(record);
    const anchoring = await sealRegistry.requestAnchor(seal.decisionDigest);
    return { ...record, anchoring };
  }

  app.post(
    "/v1/console/seals",
    createPulseRateLimit(5),
    async (request, response) => {
      if (!consoleIssuanceEnabled) {
        response.status(503).json({
          error: "CONSOLE_ISSUANCE_DISABLED",
          message: "Console Seal issuance is disabled for this deployment.",
        });
        return;
      }
      const parsed = checkRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        response.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
        return;
      }
      try {
        response.status(201).json(await issueSeal(parsed.data.intent));
      } catch (error) {
        if (error instanceof EvidenceUnavailableError) {
          response.status(502).json({ error: "EVIDENCE_UNAVAILABLE", message: error.message });
          return;
        }
        response.status(503).json({
          error: "SEAL_ISSUANCE_FAILED",
          message: "The Seal could not be issued and persisted.",
        });
      }
    },
  );

  app.post("/v1/sentinel/check", async (request, response) => {
    if (process.env.NODE_ENV === "production" && !paymentGate.enabled) {
      response.status(503).json({
        error: "PAID_ROUTE_NOT_CONFIGURED",
        message: "Sentinel is unavailable until payment verification is enabled.",
      });
      return;
    }

    const parsed = checkRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "INVALID_REQUEST",
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      response.status(201).json(await issueSeal(parsed.data.intent));
    } catch (error) {
      if (error instanceof EvidenceUnavailableError) {
        response.status(502).json({ error: "EVIDENCE_UNAVAILABLE", message: error.message });
        return;
      }
      response.status(503).json({
        error: "SEAL_PERSISTENCE_FAILED",
        message: "The verdict was not issued because its Evidence Seal could not be persisted.",
      });
    }
  });

  return app;
}
