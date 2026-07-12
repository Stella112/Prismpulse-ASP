import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { createEvidenceSeal, evaluateTransaction } from "@prismpulse/core";
import {
  evidenceClaimSchema,
  transactionIntentSchema,
} from "@prismpulse/schemas";
import { z } from "zod";
import { createPaymentGate } from "./payments.js";

const checkRequestSchema = z.object({
  intent: transactionIntentSchema,
  signals: z.object({
    simulationSucceeded: z.boolean(),
    approvalIsUnlimited: z.boolean(),
    knownAttackSignature: z.boolean(),
    priceImpactBps: z.number().int().min(0).optional(),
    contractVerified: z.boolean().optional(),
  }),
  evidence: z.array(evidenceClaimSchema),
});

export function createApp(): Express {
  const app = express();
  const paymentGate = createPaymentGate(process.env);
  app.disable("x-powered-by");
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
      capabilities: ["sentinel-check", "evidence-receipts"],
    });
  });

  // Development-only until OKX payment verification is mounted around this route.
  app.post("/v1/sentinel/check", (request, response) => {
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

    const { signals } = parsed.data;
    const verdict = evaluateTransaction(
      parsed.data.intent,
      {
        simulationSucceeded: signals.simulationSucceeded,
        approvalIsUnlimited: signals.approvalIsUnlimited,
        knownAttackSignature: signals.knownAttackSignature,
        ...(signals.priceImpactBps === undefined
          ? {}
          : { priceImpactBps: signals.priceImpactBps }),
        ...(signals.contractVerified === undefined
          ? {}
          : { contractVerified: signals.contractVerified }),
      },
      parsed.data.evidence,
    );

    response.json({
      verdict,
      seal: createEvidenceSeal(parsed.data.intent, verdict),
    });
  });

  return app;
}
