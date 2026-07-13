import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedSwapExecutor, ExecutionJournal, type CommandResult, type CommandRunner, type ExecutionPolicy } from "./execution.js";
import { GasVault, type GasVaultConfig } from "./gas-vault.js";

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

const balance = (okb: string, stable: string): CommandResult => ({
  exitCode: 0,
  output: { ok: true, data: { details: [{ tokenAssets: [
    { balance: okb, chainIndex: "196", decimal: "18", rawBalance: "1", symbol: "OKB", tokenAddress: "", tokenName: "X Layer", tokenPrice: "80", usdValue: String(Number(okb) * 80) },
    { balance: stable, chainIndex: "196", decimal: "6", rawBalance: "1", symbol: "USD?0", tokenAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736", tokenName: "USD?0", tokenPrice: "1", usdValue: stable },
  ] }], totalValueUsd: "1" } },
});
const quote: CommandResult = {
  exitCode: 0,
  output: { ok: true, data: [{
    chainIndex: "196",
    dexRouterList: [{ dexProtocol: { dexName: "VerifiedDex", percent: "100" }, fromToken: { decimal: "6", isHoneyPot: false, taxRate: "0", tokenContractAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736", tokenSymbol: "USDT", tokenUnitPrice: "1" }, toToken: { decimal: "18", isHoneyPot: false, taxRate: "0", tokenContractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", tokenSymbol: "OKB", tokenUnitPrice: "80" } }],
    estimateGasFee: "0", fromToken: { decimal: "6", isHoneyPot: false, taxRate: "0", tokenContractAddress: "0x779ded0c9e1022225f8e0630b35a9b54be713736", tokenSymbol: "USDT", tokenUnitPrice: "1" }, fromTokenAmount: "100000", priceImpactPercent: "0.2", quoteId: "gas-quote", toToken: { decimal: "18", isHoneyPot: false, taxRate: "0", tokenContractAddress: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", tokenSymbol: "OKB", tokenUnitPrice: "80" }, toTokenAmount: "1250000000000000", tradeFee: "0.001",
  }] },
};
const success = (hash: string): CommandResult => ({ exitCode: 0, output: { ok: true, data: { swapTxHash: hash } } });
const policy: ExecutionPolicy = { enabled: true, silentModeOptIn: true, killSwitchActive: false, perTradeCapUsd: 2, dailyCapUsd: 5, rollingDailyUsd: 0, maxPriceImpactPercent: 1, maxQuoteAgeMs: 10_000 };
const config: GasVaultConfig = {
  wallet: "0x1111111111111111111111111111111111111111",
  operationalRecipient: "0x2222222222222222222222222222222222222222",
  minimumOkb: 0.005,
  targetOkb: 0.02,
  agentReserveOkb: 0.001,
  minimumStableReserveUsd: 0.01,
  maxRefillUsd: 2,
  silentModeOptIn: true,
};
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function setup(results: CommandResult[], customConfig = config) {
  const directory = await mkdtemp(join(tmpdir(), "prismpulse-gasvault-"));
  directories.push(directory);
  const runner = new FakeRunner(results);
  const journal = new ExecutionJournal(join(directory, "audit.jsonl"));
  const executor = new BoundedSwapExecutor(runner, policy, journal, () => new Date("2026-07-13T00:00:00.000Z"));
  return { runner, vault: new GasVault(runner, executor, journal, customConfig) };
}

describe("GasVault", () => {
  it("takes no action while OKB is above the threshold", async () => {
    const { runner, vault } = await setup([balance("0.01", "1")]);
    const result = await vault.refill();
    expect(result.snapshot.state).toBe("HEALTHY");
    expect(result.outcome).toBeUndefined();
    expect(runner.calls).toHaveLength(1);
  });

  it("fails closed when stable reserves cannot fund a refill", async () => {
    const { runner, vault } = await setup([balance("0.001", "0.005")]);
    const result = await vault.refill();
    expect(result.reason).toBe("STABLE_RESERVE_TOO_LOW");
    expect(runner.calls).toHaveLength(1);
  });

  it("routes a low-balance refill through quote, micro-probe, and bounded swap", async () => {
    const { runner, vault } = await setup([balance("0.001", "2"), quote, success("0xprobe"), success("0xswap")]);
    const result = await vault.refill();
    expect(result.outcome?.state).toBe("BROADCAST");
    expect(runner.calls[0]).toEqual(["wallet", "balance", "--chain", "xlayer"]);
    expect(runner.calls[1]).toEqual(expect.arrayContaining(["swap", "quote", "--from", "usdt", "--to", "okb"]));
  });

  it("forwards only OKB above the agent reserve and handles prior silent opt-in", async () => {
    const confirm: CommandResult = { exitCode: 2, output: { message: "Confirm bounded transfer" } };
    const sent: CommandResult = { exitCode: 0, output: { ok: true, data: { txHash: "0xforward" } } };
    const { runner, vault } = await setup([balance("0.003", "1"), confirm, sent]);
    const result = await vault.forwardAvailableOkb();
    expect(result.state).toBe("BROADCAST");
    expect(result.amountOkb).toBeCloseTo(0.002);
    expect(runner.calls[2]).toContain("--force");
    expect(runner.calls[2]).toEqual(expect.arrayContaining(["--recipient", config.operationalRecipient]));
  });
});