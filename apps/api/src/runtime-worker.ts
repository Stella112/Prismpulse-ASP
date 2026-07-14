import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { addressSchema } from "@prismpulse/schemas";
import { z } from "zod";
import { BoundedSwapExecutor, ExecutionJournal, OnchainOsCliRunner } from "./execution.js";
import { GasVault } from "./gas-vault.js";

if (process.env.RUNTIME_ENV_FILE) {
  const serialized = readFileSync(process.env.RUNTIME_ENV_FILE, "utf8");
  for (const line of serialized.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const configSchema = z.object({
  AGENTIC_WALLET_ADDRESS: addressSchema,
  OPERATIONAL_RECIPIENT_ADDRESS: addressSchema,
  AUTONOMOUS_EXECUTION_ENABLED: z.literal("true"),
  GAS_VAULT_ENABLED: z.literal("true"),
  GLOBAL_KILL_SWITCH: z.enum(["true", "false"]).default("false"),
  SILENT_MODE_OPT_IN: z.enum(["true", "false"]).default("false"),
  PER_TRANSACTION_CAP_USD: z.coerce.number().positive().default(100),
  DAILY_CAP_USD: z.coerce.number().positive().default(500),
  ROLLING_DAILY_SPEND_USD: z.coerce.number().nonnegative().default(0),
  MAX_PRICE_IMPACT_PERCENT: z.coerce.number().positive().max(20).default(3),
  MAX_QUOTE_AGE_MS: z.coerce.number().int().positive().default(30_000),
  GAS_VAULT_MINIMUM_OKB: z.coerce.number().positive().default(0.005),
  GAS_VAULT_TARGET_OKB: z.coerce.number().positive().default(0.02),
  GAS_VAULT_AGENT_RESERVE_OKB: z.coerce.number().positive().default(0.005),
  GAS_VAULT_MINIMUM_STABLE_RESERVE_USD: z.coerce.number().nonnegative().default(0.25),
  GAS_VAULT_MAX_REFILL_USD: z.coerce.number().positive().default(2),
  RUNTIME_WORKER_INTERVAL_MS: z.coerce.number().int().min(30_000).default(300_000),
  EXECUTION_JOURNAL_FILE: z.string().min(1).default("./data/runtime/execution.jsonl"),
  RUNTIME_STATUS_FILE: z.string().min(1).default("./data/runtime/status.json"),
});

async function writeStatus(path: string, status: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ observedAt: new Date().toISOString(), ...status }), {
    mode: 0o600,
  });
  await rename(temporary, path);
}

const config = configSchema.parse(process.env);
const runner = new OnchainOsCliRunner();
const journal = new ExecutionJournal(config.EXECUTION_JOURNAL_FILE);
const executor = new BoundedSwapExecutor(runner, {
  enabled: true,
  silentModeOptIn: config.SILENT_MODE_OPT_IN === "true",
  killSwitchActive: config.GLOBAL_KILL_SWITCH === "true",
  perTradeCapUsd: config.PER_TRANSACTION_CAP_USD,
  dailyCapUsd: config.DAILY_CAP_USD,
  rollingDailyUsd: config.ROLLING_DAILY_SPEND_USD,
  maxPriceImpactPercent: config.MAX_PRICE_IMPACT_PERCENT,
  maxQuoteAgeMs: config.MAX_QUOTE_AGE_MS,
}, journal);
const vault = new GasVault(runner, executor, journal, {
  wallet: config.AGENTIC_WALLET_ADDRESS,
  operationalRecipient: config.OPERATIONAL_RECIPIENT_ADDRESS,
  minimumOkb: config.GAS_VAULT_MINIMUM_OKB,
  targetOkb: config.GAS_VAULT_TARGET_OKB,
  agentReserveOkb: config.GAS_VAULT_AGENT_RESERVE_OKB,
  minimumStableReserveUsd: config.GAS_VAULT_MINIMUM_STABLE_RESERVE_USD,
  maxRefillUsd: config.GAS_VAULT_MAX_REFILL_USD,
  silentModeOptIn: config.SILENT_MODE_OPT_IN === "true",
});

let running = false;
async function runPass(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const result = await vault.refill();
    await writeStatus(config.RUNTIME_STATUS_FILE, { ok: true, gasVault: result });
  } catch (error) {
    await writeStatus(config.RUNTIME_STATUS_FILE, {
      ok: false,
      error: error instanceof Error ? error.message : "Runtime worker failed",
    });
  } finally {
    running = false;
  }
}

await runPass();
setInterval(() => void runPass(), config.RUNTIME_WORKER_INTERVAL_MS);
