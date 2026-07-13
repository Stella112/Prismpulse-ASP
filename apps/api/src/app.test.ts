import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { PulseInspection } from "./pulse.js";
import { MemoryEvidenceSealStore } from "./seals.js";

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
const originalConsoleIssuanceEnabled = process.env.CONSOLE_ISSUANCE_ENABLED;

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
  if (originalConsoleIssuanceEnabled === undefined) {
    delete process.env.CONSOLE_ISSUANCE_ENABLED;
  } else {
    process.env.CONSOLE_ISSUANCE_ENABLED = originalConsoleIssuanceEnabled;
  }
});

async function request(
  path: string,
  options: RequestInit = {},
  sealStore = new MemoryEvidenceSealStore(),
): Promise<Response> {
  server = createApp({ collectEvidence: async () => inspection, sealStore }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return fetch(`http://127.0.0.1:${port}${path}`, options);
}

async function post(
  path: string,
  body: unknown,
  sealStore?: MemoryEvidenceSealStore,
): Promise<Response> {
  return request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    sealStore,
  );
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

    expect(response.status).toBe(201);
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

describe("Evidence Seal persistence and retrieval", () => {
  it("retrieves a persisted decision by its digest", async () => {
    process.env.NODE_ENV = "test";
    process.env.PAYMENTS_ENABLED = "false";
    const store = new MemoryEvidenceSealStore();
    const issued = await post("/v1/sentinel/check", validRequest, store);
    const issuedBody = (await issued.json()) as {
      seal: { decisionDigest: string };
    };
    server?.close();
    server = undefined;

    const response = await request(
      `/v1/seals/${issuedBody.seal.decisionDigest}`,
      {},
      store,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=30");
    await expect(response.json()).resolves.toMatchObject({
      seal: { decisionDigest: issuedBody.seal.decisionDigest, verdict: "ALLOW" },
      verdict: { verdict: "ALLOW" },
      intent: validRequest.intent,
      anchoring: { state: "NOT_CONFIGURED" },
    });
  });

  it("returns 404 for a well-formed unknown digest", async () => {
    const response = await request(`/v1/seals/0x${"0".repeat(64)}`);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "SEAL_NOT_FOUND" });
  });

  it("rejects malformed digest lookups", async () => {
    const response = await request("/v1/seals/not-a-digest");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "INVALID_DIGEST" });
  });

  it("does not issue a seal when persistence fails", async () => {
    const store = new MemoryEvidenceSealStore();
    store.save = async () => {
      throw new Error("database offline");
    };
    const response = await post("/v1/sentinel/check", validRequest, store);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "SEAL_PERSISTENCE_FAILED",
    });
  });
});

describe("POST /v1/console/seals", () => {
  it("issues a persisted, shareable Seal from the console", async () => {
    process.env.NODE_ENV = "production";
    process.env.PAYMENTS_ENABLED = "false";
    process.env.CONSOLE_ISSUANCE_ENABLED = "true";
    const store = new MemoryEvidenceSealStore();
    const response = await post("/v1/console/seals", validRequest, store);
    const body = (await response.json()) as {
      seal: { decisionDigest: string };
      anchoring: { state: string };
    };

    expect(response.status).toBe(201);
    expect(body.seal.decisionDigest).toMatch(/^0x[a-f0-9]{64}$/);
    expect(body.anchoring.state).toBe("NOT_CONFIGURED");
    await expect(store.findByDecisionDigest(body.seal.decisionDigest)).resolves.not.toBeNull();
  });

  it("fails closed in production unless explicitly enabled", async () => {
    process.env.NODE_ENV = "production";
    process.env.PAYMENTS_ENABLED = "false";
    delete process.env.CONSOLE_ISSUANCE_ENABLED;
    const response = await post("/v1/console/seals", validRequest);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "CONSOLE_ISSUANCE_DISABLED",
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
