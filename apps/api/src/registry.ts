import { addressSchema, digestSchema } from "@prismpulse/schemas";
import { z } from "zod";

const registryConfigSchema = z.object({
  XLAYER_RPC_URL: z.string().url(),
  RECEIPT_ANCHOR_ADDRESS: addressSchema,
  XLAYER_EXPLORER_URL: z.string().url().default("https://www.oklink.com/x-layer"),
});

export type AnchorState = "NOT_CONFIGURED" | "PENDING" | "ANCHORED" | "FAILED";

export interface AnchorStatus {
  state: AnchorState;
  registryAddress?: string;
  issuer?: string;
  anchoredAt?: string;
  explorerUrl?: string;
  message?: string;
}

export interface SealRegistry {
  readonly configured: boolean;
  readonly address?: string;
  readonly explorerUrl?: string;
  getStatus(decisionDigest: string): Promise<AnchorStatus>;
  requestAnchor(decisionDigest: string): Promise<AnchorStatus>;
}

export class UnconfiguredSealRegistry implements SealRegistry {
  readonly configured = false;

  async getStatus(_decisionDigest: string): Promise<AnchorStatus> {
    return { state: "NOT_CONFIGURED" };
  }

  async requestAnchor(_decisionDigest: string): Promise<AnchorStatus> {
    return { state: "NOT_CONFIGURED" };
  }
}

export class XLayerSealRegistry implements SealRegistry {
  readonly configured = true;
  readonly address: string;
  readonly explorerUrl: string;

  constructor(
    private readonly rpcUrl: string,
    address: string,
    explorerBaseUrl: string,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    this.address = address;
    this.explorerUrl = `${explorerBaseUrl.replace(/\/$/, "")}/address/${address}`;
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
        return {
          state: "PENDING",
          registryAddress: this.address,
          explorerUrl: this.explorerUrl,
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
    // Transaction submission belongs behind this boundary in a separately funded issuer worker.
    return this.getStatus(decisionDigest);
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
  return new XLayerSealRegistry(
    parsed.data.XLAYER_RPC_URL,
    parsed.data.RECEIPT_ANCHOR_ADDRESS,
    parsed.data.XLAYER_EXPLORER_URL,
  );
}
