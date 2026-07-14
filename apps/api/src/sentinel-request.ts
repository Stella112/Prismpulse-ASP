import type { RequestHandler } from "express";
import type { ZodError } from "zod";
import { transactionIntentSchema } from "@prismpulse/schemas";

export const SENTINEL_SCHEMA_PATH = "/v1/sentinel/schema";

export const SENTINEL_REQUEST_EXAMPLE = {
  intent: {
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    declaredPurpose: "Pay a verified service provider",
    transactionAmountUsd: 25,
  },
} as const;

export const SENTINEL_REQUEST_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://api.getprismpulse.xyz/v1/sentinel/schema",
  title: "PrismPulse Sentinel check request",
  description:
    "Request for POST /v1/sentinel/check. chainId, value, and data receive X Layer-safe defaults when omitted.",
  type: "object",
  additionalProperties: true,
  required: ["intent"],
  properties: {
    intent: {
      type: "object",
      additionalProperties: true,
      required: ["from", "to", "declaredPurpose"],
      properties: {
        chainId: { const: 196, default: 196, description: "X Layer chain ID." },
        from: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Wallet initiating the proposed transaction.",
        },
        to: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
          description: "Contract or recipient the transaction will call.",
        },
        value: {
          type: "string",
          pattern: "^[0-9]+$",
          default: "0",
          description: "Native value in wei, as a decimal string.",
        },
        data: {
          type: "string",
          pattern: "^0x(?:[a-fA-F0-9]{2})*$",
          default: "0x",
          description: "Transaction calldata.",
        },
        declaredPurpose: {
          type: "string",
          minLength: 3,
          maxLength: 500,
          description: "Plain-language purpose of the proposed transaction.",
        },
        expectedRecipient: {
          type: "string",
          pattern: "^0x[a-fA-F0-9]{40}$",
        },
        maxSlippageBps: { type: "integer", minimum: 0, maximum: 10000 },
        payloadText: { type: "string", maxLength: 20000 },
        transactionAmountUsd: { type: "number", minimum: 0 },
      },
    },
  },
  examples: [SENTINEL_REQUEST_EXAMPLE],
  acceptedForms: [
    "Canonical wrapper: { intent: { ... } }",
    "Flat transaction intent: { from, to, declaredPurpose, ... }",
    "Marketplace wrappers: { input: { ... } }, { task: { ... } }, { transaction: { ... } }",
  ],
} as const;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function first(source: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function numberValue(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}

/** Normalize canonical, flat, and common OKX marketplace wrapper payloads. */
export function normalizeSentinelRequest(body: unknown): unknown {
  if (!isRecord(body)) return body;

  const wrapper = first(body, [
    "intent",
    "input",
    "task",
    "transaction",
    "request",
    "parameters",
  ]);
  let candidate: unknown = wrapper ?? body;

  if (typeof candidate === "string") candidate = { declaredPurpose: candidate };
  if (!isRecord(candidate)) return body;

  const nestedTransaction = isRecord(candidate.transaction) ? candidate.transaction : {};
  const source = { ...candidate, ...nestedTransaction };
  const declaredPurpose = first(source, [
    "declaredPurpose",
    "purpose",
    "description",
    "prompt",
    "message",
    "taskDescription",
  ]);
  const rawValue = first(source, ["value", "valueWei", "amountWei"]);

  const intent = {
    chainId: numberValue(first(source, ["chainId", "chain_id"]) ?? 196),
    from: first(source, [
      "from",
      "sender",
      "walletAddress",
      "wallet_address",
      "userAddress",
    ]),
    to: first(source, [
      "to",
      "recipient",
      "target",
      "targetAddress",
      "contractAddress",
    ]),
    value: rawValue === undefined ? "0" : String(rawValue),
    data: first(source, ["data", "calldata", "transactionData"]) ?? "0x",
    declaredPurpose,
    expectedRecipient: first(source, ["expectedRecipient", "expected_recipient"]),
    maxSlippageBps: numberValue(
      first(source, ["maxSlippageBps", "max_slippage_bps"]),
    ),
    payloadText: first(source, ["payloadText", "payload", "payload_text"]),
    transactionAmountUsd: numberValue(
      first(source, [
        "transactionAmountUsd",
        "amountUsd",
        "usdAmount",
        "transaction_amount_usd",
      ]),
    ),
  };

  return {
    intent: Object.fromEntries(
      Object.entries(intent).filter(([, value]) => value !== undefined),
    ),
  };
}

export function parseSentinelRequest(body: unknown) {
  const normalized = normalizeSentinelRequest(body);
  const intent = isRecord(normalized) ? normalized.intent : undefined;
  return transactionIntentSchema.safeParse(intent);
}

export function formatSentinelValidationError(error: ZodError) {
  const fields: Record<string, string[]> = {};
  const required: string[] = [];

  for (const issue of error.issues) {
    const field = ["intent", ...issue.path.map(String)].join(".");
    (fields[field] ??= []).push(issue.message);
    if (issue.code === "invalid_type" && issue.received === "undefined") {
      required.push(field);
    }
  }

  return {
    error: "INVALID_REQUEST",
    message: "The Sentinel request body is invalid. No payment was processed.",
    required: [...new Set(required)],
    fields,
    schemaUrl: "https://api.getprismpulse.xyz" + SENTINEL_SCHEMA_PATH,
    example: SENTINEL_REQUEST_EXAMPLE,
  };
}

function hasPaymentProof(headers: Record<string, unknown>): boolean {
  return Boolean(
    headers["payment-signature"] ||
      headers["x-payment"] ||
      headers.authorization?.toString().startsWith("Payment "),
  );
}

/**
 * Reject malformed signed replays before x402 settlement. Unsigned discovery
 * requests continue to the payment middleware so buyers still receive a 402.
 */
export const validateSentinelBeforeSettlement: RequestHandler = (
  request,
  response,
  next,
) => {
  if (request.method !== "POST" || request.path !== "/v1/sentinel/check") {
    next();
    return;
  }

  const normalized = normalizeSentinelRequest(request.body);
  if (!hasPaymentProof(request.headers)) {
    request.body = normalized;
    next();
    return;
  }

  const parsed = parseSentinelRequest(normalized);
  if (!parsed.success) {
    response.status(400).json(formatSentinelValidationError(parsed.error));
    return;
  }

  request.body = { intent: parsed.data };
  next();
};
