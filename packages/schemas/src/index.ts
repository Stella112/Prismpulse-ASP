import { z } from "zod";

export const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
export const hexSchema = z.string().regex(/^0x[a-fA-F0-9]*$/);

export const transactionIntentSchema = z.object({
  chainId: z.literal(196),
  from: addressSchema,
  to: addressSchema,
  value: z.string().regex(/^\d+$/),
  data: hexSchema.default("0x"),
  declaredPurpose: z.string().min(3).max(500),
  expectedRecipient: addressSchema.optional(),
  maxSlippageBps: z.number().int().min(0).max(10_000).optional(),
  payloadText: z.string().max(20_000).optional(),
  transactionAmountUsd: z.number().nonnegative().optional(),
});

export const evidenceClaimSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "rpc",
    "simulation",
    "contract",
    "token",
    "market",
    "signature",
    "policy",
  ]),
  source: z.string().url(),
  observedAt: z.string().datetime(),
  blockNumber: z.string().regex(/^\d+$/).optional(),
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  verified: z.boolean(),
  stale: z.boolean().default(false),
});

export const reasonCodeSchema = z.enum([
  "RECIPIENT_MISMATCH",
  "UNLIMITED_APPROVAL",
  "SIMULATION_REVERT",
  "KNOWN_ATTACK_SIGNATURE",
  "SIGNATURE_SCAN_UNAVAILABLE",
  "HIGH_PRICE_IMPACT",
  "EXCESSIVE_SLIPPAGE",
  "UNVERIFIED_CONTRACT",
  "STALE_EVIDENCE",
  "INSUFFICIENT_EVIDENCE",
  "PAYLOAD_INJECTION",
  "PAYLOAD_AMBIGUOUS",
  "IDENTITY_UNRESOLVED",
  "KNOWN_VENDOR_ADDRESS_CHANGED",
  "INTENT_EFFECT_MISMATCH",
  "COUNTERPARTY_ANOMALY",
  "SPEND_CAP_EXCEEDED",
  "DRAIN_PATTERN",
  "KILL_SWITCH_ACTIVE",
  "CHECK_UNAVAILABLE",
]);

export const sentinelCheckSchema = z.object({
  check: z.enum([
    "PAYLOAD_INSPECTION",
    "COUNTERPARTY_VERIFICATION",
    "TRANSACTION_INTENT_GUARD",
    "COUNTERPARTY_ANOMALY",
    "SPEND_CIRCUIT_BREAKER",
  ]),
  status: z.enum(["PASS", "WARN", "BLOCK"]),
  confidence: z.number().min(0).max(1),
  reasons: z.array(reasonCodeSchema),
  summary: z.string(),
});

export const sentinelVerdictSchema = z.object({
  verdict: z.enum(["ALLOW", "WARN", "BLOCK"]),
  score: z.number().int().min(0).max(100),
  reasonCodes: z.array(reasonCodeSchema),
  perCheck: z.array(sentinelCheckSchema).length(5),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  evidence: z.array(evidenceClaimSchema),
  policyVersion: z.string(),
  createdAt: z.string().datetime(),
});

export const digestSchema = z.string().regex(/^0x[a-f0-9]{64}$/);

export const evidenceSealSchema = z.object({
  version: z.literal("1"),
  network: z.literal("eip155:196"),
  intentDigest: digestSchema,
  evidenceDigest: digestSchema,
  decisionDigest: digestSchema,
  verdict: sentinelVerdictSchema.shape.verdict,
  policyVersion: z.string(),
  createdAt: z.string().datetime(),
});

export type TransactionIntent = z.infer<typeof transactionIntentSchema>;
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;
export type ReasonCode = z.infer<typeof reasonCodeSchema>;
export type SentinelCheck = z.infer<typeof sentinelCheckSchema>;
export type SentinelVerdict = z.infer<typeof sentinelVerdictSchema>;
export type EvidenceSeal = z.infer<typeof evidenceSealSchema>;
