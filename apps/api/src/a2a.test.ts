import { describe, expect, it } from "vitest";
import {
  A2ALifecycle,
  MemoryA2AStore,
  type A2ACommandGateway,
  type A2ACommandResult,
} from "./a2a.js";

class FakeGateway implements A2ACommandGateway {
  readonly onchainCommands: string[][] = [];
  readonly messages: string[][] = [];
  failAt?: "message" | "raise" | "confirm" | "deliver" | "next";

  async onchainOs(args: string[]): Promise<A2ACommandResult> {
    this.onchainCommands.push(args);
    const joined = args.join(" ");
    const shouldFail =
      (this.failAt === "raise" && joined.includes("dispute raise")) ||
      (this.failAt === "confirm" && joined.includes("dispute confirm")) ||
      (this.failAt === "deliver" && joined.includes("agent deliver")) ||
      (this.failAt === "next" && joined.includes("next-action"));
    return { exitCode: shouldFail ? 1 : 0, output: { ok: !shouldFail } };
  }

  async encryptedMessage(args: string[]): Promise<A2ACommandResult> {
    this.messages.push(args);
    return { exitCode: this.failAt === "message" ? 1 : 0, output: { ok: this.failAt !== "message" } };
  }
}

const terms = {
  amount: "0.01",
  tokenSymbol: "USDT" as const,
  scope: "Check a proposed X Layer transaction and issue an evidence seal.",
  deliverable: "Evidence-backed verdict and seal",
};

function setup(allowed = true) {
  const store = new MemoryA2AStore();
  const gateway = new FakeGateway();
  const lifecycle = new A2ALifecycle(
    store,
    gateway,
    {
      inspect: async () => ({
        allowed,
        evidence: ["sentinel:0xabc"],
        ...(allowed ? {} : { reason: "PROMPT_INJECTION" }),
      }),
    },
    () => new Date("2026-07-13T12:00:00.000Z"),
  );
  return { lifecycle, gateway, store };
}

async function negotiate(lifecycle: A2ALifecycle) {
  return lifecycle.negotiate({
    jobId: "job-1",
    agentId: "5168",
    counterpartyAgentId: "9001",
    terms,
  });
}

describe("A2ALifecycle", () => {
  it("sends a Sentinel-approved proposal over encrypted A2A messaging", async () => {
    const { lifecycle, gateway } = setup();
    const record = await negotiate(lifecycle);

    expect(record.stage).toBe("NEGOTIATING");
    expect(record.escrowFunded).toBe(false);
    expect(record.evidence).toEqual(["sentinel:0xabc"]);
    expect(gateway.messages[0]).toEqual(expect.arrayContaining([
      "xmtp-send",
      "--job-id",
      "job-1",
      "--to-agent-id",
      "9001",
      "--session-agent-id",
      "5168",
    ]));
  });

  it("blocks poisoned task scope before sending a proposal", async () => {
    const { lifecycle, gateway } = setup(false);
    await expect(negotiate(lifecycle)).rejects.toThrow("PROMPT_INJECTION");
    expect(gateway.messages).toHaveLength(0);
  });

  it("refuses work and delivery before job_accepted escrow confirmation", async () => {
    const { lifecycle, gateway } = setup();
    await negotiate(lifecycle);
    await expect(lifecycle.deliver("job-1", "Done")).rejects.toThrow("funded escrow");
    expect(gateway.onchainCommands).toHaveLength(0);
  });

  it("resolves official next-action and unlocks delivery only after job_accepted", async () => {
    const { lifecycle, gateway } = setup();
    await negotiate(lifecycle);
    const accepted = await lifecycle.handleSystemEvent("5168", {
      source: "system",
      event: "job_accepted",
      jobId: "job-1",
      code: 0,
    });
    const delivered = await lifecycle.deliver("job-1", "Evidence seal attached", "seal.json");

    expect(accepted?.stage).toBe("ESCROW_FUNDED");
    expect(accepted?.escrowFunded).toBe(true);
    expect(delivered.stage).toBe("DELIVERED");
    expect(gateway.onchainCommands[0]).toEqual([
      "agent", "next-action", "--role", "auto", "--agentId", "5168",
      "--message", "{\"source\":\"system\",\"event\":\"job_accepted\",\"jobId\":\"job-1\",\"code\":0}",
    ]);
    expect(gateway.onchainCommands[1]).toEqual([
      "agent", "deliver", "job-1", "--message", "Evidence seal attached",
      "--agent-id", "5168", "--file", "seal.json",
    ]);
  });

  it("rejects failed transaction events without advancing state", async () => {
    const { lifecycle, store, gateway } = setup();
    await negotiate(lifecycle);
    await expect(lifecycle.handleSystemEvent("5168", {
      source: "system",
      event: "job_accepted",
      jobId: "job-1",
      code: 1,
    })).rejects.toThrow("failed marketplace transaction");
    expect((await store.get("job-1"))?.stage).toBe("NEGOTIATING");
    expect(gateway.onchainCommands).toHaveLength(0);
  });

  it("raises and confirms a dispute only after rejection and preserves evidence", async () => {
    const { lifecycle, gateway } = setup();
    await negotiate(lifecycle);
    await lifecycle.handleSystemEvent("5168", {
      source: "system",
      event: "job_rejected",
      jobId: "job-1",
    });
    const disputed = await lifecycle.dispute("job-1", "Seal proves the requested check was delivered.", [
      "seal:0xdef",
      "tx:0x123",
    ]);

    expect(disputed.stage).toBe("DISPUTED");
    expect(disputed.evidence).toEqual(["sentinel:0xabc", "seal:0xdef", "tx:0x123"]);
    expect(gateway.onchainCommands.slice(-2)).toEqual([
      ["agent", "dispute", "raise", "job-1", "--reason", "Seal proves the requested check was delivered.", "--agent-id", "5168"],
      ["agent", "dispute", "confirm", "job-1", "--agent-id", "5168"],
    ]);
  });

  it("does not mark a dispute active when confirmation fails", async () => {
    const { lifecycle, gateway, store } = setup();
    await negotiate(lifecycle);
    await lifecycle.handleSystemEvent("5168", {
      source: "system",
      event: "job_rejected",
      jobId: "job-1",
    });
    gateway.failAt = "confirm";
    await expect(lifecycle.dispute("job-1", "Rejected incorrectly")).rejects.toThrow("confirmation failed");
    expect((await store.get("job-1"))?.stage).toBe("REJECTED");
  });

  it("mirrors terminal completion and refund events without inventing states", async () => {
    const { lifecycle } = setup();
    await negotiate(lifecycle);
    const complete = await lifecycle.handleSystemEvent("5168", {
      source: "system", event: "job_auto_completed", jobId: "job-1",
    });
    expect(complete?.stage).toBe("COMPLETED");

    const refunded = await lifecycle.handleSystemEvent("5168", {
      source: "system", event: "job_auto_refunded", jobId: "job-1",
    });
    expect(refunded?.stage).toBe("REFUNDED");
    expect(refunded?.escrowFunded).toBe(false);
  });
});
