import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RequestHandler } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import {
  buildDeterministicMarketAdvice,
  createMarketNarrativeReasoner,
  MarketAdviceService,
  MarketDataUnavailableError,
  normalizeMarketAdviceRequest,
  OkxMarketDataProvider,
  type MarketAdvice,
  type MarketAdviceRequest,
  type MarketSnapshot,
} from "./market-advice.js";

const input: MarketAdviceRequest = {
  chainId: 196,
  tokenContractAddress: "0x2222222222222222222222222222222222222222",
  horizon: "1h",
  riskMode: "balanced",
};

const snapshot: MarketSnapshot = {
  observedAt: "2026-07-15T00:00:00.000Z",
  price: 1.2,
  marketCap: 2_000_000,
  liquidity: 250_000,
  holders: 2_500,
  candles: [
    { timestamp: 1, close: 1, volumeUsd: 10_000 },
    { timestamp: 2, close: 1.05, volumeUsd: 12_000 },
    { timestamp: 3, close: 1.1, volumeUsd: 18_000 },
    { timestamp: 4, close: 1.2, volumeUsd: 22_000 },
  ],
  tags: [],
  riskControlLevel: 1,
  top10HoldPercent: 30,
  smartMoneySignals: [{ amountUsd: 5_000 }, { amountUsd: 7_000 }],
  unavailableSources: [],
};

const reasoning = {
  summary: "Momentum and volume are rising while deterministic safety checks pass.",
  catalysts: ["Positive momentum"],
  risks: ["Volatility"],
  model: "llama3.2:1b",
  status: "READY" as const,
};

function adviceFor(source: MarketSnapshot = snapshot): MarketAdvice {
  return {
    ...buildDeterministicMarketAdvice(input, source),
    reasoning,
  };
}

describe("market advice analysis", () => {
  it("normalizes marketplace wrappers and applies safe defaults", () => {
    expect(
      normalizeMarketAdviceRequest({
        task: { tokenAddress: input.tokenContractAddress },
      }),
    ).toEqual({
      chainId: 196,
      tokenContractAddress: input.tokenContractAddress,
      horizon: "1h",
      riskMode: "balanced",
    });
  });

  it("returns bounded bullish advice from positive evidence", () => {
    const result = buildDeterministicMarketAdvice(input, snapshot);
    expect(result.prediction).toBe("BULLISH");
    expect(result.action).toBe("CONSIDER_ENTRY");
    expect(result.confidence).toBeLessThanOrEqual(0.9);
    expect(result.disclaimer).toContain("not a profit guarantee");
  });

  it("hard-blocks a honeypot even when momentum is positive", () => {
    const result = buildDeterministicMarketAdvice(input, {
      ...snapshot,
      tags: ["honeypot"],
    });
    expect(result.prediction).toBe("RISK_BLOCKED");
    expect(result.action).toBe("AVOID");
    expect(result.safety.reasons).toContain("HONEYPOT_TAG");
  });

  it("hard-blocks extreme holder concentration", () => {
    const result = buildDeterministicMarketAdvice(input, {
      ...snapshot,
      top10HoldPercent: 95,
    });
    expect(result.safety.blocked).toBe(true);
    expect(result.action).toBe("AVOID");
  });

  it("does not let the narrative reasoner override the deterministic action", async () => {
    const service = new MarketAdviceService(
      { collect: async () => ({ ...snapshot, tags: ["honeypot"] }) },
      {
        explain: async () => ({
          summary: "Buy immediately",
          catalysts: ["Narrative claim"],
          risks: [],
          model: "test",
          status: "READY",
        }),
      },
    );
    const result = await service.analyze(input);
    expect(result.action).toBe("AVOID");
    expect(result.prediction).toBe("RISK_BLOCKED");
  });
});

describe("local market narrative reasoner", () => {
  it("accepts a substantive evidence explanation", async () => {
    const summary =
      "The deterministic prediction is BULLISH with action CONSIDER_ENTRY, supported by 12.5% momentum.";
    const reasoner = createMarketNarrativeReasoner(
      { OLLAMA_MODEL: "llama3.2:1b", OLLAMA_BASE_URL: "http://ollama:11434" },
      (async () =>
        Response.json({
          response: JSON.stringify({
            summary,
            catalysts: ["Momentum is positive"],
            risks: ["Volatility can reverse"],
          }),
        })) as typeof fetch,
    );
    await expect(reasoner.explain({})).resolves.toMatchObject({
      summary,
      status: "READY",
    });
  });

  it("rejects an unhelpfully terse model response", async () => {
    const reasoner = createMarketNarrativeReasoner(
      { OLLAMA_MODEL: "llama3.2:1b", OLLAMA_BASE_URL: "http://ollama:11434" },
      (async () =>
        Response.json({
          response: JSON.stringify({
            summary: "BULLISH",
            catalysts: ["Up"],
            risks: ["Down"],
          }),
        })) as typeof fetch,
    );
    const result = await reasoner.explain({
      prediction: "BULLISH",
      action: "CONSIDER_ENTRY",
      score: 20,
      confidence: 0.8,
      metrics: {
        momentumPercent: 12.5,
        volatilityPercent: 2,
        volumeTrendRatio: 1.5,
        liquidityUsd: 250_000,
        smartMoneySignalCount: 2,
      },
      safety: { reasons: [] },
    });
    expect(result.status).toBe("FALLBACK");
    expect(result.summary).toContain("BULLISH");
    expect(result.summary).toContain("CONSIDER_ENTRY");
    expect(result.risks.join(" ")).toContain("quality contract");
  });
});

describe("OKX market provider", () => {
  it("uses authenticated v6 endpoints and tolerates optional signal failure", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = value.toString();
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.includes("/price-info")) {
        return Response.json({
          code: "0",
          data: [{ price: "1", marketCap: "1000000", liquidity: "100000", holders: "500" }],
        });
      }
      if (url.includes("/candles")) {
        return Response.json({
          code: "0",
          data: [
            ["1", "1", "1", "1", "1", "1", "100", "1"],
            ["2", "1", "1", "1", "1.1", "1", "120", "1"],
            ["3", "1", "1", "1", "1.2", "1", "150", "1"],
          ],
        });
      }
      if (url.includes("/advanced-info")) {
        return Response.json({
          code: "0",
          data: [{ tokenTags: [], riskControlLevel: null, top10HoldPercent: "" }],
        });
      }
      return Response.json({ code: "50011", msg: "optional signal unavailable" });
    });
    const provider = new OkxMarketDataProvider(
      {
        OKX_API_KEY: "key",
        OKX_SECRET_KEY: "secret",
        OKX_PASSPHRASE: "pass",
        OKX_BASE_URL: "https://web3.okx.com",
      },
      fetchImpl as typeof fetch,
    );
    const result = await provider.collect(input);
    expect(result.price).toBe(1);
    expect(result.riskControlLevel).toBeNull();
    expect(result.top10HoldPercent).toBeNull();
    expect(result.unavailableSources).toContain("smart-money-signals");
    expect(calls.some((call) => call.url.includes("/api/v6/dex/market/price-info"))).toBe(true);
    expect(calls.every((call) => Boolean(call.headers.get("OK-ACCESS-SIGN")))).toBe(true);
    expect(calls.every((call) => !call.headers.has("OKX_SECRET_KEY"))).toBe(true);
  });

  it("fails when required price evidence is unavailable", async () => {
    const provider = new OkxMarketDataProvider(
      {
        OKX_API_KEY: "key",
        OKX_SECRET_KEY: "secret",
        OKX_PASSPHRASE: "pass",
      },
      (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    );
    await expect(provider.collect(input)).rejects.toBeInstanceOf(MarketDataUnavailableError);
  });
});

let server: Server | undefined;
const originalNodeEnv = process.env.NODE_ENV;
const originalPaymentsEnabled = process.env.PAYMENTS_ENABLED;

afterEach(() => {
  server?.close();
  server = undefined;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalPaymentsEnabled === undefined) delete process.env.PAYMENTS_ENABLED;
  else process.env.PAYMENTS_ENABLED = originalPaymentsEnabled;
});

async function callMarket(
  marketAdvice: { analyze: ReturnType<typeof vi.fn> },
  paymentMiddleware: RequestHandler,
  body: unknown,
  signed = false,
) {
  process.env.NODE_ENV = "test";
  process.env.PAYMENTS_ENABLED = "false";
  const app = createApp({
    marketAdvice,
    paymentGate: { enabled: true, middleware: paymentMiddleware },
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return fetch("http://127.0.0.1:" + port + "/v1/market/advice", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signed ? { "payment-signature": "present-for-test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/market/advice payment ordering", () => {
  it("returns 402 for valid unsigned discovery without calling market data", async () => {
    const analyze = vi.fn(async () => adviceFor());
    const response = await callMarket(
      { analyze },
      (_request, response) => response.status(402).json({ error: "PAYMENT_REQUIRED" }),
      { market: input },
    );
    expect(response.status).toBe(402);
    expect(analyze).not.toHaveBeenCalled();
  });

  it("rejects malformed unsigned requests before returning a payment quote", async () => {
    const analyze = vi.fn(async () => adviceFor());
    let paymentReached = false;
    const response = await callMarket(
      { analyze },
      (_request, response) => {
        paymentReached = true;
        response.status(402).end();
      },
      { market: { horizon: "1h" } },
    );
    const body = (await response.json()) as { required: string[]; message: string };
    expect(response.status).toBe(400);
    expect(paymentReached).toBe(false);
    expect(analyze).not.toHaveBeenCalled();
    expect(body.required).toContain("market.tokenContractAddress");
    expect(body.message).toContain("No payment was processed");
  });

  it("rejects malformed signed replays before payment middleware", async () => {
    const analyze = vi.fn(async () => adviceFor());
    let paymentReached = false;
    const response = await callMarket(
      { analyze },
      (_request, response) => {
        paymentReached = true;
        response.status(500).end();
      },
      { market: { chainId: 196 } },
      true,
    );
    const body = (await response.json()) as { required: string[]; message: string };
    expect(response.status).toBe(400);
    expect(paymentReached).toBe(false);
    expect(analyze).not.toHaveBeenCalled();
    expect(body.required).toContain("market.tokenContractAddress");
    expect(body.message).toContain("No payment was processed");
  });

  it("prefetches evidence before settlement and returns the prefetched advice", async () => {
    const advice = adviceFor();
    const analyze = vi.fn(async () => advice);
    let paymentReached = false;
    const response = await callMarket(
      { analyze },
      (_request, _response, next) => {
        paymentReached = true;
        next();
      },
      { input: { tokenAddress: input.tokenContractAddress } },
      true,
    );
    expect(response.status).toBe(201);
    expect(paymentReached).toBe(true);
    expect(analyze).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      tokenContractAddress: input.tokenContractAddress,
      prediction: advice.prediction,
      action: advice.action,
    });
  });

  it("fails before settlement when upstream market evidence is unavailable", async () => {
    const analyze = vi.fn(async () => {
      throw new MarketDataUnavailableError("upstream unavailable");
    });
    let paymentReached = false;
    const response = await callMarket(
      { analyze },
      (_request, _response, next) => {
        paymentReached = true;
        next();
      },
      { market: input },
      true,
    );
    const body = (await response.json()) as { message: string };
    expect(response.status).toBe(503);
    expect(paymentReached).toBe(false);
    expect(body.message).toContain("No payment was processed");
  });
});
