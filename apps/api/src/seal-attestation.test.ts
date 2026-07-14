import { createEvidenceSeal, evaluateTransaction } from "@prismpulse/core";
import type { EvidenceClaim, TransactionIntent } from "@prismpulse/schemas";
import { describe, expect, it } from "vitest";
import { attestSeal, verifySealRecord } from "./seal-attestation.js";

const intent: TransactionIntent = {
  chainId: 196,
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  value: "0",
  data: "0x",
  declaredPurpose: "Verify a signed PrismPulse receipt",
  transactionAmountUsd: 1,
};

const evidence: EvidenceClaim[] = [{
  id: "simulation-1",
  kind: "simulation",
  source: "https://rpc.xlayer.tech",
  observedAt: "2026-07-13T00:00:00.000Z",
  value: { success: true },
  confidence: 1,
  verified: true,
  stale: false,
}];

const verdict = evaluateTransaction(intent, {
  simulationSucceeded: true,
  approvalIsUnlimited: false,
  effectRecipientMatches: true,
  knownAttackSignature: false,
  payloadInspection: { status: "PASS", confidence: 1 },
  counterparty: {
    identityResolved: true,
    highValue: false,
    knownVendorAddressChanged: false,
  },
  counterpartyAnomalyScore: 0,
  spendPolicy: {
    killSwitchActive: false,
    drainDetected: false,
    amountUsd: 1,
    rollingDailySpendUsd: 0,
    perTransactionCapUsd: 100,
    dailyCapUsd: 500,
  },
}, evidence);

describe("Evidence Seal attestation", () => {
  it("signs and independently verifies the complete receipt", async () => {
    const seal = await attestSeal(createEvidenceSeal(intent, verdict), {
      NODE_ENV: "test",
      ANCHOR_ISSUER_PRIVATE_KEY:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
    });
    await expect(verifySealRecord({ seal, intent, verdict })).resolves.toMatchObject({
      valid: true,
      checks: { digests: true, attestation: true },
    });
    await expect(verifySealRecord({
      seal,
      intent: { ...intent, declaredPurpose: "Tampered purpose" },
      verdict,
    })).resolves.toMatchObject({ valid: false, checks: { digests: false } });
  });
});
