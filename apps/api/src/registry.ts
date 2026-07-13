import { addressSchema, digestSchema } from "@prismpulse/schemas";
import { join } from "node:path";
import { z } from "zod";
import {
  AnchorWorker,
  FileAnchorJobStore,
  ViemAnchorSubmitter,
  type AnchorJobStore,
} from "./anchor-worker.js";

const registryConfigSchema = z.object({
  XLAYER_RPC_URL: z.string().url(),
  RECEIPT_ANCHOR_ADDRESS: addressSchema,
  XLAYER_EXPLORER_URL: z.string().url().default("https://www.oklink.com/x-layer"),
  EVIDENCE_SEAL_DIR: z.string().min(1).optional(),
  ANCHOR_JOB_DIR: z.string().min(1).optional(),
  ANCHOR_ISSUER_PRIVATE_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/).optional(),
  ANCHOR_WORKER_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
});

export type AnchorState = "NOT_CONFIGURED" | "PENDING" | "ANCHORED" | "FAILED";

export interface AnchorStatus {
  state: AnchorState;
  registryAddress?: string;
  issuer?: string;
  anchoredAt?: string;
  explorerUrl?: string;
  message?: string;
  transactionHash?: string;
  attempts?: number;
}

export interface SealRegistry {
  readonly configured: boolean;
  readonly address?: string;
  readonly explorerUrl?: string;
  readonly workerEnabled: boolean;
  getStatus(decisionDigest: string): Promise<AnchorStatus>;
  requestAnchor(decisionDigest: string): Promise<AnchorStatus>;
}

export class UnconfiguredSealRegistry implements SealRegistry {
  readonly configured = false;
  readonly workerEnabled = false;

  async getStatus(_decisionDigest: string): Promise<AnchorStatus> {
    return { state: "NOT_CONFIGURED" };
  }

  async requestAnchor(_decisionDigest: string): Promise<AnchorStatus> {
    return { state: "NOT_CONFIGURED" };
  }
}

export class XLayerSealRegistry implements SealRegistry {
  readonly configured = true;
  readonly workerEnabled: boolean;
  readonly address: string;
  readonly explorerUrl: string;

  constructor(
    private readonly rpcUrl: string,
    address: string,
    explorerBaseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly jobStore?: AnchorJobStore,
    worker?: AnchorWorker,
  ) {
    this.address = address;
    this.explorerUrl = `${explorerBaseUrl.replace(/\/$/, "")}/address/${address}`;
    this.workerEnabled = Boolean(worker);
    worker?.start();
  }

  async getStatus(decisionDigest: string): Promise<AnchorStatus> {
    const digest = digestSchema.parse(decisionDigest);
    try {
      const response = await this.fetchImplementation(this.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: this.address, data: `0xb01b6d53${digest.slice(2)}` }, "latest"],
        }),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const payload = (await response.json()) as { result?: string; error?: { message?: string } };
      if (payload.error || !payload.result) {
        throw new Error(payload.error?.message ?? "Registry returned no result");
      }
      const encoded = payload.result.slice(2).padStart(128, "0");
      const issuer = `0x${encoded.slice(24, 64)}`;
      const timestamp = Number.parseInt(encoded.slice(64, 128), 16);
      if (timestamp === 0) {
        const job = await this.jobStore?.find(digest);
        const message =
          job?.error ??
          (!this.workerEnabled ? "Anchor issuer worker is not configured." : undefined);
        return {
          state: job?.state === "FAILED" ? "FAILED" : "PENDING",
          registryAddress: this.address,
          explorerUrl: this.explorerUrl,
          ...(job?.transactionHash ? { transactionHash: job.transactionHash } : {}),
          ...(job ? { attempts: job.attempts } : {}),
          ...(message ? { message } : {}),
        };
      }
      return {
        state: "ANCHORED",
        registryAddress: this.address,
        issuer,
        anchoredAt: new Date(timestamp * 1000).toISOString(),
        explorerUrl: this.explorerUrl,
      };
    } catch (error) {
      return {
        state: "FAILED",
        registryAddress: this.address,
        explorerUrl: this.explorerUrl,
        message: error instanceof Error ? error.message : "Registry lookup failed",
      };
    }
  }

  async requestAnchor(decisionDigest: string): Promise<AnchorStatus> {
    const current = await this.getStatus(decisionDigest);
    if (current.state === "ANCHORED" || !this.jobStore) return current;
    const job = await this.jobStore.enqueue(digestSchema.parse(decisionDigest));
    const message = !this.workerEnabled
      ? "Anchor issuer worker is not configured."
      : undefined;
    return {
      state: "PENDING",
      registryAddress: this.address,
      explorerUrl: this.explorerUrl,
      attempts: job.attempts,
      ...(job.transactionHash ? { transactionHash: job.transactionHash } : {}),
      ...(message ? { message } : {}),
    };
  }
}

export function createSealRegistry(
  environment: NodeJS.ProcessEnv = process.env,
): SealRegistry {
  if (!environment.RECEIPT_ANCHOR_ADDRESS) return new UnconfiguredSealRegistry();
  const parsed = registryConfigSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = Object.keys(parsed.error.flatten().fieldErrors).join(", ");
    throw new Error(`Invalid Seal registry configuration: ${fields}`);
  }
  const jobDirectory =
    parsed.data.ANCHOR_JOB_DIR ??
    join(parsed.data.EVIDENCE_SEAL_DIR ?? "./data", "anchors");
  const jobStore = new FileAnchorJobStore(join(jobDirectory, "queue.json"));
  const worker = parsed.data.ANCHOR_ISSUER_PRIVATE_KEY
    ? new AnchorWorker(
        jobStore,
        new ViemAnchorSubmitter(
          parsed.data.XLAYER_RPC_URL,
          parsed.data.ANCHOR_ISSUER_PRIVATE_KEY as `0x${string}`,
          parsed.data.RECEIPT_ANCHOR_ADDRESS as `0x${string}`,
        ),
        { intervalMs: parsed.data.ANCHOR_WORKER_INTERVAL_MS },
      )
    : undefined;
  return new XLayerSealRegistry(
    parsed.data.XLAYER_RPC_URL,
    parsed.data.RECEIPT_ANCHOR_ADDRESS,
    parsed.data.XLAYER_EXPLORER_URL,
    fetch,
    jobStore,
    worker,
  );
}
