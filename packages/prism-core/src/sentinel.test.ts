import { describe, expect, it } from "vitest";
import { evaluateTransaction } from "./sentinel.js";

const intent = {
  chainId: 196 as const,
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  value: "0",
  data: "0x",
  declaredPurpose: "Pay a verified service provider",
  expectedRecipient: "0x2222222222222222222222222222222222222222",
};

describe("evaluateTransaction", () => {
  it("blocks a recipient mismatch", () => {
    const verdict = evaluateTransaction(
      {
        ...intent,
        expectedRecipient: "0x3333333333333333333333333333333333333333",
      },
      {
        simulationSucceeded: true,
        approvalIsUnlimited: false,
        knownAttackSignature: false,
      },
      [
        {
          id: "rpc-1",
          kind: "rpc",
          source: "https://rpc.xlayer.tech",
          observedAt: new Date().toISOString(),
          value: { chainId: 196 },
          confidence: 1,
          verified: true,
          stale: false,
        },
      ],
    );

    expect(verdict.verdict).toBe("BLOCK");
    expect(verdict.reasonCodes).toContain("RECIPIENT_MISMATCH");
  });

  it("allows a clean, evidenced intent", () => {
    const verdict = evaluateTransaction(
      intent,
      {
        simulationSucceeded: true,
        approvalIsUnlimited: false,
        knownAttackSignature: false,
        contractVerified: true,
      },
      [
        {
          id: "simulation-1",
          kind: "simulation",
          source: "https://rpc.xlayer.tech",
          observedAt: new Date().toISOString(),
          value: { success: true },
          confidence: 1,
          verified: true,
          stale: false,
        },
      ],
    );

    expect(verdict.verdict).toBe("ALLOW");
    expect(verdict.score).toBe(0);
  });

  it("warns when Hive signature scanning is unavailable", () => {
    const verdict = evaluateTransaction(
      intent,
      {
        simulationSucceeded: true,
        approvalIsUnlimited: false,
      },
      [
        {
          id: "simulation-2",
          kind: "simulation",
          source: "https://rpc.xlayer.tech",
          observedAt: new Date().toISOString(),
          value: { success: true },
          confidence: 1,
          verified: true,
          stale: false,
        },
      ],
    );

    expect(verdict.verdict).toBe("WARN");
    expect(verdict.reasonCodes).toContain("SIGNATURE_SCAN_UNAVAILABLE");
  });
});
