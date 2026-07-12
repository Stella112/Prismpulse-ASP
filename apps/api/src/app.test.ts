import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { PulseInspection } from "./pulse.js";

const validRequest = {
  intent: {
    chainId: 196,
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: "0",
    data: "0x",
    declaredPurpose: "Pay a verified service provider",
  },
};

const inspection: PulseInspection = {
  blockNumber: "123",
  signals: {
    simulationSucceeded: true,
    approvalIsUnlimited: false,
    knownAttackSignature: false,
    contractVerified: true,
  },
  evidence: [
    {
      id: "simulation-1",
      kind: "simulation",
      source: "https://rpc.xlayer.tech",
      observedAt: "2026-07-12T00:00:00.000Z",
      value: { success: true },
      confidence: 1,
      verified: true,
      stale: false,
    },
  ],
};

let server: Server | undefined;
const originalNodeEnv = process.env.NODE_ENV;
const originalPaymentsEnabled = process.env.PAYMENTS_ENABLED;

afterEach(() => {
  server?.close();
  server = undefined;
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  if (originalPaymentsEnabled === undefined) {
    delete process.env.PAYMENTS_ENABLED;
  } else {
    process.env.PAYMENTS_ENABLED = originalPaymentsEnabled;
  }
});

async function post(path: string, body: unknown): Promise<Response> {
  server = createApp({ collectEvidence: async () => inspection }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/sentinel/check", () => {
  it("returns an evidence-backed verdict and seal in development", async () => {
    process.env.NODE_ENV = "test";
    process.env.PAYMENTS_ENABLED = "false";
    const response = await post("/v1/sentinel/check", validRequest);
    const body = (await response.json()) as {
      verdict: { verdict: string };
      seal: { network: string; decisionDigest: string };
    };

    expect(response.status).toBe(200);
    expect(body.verdict.verdict).toBe("ALLOW");
    expect(body.seal.network).toBe("eip155:196");
    expect(body.seal.decisionDigest).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it("rejects malformed transaction intents", async () => {
    process.env.NODE_ENV = "test";
    process.env.PAYMENTS_ENABLED = "false";
    const response = await post("/v1/sentinel/check", {
      ...validRequest,
      intent: { chainId: 1 },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "INVALID_REQUEST",
    });
  });

  it("keeps the route closed in production until payment is mounted", async () => {
    process.env.NODE_ENV = "production";
    process.env.PAYMENTS_ENABLED = "false";
    const response = await post("/v1/sentinel/check", validRequest);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "PAID_ROUTE_NOT_CONFIGURED",
    });
  });
});

describe("POST /v1/pulse/inspect", () => {
  it("returns evidence collected by the server", async () => {
    process.env.NODE_ENV = "test";
    process.env.PAYMENTS_ENABLED = "false";
    const response = await post("/v1/pulse/inspect", validRequest);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      blockNumber: "123",
      signals: { simulationSucceeded: true },
    });
  });
});
