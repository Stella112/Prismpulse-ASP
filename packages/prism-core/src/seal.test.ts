import { describe, expect, it } from "vitest";
import type { SentinelVerdict, TransactionIntent } from "@prismpulse/schemas";
import { createEvidenceSeal } from "./seal.js";

const intent: TransactionIntent = {
  chainId: 196,
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  value: "0",
  data: "0x",
  declaredPurpose: "Pay a verified service provider",
};

const verdict: SentinelVerdict = {
  verdict: "ALLOW",
  score: 0,
  reasonCodes: [],
  summary: "No active policy violations were found in the supplied evidence.",
  evidence: [
    {
      id: "simulation-1",
      kind: "simulation",
      source: "https://rpc.xlayer.tech",
      observedAt: "2026-07-12T00:00:00.000Z",
      value: { success: true, gasUsed: "21000" },
      confidence: 1,
      verified: true,
      stale: false,
    },
  ],
  policyVersion: "sentinel-2026-07-11.1",
  createdAt: "2026-07-12T00:00:01.000Z",
};

describe("createEvidenceSeal", () => {
  it("is stable when object keys arrive in a different order", () => {
    const reordered: SentinelVerdict = {
      ...verdict,
      evidence: [
        {
          ...verdict.evidence[0]!,
          value: { gasUsed: "21000", success: true },
        },
      ],
    };

    expect(createEvidenceSeal(intent, reordered)).toEqual(
      createEvidenceSeal(intent, verdict),
    );
  });

  it("changes the receipt when material evidence changes", () => {
    const changed: SentinelVerdict = {
      ...verdict,
      evidence: [
        {
          ...verdict.evidence[0]!,
          value: { success: false, gasUsed: "21000" },
        },
      ],
    };

    const originalSeal = createEvidenceSeal(intent, verdict);
    const changedSeal = createEvidenceSeal(intent, changed);

    expect(changedSeal.evidenceDigest).not.toBe(originalSeal.evidenceDigest);
    expect(changedSeal.decisionDigest).not.toBe(originalSeal.decisionDigest);
  });
});
