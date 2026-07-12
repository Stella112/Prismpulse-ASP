import cors from "cors";
import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";
import { createEvidenceSeal, evaluateTransaction } from "@prismpulse/core";
import { transactionIntentSchema } from "@prismpulse/schemas";
import type { TransactionIntent } from "@prismpulse/schemas";
import { z } from "zod";
import { createPaymentGate } from "./payments.js";
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
      capabilities: ["pulse-inspection", "sentinel-check", "evidence-receipts"],
    });
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
      const inspection = await collectEvidence(parsed.data.intent);
      const verdict = evaluateTransaction(
        parsed.data.intent,
        inspection.signals,
        inspection.evidence,
      );

      response.json({
        verdict,
        seal: createEvidenceSeal(parsed.data.intent, verdict),
      });
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

  return app;
}
