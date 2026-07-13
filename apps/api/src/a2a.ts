import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export type A2AStage =
  | "NEGOTIATING"
  | "APPLIED"
  | "ESCROW_FUNDED"
  | "DELIVERED"
  | "REJECTED"
  | "DISPUTED"
  | "COMPLETED"
  | "REFUNDED";

export interface AgreedTerms {
  amount: string;
  tokenSymbol: "USDT" | "USDG";
  scope: string;
  deliverable: string;
}

export interface A2ATaskRecord {
  jobId: string;
  agentId: string;
  counterpartyAgentId: string;
  stage: A2AStage;
  escrowFunded: boolean;
  terms?: AgreedTerms;
  evidence: string[];
  createdAt: string;
  updatedAt: string;
}

export interface A2AStore {
  get(jobId: string): Promise<A2ATaskRecord | undefined>;
  save(record: A2ATaskRecord): Promise<void>;
}

export class MemoryA2AStore implements A2AStore {
  protected readonly records = new Map<string, A2ATaskRecord>();

  async get(jobId: string): Promise<A2ATaskRecord | undefined> {
    return this.records.get(jobId);
  }

  async save(record: A2ATaskRecord): Promise<void> {
    this.records.set(record.jobId, structuredClone(record));
    await this.persist();
  }

  protected async persist(): Promise<void> {}
}

export class FileA2AStore extends MemoryA2AStore {
  private constructor(private readonly path: string) {
    super();
  }

  static async open(path: string): Promise<FileA2AStore> {
    const store = new FileA2AStore(path);
    try {
      const records = z.array(taskRecordSchema).parse(JSON.parse(await readFile(path, "utf8")));
      for (const record of records) {
        const { terms, ...base } = record;
        store.records.set(record.jobId, terms ? { ...base, terms } : base);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify([...this.records.values()], null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

export interface A2ACommandResult {
  exitCode: number;
  output: unknown;
}

export interface A2ACommandGateway {
  onchainOs(args: string[]): Promise<A2ACommandResult>;
  encryptedMessage(args: string[]): Promise<A2ACommandResult>;
}

function run(binary: string, args: string[]): Promise<A2ACommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      const text = stdout.trim() || stderr.trim();
      try {
        resolve({ exitCode: code ?? 1, output: JSON.parse(text) });
      } catch {
        resolve({ exitCode: code ?? 1, output: { ok: false, message: text } });
      }
    });
  });
}

export class CliA2ACommandGateway implements A2ACommandGateway {
  constructor(
    private readonly onchainOsBinary = process.env.ONCHAINOS_BINARY ?? "onchainos",
    private readonly a2aBinary = process.env.OKX_A2A_BINARY ?? "okx-a2a",
  ) {}

  onchainOs(args: string[]): Promise<A2ACommandResult> {
    return run(this.onchainOsBinary, args);
  }

  encryptedMessage(args: string[]): Promise<A2ACommandResult> {
    return run(this.a2aBinary, args);
  }
}

const termsSchema = z.object({
  amount: z.string().regex(/^\d+(\.\d{1,5})?$/),
  tokenSymbol: z.enum(["USDT", "USDG"]),
  scope: z.string().min(20).max(2_000),
  deliverable: z.string().min(3).max(500),
});

const taskRecordSchema = z.object({
  jobId: z.string().min(1),
  agentId: z.string().min(1),
  counterpartyAgentId: z.string().min(1),
  stage: z.enum([
    "NEGOTIATING",
    "APPLIED",
    "ESCROW_FUNDED",
    "DELIVERED",
    "REJECTED",
    "DISPUTED",
    "COMPLETED",
    "REFUNDED",
  ]),
  escrowFunded: z.boolean(),
  terms: termsSchema.optional(),
  evidence: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

const systemEventSchema = z.object({
  source: z.literal("system"),
  event: z.string().min(1),
  jobId: z.string().min(1),
  code: z.number().int().optional(),
}).passthrough();

export interface NegotiationRequest {
  jobId: string;
  agentId: string;
  counterpartyAgentId: string;
  terms: AgreedTerms;
  evidence?: string[];
}

export interface NegotiationGuard {
  inspect(scope: string): Promise<{ allowed: boolean; evidence: string[]; reason?: string }>;
}

function transition(event: string): { stage: A2AStage; escrowFunded?: boolean } | undefined {
  switch (event) {
    case "provider_applied":
      return { stage: "APPLIED" };
    case "job_accepted":
      return { stage: "ESCROW_FUNDED", escrowFunded: true };
    case "job_submitted":
      return { stage: "DELIVERED" };
    case "job_rejected":
      return { stage: "REJECTED" };
    case "job_disputed":
      return { stage: "DISPUTED" };
    case "job_completed":
    case "job_auto_completed":
      return { stage: "COMPLETED" };
    case "job_refunded":
    case "job_auto_refunded":
      return { stage: "REFUNDED", escrowFunded: false };
    default:
      return undefined;
  }
}

export class A2ALifecycle {
  constructor(
    private readonly store: A2AStore,
    private readonly gateway: A2ACommandGateway,
    private readonly guard: NegotiationGuard,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async negotiate(request: NegotiationRequest): Promise<A2ATaskRecord> {
    const terms = termsSchema.parse(request.terms);
    const inspection = await this.guard.inspect(terms.scope);
    if (!inspection.allowed) throw new Error(inspection.reason ?? "Sentinel blocked the task scope.");
    const timestamp = this.now().toISOString();
    const record: A2ATaskRecord = {
      jobId: request.jobId,
      agentId: request.agentId,
      counterpartyAgentId: request.counterpartyAgentId,
      stage: "NEGOTIATING",
      escrowFunded: false,
      terms,
      evidence: [...new Set([...(request.evidence ?? []), ...inspection.evidence])],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const message = [
      "PrismPulse proposal",
      `Price: ${terms.amount} ${terms.tokenSymbol}`,
      `Scope: ${terms.scope}`,
      `Deliverable: ${terms.deliverable}`,
      "Execution and delivery begin only after marketplace escrow is funded.",
    ].join("\n");
    const sent = await this.gateway.encryptedMessage([
      "xmtp-send",
      "--job-id", request.jobId,
      "--to-agent-id", request.counterpartyAgentId,
      "--session-agent-id", request.agentId,
      "--message", message,
      "--json",
    ]);
    if (sent.exitCode !== 0) throw new Error("Encrypted negotiation message failed.");
    await this.store.save(record);
    return record;
  }

  async handleSystemEvent(agentId: string, input: unknown): Promise<A2ATaskRecord | undefined> {
    const event = systemEventSchema.parse(input);
    if ((event.code ?? 0) !== 0) throw new Error("Refusing to advance a failed marketplace transaction.");
    const nextAction = await this.gateway.onchainOs([
      "agent", "next-action",
      "--role", "auto",
      "--agentId", agentId,
      "--message", JSON.stringify(event),
    ]);
    if (nextAction.exitCode !== 0) throw new Error("Marketplace next-action resolution failed.");
    const change = transition(event.event);
    if (!change) return this.store.get(event.jobId);
    const existing = await this.requireTask(event.jobId);
    const updated: A2ATaskRecord = {
      ...existing,
      stage: change.stage,
      escrowFunded: change.escrowFunded ?? existing.escrowFunded,
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(updated);
    return updated;
  }

  async deliver(jobId: string, message: string, file?: string): Promise<A2ATaskRecord> {
    const record = await this.requireTask(jobId);
    if (record.stage !== "ESCROW_FUNDED" || !record.escrowFunded) {
      throw new Error("Delivery is blocked until job_accepted confirms funded escrow.");
    }
    const args = ["agent", "deliver", jobId, "--message", message, "--agent-id", record.agentId];
    if (file) args.push("--file", file);
    const delivered = await this.gateway.onchainOs(args);
    if (delivered.exitCode !== 0) throw new Error("Marketplace delivery failed.");
    const updated = { ...record, stage: "DELIVERED" as const, updatedAt: this.now().toISOString() };
    await this.store.save(updated);
    return updated;
  }

  async dispute(jobId: string, reason: string, evidence: string[] = []): Promise<A2ATaskRecord> {
    const record = await this.requireTask(jobId);
    if (record.stage !== "REJECTED") throw new Error("A dispute can only be raised after rejection.");
    const raised = await this.gateway.onchainOs([
      "agent", "dispute", "raise", jobId, "--reason", reason, "--agent-id", record.agentId,
    ]);
    if (raised.exitCode !== 0) throw new Error("Dispute deposit approval failed.");
    const confirmed = await this.gateway.onchainOs([
      "agent", "dispute", "confirm", jobId, "--agent-id", record.agentId,
    ]);
    if (confirmed.exitCode !== 0) throw new Error("Dispute confirmation failed.");
    const updated: A2ATaskRecord = {
      ...record,
      stage: "DISPUTED",
      evidence: [...new Set([...record.evidence, ...evidence])],
      updatedAt: this.now().toISOString(),
    };
    await this.store.save(updated);
    return updated;
  }

  private async requireTask(jobId: string): Promise<A2ATaskRecord> {
    const record = await this.store.get(jobId);
    if (!record) throw new Error(`Unknown A2A task: ${jobId}`);
    return record;
  }
}

export async function createA2AStore(environment: NodeJS.ProcessEnv): Promise<A2AStore> {
  if (environment.NODE_ENV === "test") return new MemoryA2AStore();
  return FileA2AStore.open(environment.A2A_STORE_FILE ?? "./data/a2a/tasks.json");
}
