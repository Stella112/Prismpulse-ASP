import type {
  EvidenceClaim,
  ReasonCode,
  SentinelVerdict,
  TransactionIntent,
} from "@prismpulse/schemas";

export interface SentinelSignals {
  simulationSucceeded: boolean;
  approvalIsUnlimited: boolean;
  knownAttackSignature?: boolean;
  priceImpactBps?: number;
  contractVerified?: boolean;
}

const POLICY_VERSION = "sentinel-2026-07-11.1";

export function evaluateTransaction(
  intent: TransactionIntent,
  signals: SentinelSignals,
  evidence: EvidenceClaim[],
): SentinelVerdict {
  const reasonCodes: ReasonCode[] = [];
  let score = 0;

  if (
    intent.expectedRecipient &&
    intent.expectedRecipient.toLowerCase() !== intent.to.toLowerCase()
  ) {
    reasonCodes.push("RECIPIENT_MISMATCH");
    score += 100;
  }

  if (!signals.simulationSucceeded) {
    reasonCodes.push("SIMULATION_REVERT");
    score += 80;
  }

  if (signals.knownAttackSignature) {
    reasonCodes.push("KNOWN_ATTACK_SIGNATURE");
    score += 100;
  }

  if (signals.knownAttackSignature === undefined) {
    reasonCodes.push("SIGNATURE_SCAN_UNAVAILABLE");
    score += 25;
  }

  if (signals.approvalIsUnlimited) {
    reasonCodes.push("UNLIMITED_APPROVAL");
    score += 45;
  }

  if (signals.contractVerified === false) {
    reasonCodes.push("UNVERIFIED_CONTRACT");
    score += 20;
  }

  if (
    signals.priceImpactBps !== undefined &&
    signals.priceImpactBps > (intent.maxSlippageBps ?? 300)
  ) {
    reasonCodes.push("HIGH_PRICE_IMPACT");
    score += 35;
  }

  if (evidence.some((claim) => claim.stale)) {
    reasonCodes.push("STALE_EVIDENCE");
    score += 20;
  }

  if (evidence.length === 0 || evidence.every((claim) => !claim.verified)) {
    reasonCodes.push("INSUFFICIENT_EVIDENCE");
    score += 60;
  }

  score = Math.min(100, score);
  const hardBlock = reasonCodes.some((code) =>
    [
      "RECIPIENT_MISMATCH",
      "SIMULATION_REVERT",
      "KNOWN_ATTACK_SIGNATURE",
      "INSUFFICIENT_EVIDENCE",
    ].includes(code),
  );
  const verdict = hardBlock || score >= 70 ? "BLOCK" : score >= 25 ? "WARN" : "ALLOW";

  return {
    verdict,
    score,
    reasonCodes,
    summary:
      reasonCodes.length === 0
        ? "No active policy violations were found in the supplied evidence."
        : `Sentinel found ${reasonCodes.length} active policy signal(s).`,
    evidence,
    policyVersion: POLICY_VERSION,
    createdAt: new Date().toISOString(),
  };
}
