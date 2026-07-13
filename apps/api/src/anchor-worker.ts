import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const registryAbi = [
  {
    type: "function",
    name: "anchorSeal",
    stateMutability: "nonpayable",
    inputs: [{ name: "decisionDigest", type: "bytes32" }],
    outputs: [],
  },
] as const;

const xLayer = {
  id: 196,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
} as const;

export type AnchorJobState = "QUEUED" | "SUBMITTED" | "CONFIRMED" | "FAILED";

export interface AnchorJob {
  decisionDigest: string;
  state: AnchorJobState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  transactionHash?: string;
  error?: string;
}

export interface AnchorJobStore {
  enqueue(decisionDigest: string): Promise<AnchorJob>;
  find(decisionDigest: string): Promise<AnchorJob | null>;
  due(now: Date, limit: number): Promise<AnchorJob[]>;
  save(job: AnchorJob): Promise<void>;
}

export class FileAnchorJobStore implements AnchorJobStore {
  private writeLock = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<Record<string, AnchorJob>> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, AnchorJob>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(records: Record<string, AnchorJob>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(records), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async mutate<T>(operation: (records: Record<string, AnchorJob>) => T): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeLock = this.writeLock.then(async () => {
      try {
        const records = await this.readAll();
        const value = operation(records);
        await this.writeAll(records);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    await this.writeLock;
    return result;
  }

  async enqueue(decisionDigest: string): Promise<AnchorJob> {
    return this.mutate((records) => {
      const existing = records[decisionDigest];
      if (existing) return existing;
      const now = new Date().toISOString();
      const job: AnchorJob = {
        decisionDigest,
        state: "QUEUED",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        nextAttemptAt: now,
      };
      records[decisionDigest] = job;
      return job;
    });
  }

  async find(decisionDigest: string): Promise<AnchorJob | null> {
    return (await this.readAll())[decisionDigest] ?? null;
  }

  async due(now: Date, limit: number): Promise<AnchorJob[]> {
    return Object.values(await this.readAll())
      .filter((job) =>
        job.state === "SUBMITTED" ||
        ((job.state === "QUEUED" || job.state === "FAILED") &&
          Date.parse(job.nextAttemptAt) <= now.getTime()),
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .slice(0, limit);
  }

  async save(job: AnchorJob): Promise<void> {
    await this.mutate((records) => {
      records[job.decisionDigest] = structuredClone(job);
    });
  }
}

export interface AnchorSubmitter {
  submit(decisionDigest: string): Promise<string>;
  receipt(transactionHash: string): Promise<"PENDING" | "CONFIRMED" | "REVERTED">;
}

export class ViemAnchorSubmitter implements AnchorSubmitter {
  private readonly account;
  private readonly wallet;
  private readonly publicClient;

  constructor(rpcUrl: string, privateKey: Hex, private readonly registryAddress: Address) {
    this.account = privateKeyToAccount(privateKey);
    const transport = http(rpcUrl, { timeout: 10_000 });
    this.wallet = createWalletClient({ account: this.account, chain: xLayer, transport });
    this.publicClient = createPublicClient({ chain: xLayer, transport });
  }

  async submit(decisionDigest: string): Promise<string> {
    const { request } = await this.publicClient.simulateContract({
      account: this.account,
      address: this.registryAddress,
      abi: registryAbi,
      functionName: "anchorSeal",
      args: [decisionDigest as Hex],
    });
    return this.wallet.writeContract(request);
  }

  async receipt(transactionHash: string): Promise<"PENDING" | "CONFIRMED" | "REVERTED"> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash: transactionHash as Hex });
      return receipt.status === "success" ? "CONFIRMED" : "REVERTED";
    } catch (error) {
      if (error instanceof Error && /not found|could not be found/i.test(error.message)) {
        return "PENDING";
      }
      throw error;
    }
  }
}

export class AnchorWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly store: AnchorJobStore,
    private readonly submitter: AnchorSubmitter,
    private readonly options: {
      intervalMs?: number;
      maxAttempts?: number;
      batchSize?: number;
      now?: () => Date;
    } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.intervalMs ?? 5_000;
    this.timer = setInterval(() => this.runSafely(), intervalMs);
    this.timer.unref();
    this.runSafely();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  private runSafely(): void {
    void this.runOnce().catch((error: unknown) => {
      console.error("Anchor worker pass failed", error);
    });
  }


  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = (this.options.now ?? (() => new Date()))();
      const jobs = await this.store.due(now, this.options.batchSize ?? 5);
      for (const job of jobs) await this.process(job, now);
    } finally {
      this.running = false;
    }
  }

  private async process(job: AnchorJob, now: Date): Promise<void> {
    try {
      if (job.state === "SUBMITTED" && job.transactionHash) {
        const status = await this.submitter.receipt(job.transactionHash);
        if (status === "PENDING") return;
        if (status === "REVERTED") throw new Error("Anchor transaction reverted.");
        await this.store.save({ ...job, state: "CONFIRMED", updatedAt: now.toISOString() });
        return;
      }

      const transactionHash = await this.submitter.submit(job.decisionDigest);
      const { error: _previousError, ...pendingJob } = job;
      await this.store.save({
        ...pendingJob,
        state: "SUBMITTED",
        attempts: job.attempts + 1,
        transactionHash,
        updatedAt: now.toISOString(),
      });
    } catch (error) {
      const attempts = job.attempts + (job.state === "SUBMITTED" ? 0 : 1);
      const maxAttempts = this.options.maxAttempts ?? 5;
      const retryDelay = Math.min(300_000, 5_000 * 2 ** Math.max(0, attempts - 1));
      const { transactionHash: _failedTransactionHash, ...failedJob } = job;
      await this.store.save({
        ...failedJob,
        state: "FAILED",
        attempts,
        error: error instanceof Error ? error.message : "Anchor submission failed",
        updatedAt: now.toISOString(),
        nextAttemptAt:
          attempts >= maxAttempts
            ? "9999-12-31T23:59:59.999Z"
            : new Date(now.getTime() + retryDelay).toISOString(),
      });
    }
  }
}
