import { z } from "zod";
import { BoundedSwapExecutor, ExecutionJournal, type CommandRunner, type ExecutionOutcome } from "./execution.js";

const balanceSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    details: z.array(z.object({
      tokenAssets: z.array(z.object({
        balance: z.string(),
        chainIndex: z.literal("196"),
        decimal: z.string(),
        rawBalance: z.string(),
        symbol: z.string(),
        tokenAddress: z.string(),
        tokenName: z.string(),
        tokenPrice: z.string(),
        usdValue: z.string(),
      })),
    })),
    totalValueUsd: z.string(),
  }),
});

export interface GasVaultConfig {
  wallet: string;
  operationalRecipient: string;
  minimumOkb: number;
  targetOkb: number;
  agentReserveOkb: number;
  minimumStableReserveUsd: number;
  maxRefillUsd: number;
  silentModeOptIn: boolean;
}

export interface GasVaultSnapshot {
  okb: number;
  okbPriceUsd: number;
  stable: number;
  stablePriceUsd: number;
  state: "HEALTHY" | "REFILL_REQUIRED" | "BLOCKED";
  reason?: string;
}

export class GasVault {
  constructor(
    private readonly runner: CommandRunner,
    private readonly executor: BoundedSwapExecutor,
    private readonly journal: ExecutionJournal,
    private readonly config: GasVaultConfig,
  ) {}

  async assess(): Promise<GasVaultSnapshot> {
    const result = await this.runner.run(["wallet", "balance", "--chain", "xlayer"]);
    if (result.exitCode !== 0) {
      return { okb: 0, okbPriceUsd: 0, stable: 0, stablePriceUsd: 0, state: "BLOCKED", reason: "BALANCE_UNAVAILABLE" };
    }
    const assets = balanceSchema.parse(result.output).data.details.flatMap((detail) => detail.tokenAssets);
    const okb = assets.find((asset) => asset.symbol.toUpperCase() === "OKB" && asset.tokenAddress === "");
    const stable = assets.find((asset) => asset.tokenAddress.toLowerCase() === "0x779ded0c9e1022225f8e0630b35a9b54be713736");
    if (!okb || !stable) {
      return { okb: Number(okb?.balance ?? 0), okbPriceUsd: Number(okb?.tokenPrice ?? 0), stable: Number(stable?.balance ?? 0), stablePriceUsd: Number(stable?.tokenPrice ?? 0), state: "BLOCKED", reason: "REQUIRED_ASSET_MISSING" };
    }
    const snapshot: GasVaultSnapshot = {
      okb: Number(okb.balance),
      okbPriceUsd: Number(okb.tokenPrice),
      stable: Number(stable.balance),
      stablePriceUsd: Number(stable.tokenPrice),
      state: Number(okb.balance) >= this.config.minimumOkb ? "HEALTHY" : "REFILL_REQUIRED",
    };
    await this.journal.append({ kind: "GASVAULT_ASSESSED", snapshot });
    return snapshot;
  }

  async refill(): Promise<{ snapshot: GasVaultSnapshot; outcome?: ExecutionOutcome; reason?: string }> {
    const snapshot = await this.assess();
    if (snapshot.state !== "REFILL_REQUIRED") {
      return snapshot.reason ? { snapshot, reason: snapshot.reason } : { snapshot };
    }
    if (snapshot.okbPriceUsd <= 0 || snapshot.stablePriceUsd <= 0) {
      return { snapshot: { ...snapshot, state: "BLOCKED", reason: "PRICE_UNAVAILABLE" }, reason: "PRICE_UNAVAILABLE" };
    }
    const stableAvailableUsd = snapshot.stable * snapshot.stablePriceUsd - this.config.minimumStableReserveUsd;
    const targetUsd = Math.max(0, this.config.targetOkb - snapshot.okb) * snapshot.okbPriceUsd;
    const refillUsd = Math.min(stableAvailableUsd, targetUsd, this.config.maxRefillUsd);
    if (refillUsd <= 0) {
      return { snapshot: { ...snapshot, state: "BLOCKED", reason: "STABLE_RESERVE_TOO_LOW" }, reason: "STABLE_RESERVE_TOO_LOW" };
    }
    const readableAmount = (refillUsd / snapshot.stablePriceUsd).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    const plan = await this.executor.plan({
      from: "usdt",
      to: "okb",
      readableAmount,
      wallet: this.config.wallet,
      declaredUsdValue: refillUsd,
      purpose: "Bounded GasVault refill for PrismPulse operations",
    });
    const outcome = await this.executor.execute(plan);
    await this.journal.append({ kind: "GASVAULT_REFILL", snapshot, outcome });
    return { snapshot, outcome };
  }

  async forwardAvailableOkb(): Promise<{ state: "NO_ACTION" | "CONFIRMATION_REQUIRED" | "BROADCAST" | "FAILED"; amountOkb: number; output?: unknown }> {
    const snapshot = await this.assess();
    const amountOkb = Math.max(0, snapshot.okb - this.config.agentReserveOkb);
    if (snapshot.state === "BLOCKED" || amountOkb <= 0) return { state: "NO_ACTION", amountOkb: 0 };
    const args = [
      "wallet", "send", "--recipient", this.config.operationalRecipient,
      "--chain", "xlayer", "--readable-amount", String(Number(amountOkb.toFixed(8))),
      "--from", this.config.wallet,
    ];
    let result = await this.runner.run(args);
    const message = result.output && typeof result.output === "object" && "message" in result.output
      ? String((result.output as { message?: unknown }).message ?? "") : "";
    const blockLevel = /critical risk|fund loss|blacklisted|simulation failed/i.test(message);
    if (result.exitCode === 2 && this.config.silentModeOptIn && !blockLevel) {
      result = await this.runner.run([...args, "--force"]);
    }
    const state = result.exitCode === 0 ? "BROADCAST" : result.exitCode === 2 ? "CONFIRMATION_REQUIRED" : "FAILED";
    await this.journal.append({ kind: "GASVAULT_FORWARD", state, amountOkb, output: result.output });
    return { state, amountOkb, output: result.output };
  }
}