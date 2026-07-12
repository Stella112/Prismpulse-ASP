import { describe, expect, it } from "vitest";
import type { TransactionIntent } from "@prismpulse/schemas";
import { collectXLayerEvidence, EvidenceUnavailableError } from "./pulse.js";

const intent: TransactionIntent = {
  chainId: 196,
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  value: "0",
  data: "0x",
  declaredPurpose: "Inspect a proposed X Layer transaction",
};

function rpcFetch(
  overrides: Record<string, { result?: unknown; error?: { code: number; message: string } }> = {},
): typeof fetch {
  return (async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { method: string };
    const defaults: Record<string, { result: unknown }> = {
      eth_chainId: { result: "0xc4" },
      eth_blockNumber: { result: "0x7b" },
      eth_getCode: { result: "0x60006000" },
      eth_call: { result: "0x" },
    };

    return Response.json({
      jsonrpc: "2.0",
      id: request.method,
      ...(overrides[request.method] ??
        defaults[request.method] ?? { error: { code: -32601, message: "Unknown method" } }),
    });
  }) as typeof fetch;
}

describe("collectXLayerEvidence", () => {
  it("collects chain, contract, and simulation evidence from X Layer", async () => {
    const result = await collectXLayerEvidence(intent, {
      fetchImpl: rpcFetch(),
      now: () => new Date("2026-07-12T00:00:00.000Z"),
    });

    expect(result.blockNumber).toBe("123");
    expect(result.signals.simulationSucceeded).toBe(true);
    expect(result.signals.knownAttackSignature).toBeUndefined();
    expect(result.evidence).toHaveLength(4);
    expect(result.evidence[1]?.value).toEqual({
      hasBytecode: true,
      byteLength: 4,
    });
  });

  it("detects an unlimited ERC-20 approval from calldata", async () => {
    const approvalIntent: TransactionIntent = {
      ...intent,
      data: `0x095ea7b3${"0".repeat(24)}${"3".repeat(40)}${"f".repeat(64)}`,
    };

    const result = await collectXLayerEvidence(approvalIntent, {
      fetchImpl: rpcFetch(),
    });

    expect(result.signals.approvalIsUnlimited).toBe(true);
  });

  it("records an RPC simulation revert as a failed simulation", async () => {
    const result = await collectXLayerEvidence(intent, {
      fetchImpl: rpcFetch({
        eth_call: { error: { code: -32000, message: "execution reverted" } },
      }),
    });

    expect(result.signals.simulationSucceeded).toBe(false);
    expect(result.evidence[2]?.value).toMatchObject({
      success: false,
      error: "execution reverted",
    });
  });

  it("rejects evidence returned from the wrong chain", async () => {
    await expect(
      collectXLayerEvidence(intent, {
        fetchImpl: rpcFetch({ eth_chainId: { result: "0x1" } }),
      }),
    ).rejects.toBeInstanceOf(EvidenceUnavailableError);
  });
});
