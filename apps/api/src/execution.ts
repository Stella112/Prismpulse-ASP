import { spawn } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const tokenSchema = z.object({
  decimal: z.string(),
  isHoneyPot: z.boolean(),
  taxRate: z.string(),
  tokenContractAddress: z.string(),
  tokenSymbol: z.string(),
  tokenUnitPrice: z.string(),
});
const quoteSchema = z.object({
  ok: z.literal(true),
  data: z.array(z.object({
    chainIndex: z.literal("196"),
    dexRouterList: z.array(z.object({
      dexProtocol: z.object({ dexName: z.string(), percent: z.string() }),
      fromToken: tokenSchema,
      toToken: tokenSchema,
    })),
    estimateGasFee: z.string(),
    fromToken: tokenSchema,
    fromTokenAmount: z.string(),
    priceImpactPercent: z.string(),
    quoteId: z.string(),
    toToken: tokenSchema,
    toTokenAmount: z.string(),
    tradeFee: z.string(),
  })).min(1),
});

export interface CommandResult { exitCode: number; output: unknown; }
export interface CommandRunner { run(args: string[]): Promise<CommandResult>; }

export class OnchainOsCliRunner implements CommandRunner {
  constructor(private readonly binary = process.env.ONCHAINOS_BINARY ?? "onchainos") {}
  run(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, { shell: false, windowsHide: true, env: process.env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", reject);
      child.on("close", (code) => {
        const text = stdout.trim() || stderr.trim();
        try { resolve({ exitCode: code ?? 1, output: JSON.parse(text) }); }
        catch { resolve({ exitCode: code ?? 1, output: { ok: false, message: text } }); }
      });
    });
  }
}

export interface ExecutionPolicy {
  enabled: boolean;
  silentModeOptIn: boolean;
  killSwitchActive: boolean;
  perTradeCapUsd: number;
  dailyCapUsd: number;
  rollingDailyUsd: number;
  maxPriceImpactPercent: number;
  maxQuoteAgeMs: number;
}

export interface SwapRequest {
  from: string;
  to: string;
  readableAmount: string;
  wallet: string;
  declaredUsdValue: number;
  purpose: string;
}

export interface SwapPlan {
  request: SwapRequest;
  quoteId: string;
  quotedAt: string;
  expectedOutput: string;
  outputDecimals: number;
  priceImpactPercent: number;
  route: string[];
  blockedReasons: string[];
  warnings: string[];
}

export interface ExecutionOutcome {
  state: "BLOCKED" | "CONFIRMATION_REQUIRED" | "BROADCAST" | "FAILED";
  plan: SwapPlan;
  probe?: unknown;
  execution?: unknown;
  reasons: string[];
}

export class ExecutionJournal {
  constructor(private readonly path: string) {}
  async append(event: object): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify({ recordedAt: new Date().toISOString(), ...event }) + "\n", { mode: 0o600 });
  }
}

function asMessage(output: unknown): string {
  if (output && typeof output === "object" && "message" in output) return String((output as { message?: unknown }).message ?? "");
  return "";
}

function isBlockLevelConfirmation(output: unknown): boolean {
  return /honeypot|poison|fund loss|blacklisted|critical risk|simulation failed/i.test(asMessage(output));
}

export class BoundedSwapExecutor {
  constructor(
    private readonly runner: CommandRunner,
    private readonly policy: ExecutionPolicy,
    private readonly journal: ExecutionJournal,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async plan(request: SwapRequest): Promise<SwapPlan> {
    const blockedReasons: string[] = [];
    const warnings: string[] = [];
    if (!this.policy.enabled) blockedReasons.push("AUTONOMOUS_EXECUTION_DISABLED");
    if (this.policy.killSwitchActive) blockedReasons.push("GLOBAL_KILL_SWITCH");
    if (request.declaredUsdValue > this.policy.perTradeCapUsd) blockedReasons.push("PER_TRADE_CAP_EXCEEDED");
    if (this.policy.rollingDailyUsd + request.declaredUsdValue > this.policy.dailyCapUsd) blockedReasons.push("DAILY_CAP_EXCEEDED");

    const result = await this.runner.run([
      "swap", "quote", "--from", request.from, "--to", request.to,
      "--readable-amount", request.readableAmount, "--chain", "xlayer",
    ]);
    if (result.exitCode !== 0) throw new Error("DEX quote unavailable.");
    const quote = quoteSchema.parse(result.output).data[0]!;
    const priceImpactPercent = Number(quote.priceImpactPercent);
    const routeTokens = [quote.fromToken, quote.toToken, ...quote.dexRouterList.flatMap((hop) => [hop.fromToken, hop.toToken])];
    if (routeTokens.some((token) => token.isHoneyPot)) blockedReasons.push("HONEYPOT_DETECTED");
    if (routeTokens.some((token) => Number(token.taxRate) > 10)) warnings.push("HIGH_TOKEN_TAX");
    if (!Number.isFinite(priceImpactPercent) || priceImpactPercent > this.policy.maxPriceImpactPercent) {
      blockedReasons.push("PRICE_IMPACT_EXCEEDED");
    } else if (priceImpactPercent > 5) warnings.push("HIGH_PRICE_IMPACT");
    const plan: SwapPlan = {
      request,
      quoteId: quote.quoteId,
      quotedAt: this.now().toISOString(),
      expectedOutput: quote.toTokenAmount,
      outputDecimals: Number(quote.toToken.decimal),
      priceImpactPercent,
      route: quote.dexRouterList.map((hop) => hop.dexProtocol.dexName),
      blockedReasons,
      warnings,
    };
    await this.journal.append({ kind: "SWAP_PLANNED", plan });
    return plan;
  }

  async execute(plan: SwapPlan): Promise<ExecutionOutcome> {
    const age = this.now().getTime() - new Date(plan.quotedAt).getTime();
    const blocked = [...plan.blockedReasons];
    if (age > this.policy.maxQuoteAgeMs) blocked.push("QUOTE_EXPIRED");
    if (this.policy.killSwitchActive) blocked.push("GLOBAL_KILL_SWITCH");
    if (blocked.length > 0) {
      const outcome: ExecutionOutcome = { state: "BLOCKED", plan, reasons: [...new Set(blocked)] };
      await this.journal.append({ kind: "SWAP_BLOCKED", outcome });
      return outcome;
    }

    const probeRequest = {
      ...plan.request,
      from: "okb",
      readableAmount: "0.001",
      declaredUsdValue: 0.08,
      purpose: "PrismPulse micro-proving swap",
    };
    let probe = await this.invokeExecute(probeRequest);
    if (probe.exitCode === 2 && this.policy.silentModeOptIn && !isBlockLevelConfirmation(probe.output)) {
      probe = await this.invokeExecute(probeRequest, true);
    }
    if (probe.exitCode !== 0) {
      const state = probe.exitCode === 2 ? "CONFIRMATION_REQUIRED" : "FAILED";
      const outcome: ExecutionOutcome = { state, plan, probe: probe.output, reasons: ["MICRO_PROBE_NOT_CONFIRMED"] };
      await this.journal.append({ kind: "SWAP_PROBE_STOPPED", outcome });
      return outcome;
    }

    let execution = await this.invokeExecute(plan.request);
    if (execution.exitCode === 2 && this.policy.silentModeOptIn && !isBlockLevelConfirmation(execution.output)) {
      execution = await this.invokeExecute(plan.request, true);
    }
    const state = execution.exitCode === 0 ? "BROADCAST" : execution.exitCode === 2 ? "CONFIRMATION_REQUIRED" : "FAILED";
    const outcome: ExecutionOutcome = {
      state,
      plan,
      probe: probe.output,
      execution: execution.output,
      reasons: state === "BROADCAST" ? [] : [state === "CONFIRMATION_REQUIRED" ? "USER_CONFIRMATION_REQUIRED" : "EXECUTION_FAILED"],
    };
    await this.journal.append({ kind: "SWAP_EXECUTION", outcome });
    return outcome;
  }

  private runArgs(request: SwapRequest, force = false): string[] {
    const args = [
      "swap", "execute", "--from", request.from, "--to", request.to,
      "--readable-amount", request.readableAmount, "--chain", "xlayer",
      "--wallet", request.wallet, "--max-auto-slippage", String(this.policy.maxPriceImpactPercent),
      "--gas-level", "average",
    ];
    if (force) args.push("--force");
    return args;
  }

  private invokeExecute(request: SwapRequest, force = false): Promise<CommandResult> {
    return this.runner.run(this.runArgs(request, force));
  }
}