import type {
  EvidenceClaim,
  ReasonCode,
  SentinelCheck,
  SentinelVerdict,
  TransactionIntent,
} from "@prismpulse/schemas";

export type PayloadInspectionStatus = "PASS" | "BLOCK" | "UNKNOWN";

export interface SentinelSignals {
  simulationSucceeded: boolean;
  approvalIsUnlimited: boolean;
  effectRecipientMatches?: boolean;
  knownAttackSignature?: boolean;
  payloadInspection?: { status: PayloadInspectionStatus; confidence: number };
  counterparty?: {
    identityResolved?: boolean;
    highValue?: boolean;
    knownVendorAddressChanged?: boolean;
  };
  counterpartyAnomalyScore?: number;
  spendPolicy?: {
    killSwitchActive: boolean;
    drainDetected: boolean;
    amountUsd: number;
    rollingDailySpendUsd: number;
    perTransactionCapUsd: number;
    dailyCapUsd: number;
  } | undefined;
  priceImpactBps?: number;
  contractVerified?: boolean;
}

const POLICY_VERSION = "sentinel-2026-07-13.2";
const ANOMALY_BLOCK_THRESHOLD = 70;
const injectionPatterns = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /override\s+(the\s+)?(system|policy|safety)/i,
  /send\s+(the\s+)?funds?\s+instead\s+to/i,
  /replace\s+(the\s+)?(wallet|payment)\s+address/i,
  /do\s+not\s+(tell|notify|inform)\s+(the\s+)?(user|owner)/i,
  /urgent.{0,80}(new|different|updated)\s+(wallet|address)/i,
  /(?:base64|hex|unicode)[- ]?(?:decode|encoded).{0,80}(instruction|payment|address)/i,
];

export function inspectPayloadText(text: string | undefined): {
  status: PayloadInspectionStatus;
  confidence: number;
  matchedPatternCount: number;
} {
  if (text === undefined || text.trim().length === 0) {
    return { status: "PASS", confidence: 1, matchedPatternCount: 0 };
  }
  const matchedPatternCount = injectionPatterns.filter((pattern) => pattern.test(text)).length;
  if (matchedPatternCount > 0) {
    return { status: "BLOCK", confidence: 1, matchedPatternCount };
  }
  const ambiguousRedirect =
    /0x[a-fA-F0-9]{40}/.test(text) &&
    /(?:new|different|updated|changed).{0,60}(?:wallet|address)/i.test(text);
  return ambiguousRedirect
    ? { status: "UNKNOWN", confidence: 0.5, matchedPatternCount: 0 }
    : { status: "PASS", confidence: 0.9, matchedPatternCount: 0 };
}

function result(
  check: SentinelCheck["check"],
  status: SentinelCheck["status"],
  confidence: number,
  reasons: ReasonCode[],
  summary: string,
): SentinelCheck {
  return { check, status, confidence, reasons, summary };
}

function unavailable(check: SentinelCheck["check"], summary: string): SentinelCheck {
  return result(check, "BLOCK", 0, ["CHECK_UNAVAILABLE"], summary);
}

export function evaluateTransaction(
  intent: TransactionIntent,
  signals: SentinelSignals,
  evidence: EvidenceClaim[],
): SentinelVerdict {
  const checks: SentinelCheck[] = [];
  const payload = signals.payloadInspection;
  if (!payload) {
    checks.push(unavailable("PAYLOAD_INSPECTION", "Payload inspection did not complete."));
  } else if (payload.status !== "PASS") {
    checks.push(result(
      "PAYLOAD_INSPECTION",
      "BLOCK",
      payload.confidence,
      [payload.status === "BLOCK" ? "PAYLOAD_INJECTION" : "PAYLOAD_AMBIGUOUS"],
      payload.status === "BLOCK"
        ? "Manipulation patterns were detected in the inbound payload."
        : "The payload is ambiguous and requires owner confirmation.",
    ));
  } else {
    checks.push(result("PAYLOAD_INSPECTION", "PASS", payload.confidence, [], "No manipulation pattern was detected."));
  }

  const counterparty = signals.counterparty;
  if (!counterparty || counterparty.highValue === undefined || counterparty.knownVendorAddressChanged === undefined) {
    checks.push(unavailable("COUNTERPARTY_VERIFICATION", "Counterparty verification did not complete."));
  } else if (counterparty.knownVendorAddressChanged) {
    checks.push(result("COUNTERPARTY_VERIFICATION", "BLOCK", 1, ["KNOWN_VENDOR_ADDRESS_CHANGED"], "A known vendor payment address changed."));
  } else if (counterparty.highValue && counterparty.identityResolved !== true) {
    checks.push(result("COUNTERPARTY_VERIFICATION", "BLOCK", 0, ["IDENTITY_UNRESOLVED"], "A high-value counterparty identity could not be resolved."));
  } else {
    checks.push(result("COUNTERPARTY_VERIFICATION", "PASS", counterparty.identityResolved ? 1 : 0.8, [], "No counterparty identity or vendor-address violation was found."));
  }

  const intentReasons: ReasonCode[] = [];
  if (!signals.simulationSucceeded) intentReasons.push("SIMULATION_REVERT");
  if (signals.approvalIsUnlimited) intentReasons.push("UNLIMITED_APPROVAL");
  if (signals.effectRecipientMatches === false) intentReasons.push("INTENT_EFFECT_MISMATCH");
  if (intent.expectedRecipient && intent.expectedRecipient.toLowerCase() !== intent.to.toLowerCase()) {
    intentReasons.push("RECIPIENT_MISMATCH");
  }
  if (signals.effectRecipientMatches === undefined) {
    checks.push(unavailable("TRANSACTION_INTENT_GUARD", "Transaction effect comparison did not complete."));
  } else if (intentReasons.length > 0) {
    checks.push(result("TRANSACTION_INTENT_GUARD", "BLOCK", 1, intentReasons, "The simulated transaction effect violates the declared intent."));
  } else {
    checks.push(result("TRANSACTION_INTENT_GUARD", "PASS", 1, [], "The simulated transaction effect matches the declared intent."));
  }

  if (signals.knownAttackSignature === undefined || signals.counterpartyAnomalyScore === undefined) {
    checks.push(unavailable("COUNTERPARTY_ANOMALY", "Hive and counterparty anomaly checks did not complete."));
  } else if (signals.knownAttackSignature) {
    checks.push(result("COUNTERPARTY_ANOMALY", "BLOCK", 1, ["KNOWN_ATTACK_SIGNATURE"], "The transaction matched a propagated Hive signature."));
  } else if (signals.counterpartyAnomalyScore >= ANOMALY_BLOCK_THRESHOLD) {
    checks.push(result("COUNTERPARTY_ANOMALY", "BLOCK", 0.9, ["COUNTERPARTY_ANOMALY"], "The counterparty exceeded the anomaly threshold."));
  } else {
    checks.push(result("COUNTERPARTY_ANOMALY", "PASS", 0.9, [], "No propagated signature or material counterparty anomaly was found."));
  }

  const spend = signals.spendPolicy;
  if (!spend) {
    checks.push(unavailable("SPEND_CIRCUIT_BREAKER", "Spend policy evaluation did not complete."));
  } else if (spend.killSwitchActive) {
    checks.push(result("SPEND_CIRCUIT_BREAKER", "BLOCK", 1, ["KILL_SWITCH_ACTIVE"], "The global transaction kill switch is active."));
  } else if (spend.drainDetected) {
    checks.push(result("SPEND_CIRCUIT_BREAKER", "BLOCK", 1, ["DRAIN_PATTERN"], "A drain-in-progress pattern was detected."));
  } else if (spend.amountUsd > spend.perTransactionCapUsd || spend.rollingDailySpendUsd + spend.amountUsd > spend.dailyCapUsd) {
    checks.push(result("SPEND_CIRCUIT_BREAKER", "BLOCK", 1, ["SPEND_CAP_EXCEEDED"], "The transaction exceeds a bounded spend policy."));
  } else {
    checks.push(result("SPEND_CIRCUIT_BREAKER", "PASS", 1, [], "The transaction is within bounded spend policy."));
  }

  const reasonCodes: ReasonCode[] = [...new Set(checks.flatMap((check) => check.reasons))];
  let score = checks.filter((check) => check.status === "BLOCK").length * 25;
  if (signals.contractVerified === false) { reasonCodes.push("UNVERIFIED_CONTRACT"); score += 20; }
  if (signals.priceImpactBps !== undefined && signals.priceImpactBps > (intent.maxSlippageBps ?? 300)) {
    reasonCodes.push("HIGH_PRICE_IMPACT"); score += 35;
  }
  if (evidence.some((claim) => claim.stale)) { reasonCodes.push("STALE_EVIDENCE"); score += 20; }
  if (evidence.length === 0 || evidence.every((claim) => !claim.verified)) {
    reasonCodes.push("INSUFFICIENT_EVIDENCE"); score += 60;
  }
  const uniqueReasons = [...new Set(reasonCodes)];
  const hardBlock = checks.some((check) => check.status === "BLOCK") || uniqueReasons.includes("INSUFFICIENT_EVIDENCE");
  const warning = uniqueReasons.some((code) => ["UNVERIFIED_CONTRACT", "STALE_EVIDENCE", "HIGH_PRICE_IMPACT"].includes(code));
  const verifiedRatio = evidence.length === 0 ? 0 : evidence.filter((claim) => claim.verified && !claim.stale).length / evidence.length;
  const checkConfidence = checks.reduce((total, check) => total + check.confidence, 0) / checks.length;
  return {
    verdict: hardBlock ? "BLOCK" : warning ? "WARN" : "ALLOW",
    score: Math.min(100, score),
    reasonCodes: uniqueReasons,
    perCheck: checks,
    confidence: Number((checkConfidence * verifiedRatio).toFixed(4)),
    summary: uniqueReasons.length === 0
      ? "All five Sentinel checks passed with verified evidence."
      : `Sentinel found ${uniqueReasons.length} active policy signal(s) across five checks.`,
    evidence,
    policyVersion: POLICY_VERSION,
    createdAt: new Date().toISOString(),
  };
}