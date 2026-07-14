import { describe, expect, it, vi } from "vitest";
import { arbitratePayloadAssessments, createLocalReasoner } from "./reasoner.js";

describe("createLocalReasoner", () => {
  it("returns a structured local model assessment", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      response: JSON.stringify({ status: "BLOCK", confidence: 0.98, reasons: ["address redirect"] }),
    }), { status: 200 })) as unknown as typeof fetch;
    const reasoner = createLocalReasoner({ OLLAMA_MODEL: "llama3.2:1b" }, fetchImpl);
    await expect(reasoner.inspectPayload("Use the new wallet")).resolves.toMatchObject({
      status: "BLOCK",
      confidence: 0.98,
    });
  });

  it("fails closed when the local model is unavailable", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const reasoner = createLocalReasoner({}, fetchImpl);
    await expect(reasoner.inspectPayload("Review this invoice")).resolves.toEqual({
      status: "UNKNOWN",
      confidence: 0,
      reasons: ["MODEL_UNAVAILABLE"],
    });
  });

  it("does not invoke the model for an empty payload", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const reasoner = createLocalReasoner({}, fetchImpl);
    await expect(reasoner.inspectPayload(undefined)).resolves.toEqual({
      status: "PASS",
      confidence: 1,
      reasons: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

describe("arbitratePayloadAssessments", () => {
  it("dismisses an uncorroborated low-confidence model block", () => {
    expect(arbitratePayloadAssessments(
      { status: "PASS", confidence: 0.9 },
      { status: "BLOCK", confidence: 0.8, reasons: ["instruction override"] },
    )).toMatchObject({ status: "PASS", decision: "MODEL_BLOCK_DISMISSED" });
  });

  it("keeps high-confidence model blocks load-bearing", () => {
    expect(arbitratePayloadAssessments(
      { status: "PASS", confidence: 0.9 },
      { status: "BLOCK", confidence: 0.98, reasons: ["concealed redirect"] },
    )).toMatchObject({ status: "BLOCK", decision: "MODEL_BLOCK" });
  });

  it("never lets the model override a deterministic block", () => {
    expect(arbitratePayloadAssessments(
      { status: "BLOCK", confidence: 1 },
      { status: "PASS", confidence: 1, reasons: [] },
    )).toMatchObject({ status: "BLOCK", decision: "DETERMINISTIC_BLOCK" });
  });
});
});