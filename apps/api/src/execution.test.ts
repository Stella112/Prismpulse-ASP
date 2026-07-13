import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedSwapExecutor, ExecutionJournal, type CommandResult, type CommandRunner, type ExecutionPolicy } from "./execution.js";

class FakeRunner implements CommandRunner {
  calls: string[][] = [];
  constructor(private readonly results: CommandResult[]) {}
  async run(args: string[]): Promise<CommandResult> {
    this.calls.push(args);
    const result = this.results.shift();
    if (!result) throw new Error("Unexpected command");
    return result;
  }
}

const token = (symbol: string, address: string, honey = false) => ({
  decimal: symbol === "USDT" ? "6" : "18",
  isHoneyPot: honey,
  taxRate: "0",
  tokenContractAddress: address,
  tokenSymbol: symbol,
  tokenUnitPrice: symbol === "USDT" ? "1" : "80",
});
const quote = (impact = "0.21", honey = false): CommandResult => ({
  exitCode: 0,
  output: {
    ok: true,
    data: [{
      chainIndex: "196",
      dexRouterList: [{
        dexProtocol: { dexName: "VerifiedDex", percent: "100" },
        fromToken: token("USDT", "0x779ded0c9e1022225f8e0630b35a9b54be713736"),
        toToken: token("OKB", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", honey),
      }],
      estimateGasFee: "0",
      fromToken: token("USDT", "0x779ded0c9e1022225f8e0630b35a9b54be713736"),
      fromTokenAmount: "1000000",
      priceImpactPercent: impact,
      quoteId: "quote-196",
      toToken: token("OKB", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", honey),
      toTokenAmount: "12500000000000000",
      tradeFee: "0.001",
    }],
  },
});
const success = (txHash: string): CommandResult => ({ exitCode: 0, output: { ok: true, data: { swapTxHash: txHash } } });
const request = {
  from: "usdt",
  to: "okb",
  readableAmount: "1",
  wallet: "0x1111111111111111111111111111111111111111",
  declaredUsdValue: 1,
  purpose: "Bounded GasVault refill",
};
const basePolicy: ExecutionPolicy = {
  enabled: true,
  silentModeOptIn: false,
  killSwitchActive: false,
  perTradeCapUsd: 5,
  dailyCapUsd: 10,
  rollingDailyUsd: 0,
  maxPriceImpactPercent: 1,
  maxQuoteAgeMs: 10_000,
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function setup(results: CommandResult[], policy = basePolicy, now = new Date("2026-07-13T00:00:00.000Z")) {
  const directory = await mkdtemp(join(tmpdir(), "prismpulse-execution-"));
  directories.push(directory);
  const runner = new FakeRunner(results);
  const executor = new BoundedSwapExecutor(runner, policy, new ExecutionJournal(join(directory, "audit.jsonl")), () => now);
  return { runner, executor };
}

describe("BoundedSwapExecutor", () => {
  it("blocks honeypots, excessive impact, and spend-cap breaches before execution", async () => {
    const { runner, executor } = await setup([quote("6", true)], { ...basePolicy, perTradeCapUsd: 0.5 });
    const plan = await executor.plan(request);
    expect(plan.blockedReasons).toEqual(expect.arrayContaining([
      "PER_TRADE_CAP_EXCEEDED", "HONEYPOT_DETECTED", "PRICE_IMPACT_EXCEEDED",
    ]));
    const outcome = await executor.execute(plan);
    expect(outcome.state).toBe("BLOCKED");
    expect(runner.calls).toHaveLength(1);
  });

  it("micro-proves before broadcasting the bounded full swap", async () => {
    const { runner, executor } = await setup([quote(), success("0xprobe"), success("0xswap")]);
    const outcome = await executor.execute(await executor.plan(request));
    expect(outcome.state).toBe("BROADCAST");
    expect(runner.calls).toHaveLength(3);
    expect(runner.calls[1]).toEqual(expect.arrayContaining(["--from", "okb", "--readable-amount", "0.001"]));
    expect(runner.calls[2]).toEqual(expect.arrayContaining(["--from", "usdt", "--readable-amount", "1"]));
  });

  it("does not broadcast the full swap when the probe fails", async () => {
    const { runner, executor } = await setup([quote(), { exitCode: 1, output: { message: "probe reverted" } }]);
    const outcome = await executor.execute(await executor.plan(request));
    expect(outcome.state).toBe("FAILED");
    expect(runner.calls).toHaveLength(2);
  });

  it("never forces a block-level confirmation even in silent mode", async () => {
    const confirming = { exitCode: 2, output: { message: "Critical risk: potential fund loss from honeypot" } };
    const { runner, executor } = await setup([quote(), confirming], { ...basePolicy, silentModeOptIn: true });
    const outcome = await executor.execute(await executor.plan(request));
    expect(outcome.state).toBe("CONFIRMATION_REQUIRED");
    expect(runner.calls.every((args) => !args.includes("--force"))).toBe(true);
  });

  it("uses prior silent-mode opt-in only after a non-risk confirmation response", async () => {
    const confirm = { exitCode: 2, output: { message: "Confirm bounded swap" } };
    const { runner, executor } = await setup([
      quote(), confirm, success("0xprobe"), confirm, success("0xswap"),
    ], { ...basePolicy, silentModeOptIn: true });
    const outcome = await executor.execute(await executor.plan(request));
    expect(outcome.state).toBe("BROADCAST");
    expect(runner.calls[2]).toContain("--force");
    expect(runner.calls[4]).toContain("--force");
  });

  it("blocks an expired quote without invoking execution", async () => {
    const plannedAt = new Date("2026-07-13T00:00:00.000Z");
    const { runner, executor } = await setup([quote()], basePolicy, plannedAt);
    const plan = await executor.plan(request);
    const lateDirectory = await mkdtemp(join(tmpdir(), "prismpulse-late-"));
    directories.push(lateDirectory);
    const lateExecutor = new BoundedSwapExecutor(runner, basePolicy, new ExecutionJournal(join(lateDirectory, "audit.jsonl")), () => new Date("2026-07-13T00:00:11.000Z"));
    const outcome = await lateExecutor.execute(plan);
    expect(outcome.state).toBe("BLOCKED");
    expect(outcome.reasons).toContain("QUOTE_EXPIRED");
    expect(runner.calls).toHaveLength(1);
  });
});