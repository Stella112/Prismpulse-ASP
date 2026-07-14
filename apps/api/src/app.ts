import cors from "cors";
import express, { type Express, type RequestHandler } from "express";
import helmet from "helmet";
import { createEvidenceSeal, evaluateTransaction, inspectPayloadText, type PayloadInspectionStatus } from "@prismpulse/core";
import {
  digestSchema,
  evidenceSealSchema,
  sentinelVerdictSchema,
  transactionIntentSchema,
} from "@prismpulse/schemas";
import type { TransactionIntent } from "@prismpulse/schemas";
import { z } from "zod";
import { createPaymentGate } from "./payments.js";
import { createHiveStore, type HiveStore } from "./hive.js";
import { createLocalReasoner, type LocalReasoner } from "./reasoner.js";
import { createSealRegistry, type SealRegistry } from "./registry.js";
import { attestSeal, verifySealRecord } from "./seal-attestation.js";
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

const hiveCaptureSchema = z.object({
  payload: z.string().min(3).max(20_000),
  source: z.string().min(3).max(200),
});

const sealVerificationSchema = z.object({
  seal: evidenceSealSchema,
  intent: transactionIntentSchema,
  verdict: sentinelVerdictSchema,
});

export interface AppOptions {
  collectEvidence?: (intent: TransactionIntent) => Promise<PulseInspection>;
  sealStore?: EvidenceSealStore;
  sealRegistry?: SealRegistry;
  hiveStore?: HiveStore;
  reasoner?: LocalReasoner;
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
  const hiveStorePromise = options.hiveStore ? Promise.resolve(options.hiveStore) : createHiveStore(process.env);
  const reasoner = options.reasoner ?? (process.env.NODE_ENV === "test"
    ? { inspectPayload: async () => ({ status: "PASS", confidence: 1, reasons: [] }), ready: async () => true }
    : createLocalReasoner(process.env));
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

  app.get("/v1/readiness", async (_request, response) => {
    const registryReady = sealRegistry.configured && sealRegistry.workerEnabled;
    const paymentsReady = paymentGate.enabled;
    const localReasoningReady = await reasoner.ready();
    let hiveReady = false;
    try {
      await (await hiveStorePromise).list();
      hiveReady = true;
    } catch {}
    const launchReady = registryReady && paymentsReady && localReasoningReady && hiveReady;
    response.status(launchReady ? 200 : 503).json({
      status: launchReady ? "READY" : "NOT_READY",
      operational: true,
      launchReady,
      checks: {
        api: "READY",
        registry: registryReady ? "READY" : "NOT_READY",
        payments: paymentsReady ? "READY" : "NOT_READY",
        localReasoning: localReasoningReady ? "READY" : "NOT_READY",
        hive: hiveReady ? "READY" : "NOT_READY",
        consoleIssuance: consoleIssuanceEnabled ? "READY" : "DISABLED",
      },
      actions: [
        ...(!registryReady ? ["Configure the X Layer registry issuer worker."] : []),
        ...(!paymentsReady ? ["Configure and enable OKX seller payments."] : []),
        ...(!localReasoningReady ? ["Start the pinned local Llama model."] : []),
        ...(!hiveReady ? ["Restore the passive Hive signature store."] : []),
      ],
    });
  });

  app.get("/v1/metadata", (_request, response) => {
    const autonomousExecution = process.env.AUTONOMOUS_EXECUTION_ENABLED === "true";
    const gasVault = process.env.GAS_VAULT_ENABLED === "true";
    const a2a = Boolean(process.env.A2A_AGENT_ID);
    const capabilities = [
      "pulse-inspection",
      "sentinel-check",
      "console-seal-issuance",
      "evidence-receipts",
      "signed-evidence-receipts",
      "public-seal-verification",
      "registry-status",
      "launch-readiness",
      "five-check-sentinel",
      "passive-hive-immunization",
      "local-llama-reasoning",
      ...(autonomousExecution ? ["bounded-dex-execution"] : []),
      ...(gasVault ? ["gas-vault-auto-refill"] : []),
      ...(a2a ? ["a2a-negotiation-escrow-delivery-disputes"] : []),
    ];
    response.json({
      name: "PrismPulse Sentinel API",
      version: "0.1.0",
      network: "eip155:196",
      paidRoutesEnabled: paymentGate.enabled,
      consoleIssuanceEnabled,
      registry: {
        configured: sealRegistry.configured,
        workerEnabled: sealRegistry.workerEnabled,
        address: sealRegistry.address,
        explorerUrl: sealRegistry.explorerUrl,
      },
      productStatus: a2a && autonomousExecution && gasVault
        ? "FULL_RUNTIME_READY"
        : "SENTINEL_SERVICE_READY",
      capabilities,
      unavailableCapabilities: [
        ...(!autonomousExecution ? ["bounded-dex-execution"] : []),
        ...(!gasVault ? ["gas-vault-auto-refill"] : []),
        ...(!a2a ? ["a2a-negotiation-escrow-delivery-disputes"] : []),
      ],
    });
  });

  app.post("/v1/seals/verify", async (request, response) => {
    const parsed = sealVerificationSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "INVALID_SEAL_RECORD",
        details: parsed.error.flatten(),
      });
      return;
    }
    try {
      const result = await verifySealRecord(parsed.data);
      response.status(result.valid ? 200 : 422).json(result);
    } catch {
      response.status(422).json({ valid: false, error: "SEAL_VERIFICATION_FAILED" });
    }
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
    const payload = intent.payloadText ?? intent.declaredPurpose;
    const deterministicInspection = inspectPayloadText(payload);
    const modelInspection = await reasoner.inspectPayload(payload);
    const hive = await (await hiveStorePromise).inspect(payload, [intent.to]);
    const payloadStatus: PayloadInspectionStatus = deterministicInspection.status === "BLOCK" || modelInspection.status === "BLOCK"
      ? "BLOCK"
      : deterministicInspection.status === "UNKNOWN" || modelInspection.status === "UNKNOWN" ? "UNKNOWN" : "PASS";
    const amountUsd = intent.transactionAmountUsd ?? (intent.value === "0" ? 0 : undefined);
    const effectRecipient = (inspection.effectRecipient ?? intent.to).toLowerCase();
    const knownCounterparties = new Set(
      (process.env.KNOWN_COUNTERPARTY_ADDRESSES ?? "")
        .split(",")
        .map((address) => address.trim().toLowerCase())
        .filter(Boolean),
    );
    const evidence = inspection.evidence.filter((claim) => !claim.id.startsWith("signature-scan-")).concat([
      {
        id: "hive-scan-" + inspection.blockNumber,
        kind: "signature" as const,
        source: (process.env.PUBLIC_BASE_URL ?? "https://api.getprismpulse.xyz") + "/v1/hive/signatures",
        observedAt: new Date().toISOString(),
        blockNumber: inspection.blockNumber,
        value: hive,
        confidence: 1,
        verified: true,
        stale: false,
      },
      {
        id: "llama-inspection-" + inspection.blockNumber,
        kind: "policy" as const,
        source: process.env.OLLAMA_BASE_URL ?? "http://ollama:11434",
        observedAt: new Date().toISOString(),
        blockNumber: inspection.blockNumber,
        value: modelInspection,
        confidence: modelInspection.confidence,
        verified: modelInspection.status !== "UNKNOWN",
        stale: false,
      },
    ]);
    const signals = {
      ...inspection.signals,
      payloadInspection: {
        status: payloadStatus,
        confidence: Math.min(deterministicInspection.confidence, modelInspection.confidence),
      },
      effectRecipientMatches: intent.expectedRecipient
        ? intent.expectedRecipient.toLowerCase() === effectRecipient
        : true,
      knownAttackSignature: hive.matched,
      counterpartyAnomalyScore: hive.anomalyScore,
      counterparty: {
        identityResolved: knownCounterparties.has(effectRecipient),
        highValue: amountUsd === undefined || amountUsd >= Number(process.env.SENTINEL_HIGH_VALUE_USD ?? 100),
        knownVendorAddressChanged: Boolean(
          intent.expectedRecipient && intent.expectedRecipient.toLowerCase() !== effectRecipient,
        ),
      },
      spendPolicy: amountUsd === undefined ? undefined : {
        killSwitchActive: process.env.GLOBAL_KILL_SWITCH === "true",
        drainDetected: false,
        amountUsd,
        rollingDailySpendUsd: Number(process.env.ROLLING_DAILY_SPEND_USD ?? 0),
        perTransactionCapUsd: Number(process.env.PER_TRANSACTION_CAP_USD ?? 100),
        dailyCapUsd: Number(process.env.DAILY_CAP_USD ?? 500),
      },
    };
    const verdict = evaluateTransaction(intent, signals, evidence);
    const seal = await attestSeal(createEvidenceSeal(intent, verdict));
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

  app.post("/v1/hive/captures", async (request, response) => {
    const captureToken = process.env.HIVE_CAPTURE_TOKEN;
    if (process.env.NODE_ENV === "production" && !captureToken) {
      response.status(503).json({ error: "HIVE_CAPTURE_DISABLED" });
      return;
    }
    if (captureToken && request.headers.authorization !== "Bearer " + captureToken) {
      response.status(401).json({ error: "HIVE_CAPTURE_UNAUTHORIZED" });
      return;
    }
    const parsed = hiveCaptureSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: "INVALID_REQUEST", details: parsed.error.flatten() });
      return;
    }
    try {
      const signature = await (await hiveStorePromise).capture(parsed.data.payload, parsed.data.source);
      response.status(201).json({ signature, propagated: true });
    } catch (error) {
      response.status(422).json({ error: "CAPTURE_REJECTED", message: error instanceof Error ? error.message : "Hive capture rejected." });
    }
  });

  app.get("/v1/hive/signatures", async (_request, response) => {
    response.json({ signatures: await (await hiveStorePromise).list() });
  });

  return app;
}
