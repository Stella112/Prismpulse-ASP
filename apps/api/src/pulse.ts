import type { SentinelSignals } from "@prismpulse/core";
import type { EvidenceClaim, TransactionIntent } from "@prismpulse/schemas";

const XLAYER_CHAIN_ID = 196;
const APPROVE_SELECTOR = "095ea7b3";
const TRANSFER_SELECTOR = "a9059cbb";
const TRANSFER_FROM_SELECTOR = "23b872dd";
const MAX_UINT256 = (1n << 256n) - 1n;

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

export interface PulseInspection {
  signals: SentinelSignals;
  evidence: EvidenceClaim[];
  blockNumber: string;
  effectRecipient?: string;
}

export interface PulseOptions {
  rpcUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class EvidenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceUnavailableError";
  }
}

function isUnlimitedApproval(data: string): boolean {
  const body = data.slice(2);
  if (body.length < 136 || body.slice(0, 8).toLowerCase() !== APPROVE_SELECTOR) {
    return false;
  }

  try {
    return BigInt(`0x${body.slice(72, 136)}`) === MAX_UINT256;
  } catch {
    return false;
  }
}

function decodeAddressWord(body: string, wordIndex: number): string | undefined {
  const start = 8 + wordIndex * 64;
  const word = body.slice(start, start + 64);
  if (word.length !== 64 || !/^[a-fA-F0-9]{64}$/.test(word)) return undefined;
  return `0x${word.slice(24)}`;
}

export function deriveEffectRecipient(intent: TransactionIntent): string {
  const body = intent.data.slice(2);
  const selector = body.slice(0, 8).toLowerCase();
  if (selector === TRANSFER_SELECTOR || selector === APPROVE_SELECTOR) {
    return decodeAddressWord(body, 0) ?? intent.to;
  }
  if (selector === TRANSFER_FROM_SELECTOR) {
    return decodeAddressWord(body, 1) ?? intent.to;
  }
  return intent.to;
}

async function rpcCall(
  rpcUrl: string,
  fetchImpl: typeof fetch,
  method: string,
  params: unknown[],
): Promise<JsonRpcResponse> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new EvidenceUnavailableError(`X Layer RPC returned HTTP ${response.status}.`);
  }

  return (await response.json()) as JsonRpcResponse;
}

function requireHexResult(response: JsonRpcResponse, method: string): string {
  if (typeof response.result !== "string" || !response.result.startsWith("0x")) {
    throw new EvidenceUnavailableError(`X Layer RPC did not return ${method}.`);
  }
  return response.result;
}

export async function collectXLayerEvidence(
  intent: TransactionIntent,
  options: PulseOptions = {},
): Promise<PulseInspection> {
  const rpcUrl = options.rpcUrl ?? process.env.XLAYER_RPC_URL ?? "https://rpc.xlayer.tech";
  const fetchImpl = options.fetchImpl ?? fetch;
  const observedAt = (options.now ?? (() => new Date()))().toISOString();

  let chainResponse: JsonRpcResponse;
  let blockResponse: JsonRpcResponse;
  let codeResponse: JsonRpcResponse;
  let simulationResponse: JsonRpcResponse;
  try {
    [chainResponse, blockResponse, codeResponse, simulationResponse] = await Promise.all([
      rpcCall(rpcUrl, fetchImpl, "eth_chainId", []),
      rpcCall(rpcUrl, fetchImpl, "eth_blockNumber", []),
      rpcCall(rpcUrl, fetchImpl, "eth_getCode", [intent.to, "latest"]),
      rpcCall(rpcUrl, fetchImpl, "eth_call", [
        {
          from: intent.from,
          to: intent.to,
          value: `0x${BigInt(intent.value).toString(16)}`,
          data: intent.data,
        },
        "latest",
      ]),
    ]);
  } catch (error) {
    if (error instanceof EvidenceUnavailableError) throw error;
    throw new EvidenceUnavailableError(
      error instanceof Error ? error.message : "X Layer RPC request failed.",
    );
  }

  const chainId = Number.parseInt(requireHexResult(chainResponse, "chain ID"), 16);
  if (chainId !== XLAYER_CHAIN_ID) {
    throw new EvidenceUnavailableError(`Unexpected chain ID ${chainId}.`);
  }

  const blockHex = requireHexResult(blockResponse, "block number");
  const blockNumber = BigInt(blockHex).toString(10);
  const code = requireHexResult(codeResponse, "contract code");
  const simulationSucceeded = simulationResponse.error === undefined;
  const effectRecipient = deriveEffectRecipient(intent);

  const evidence: EvidenceClaim[] = [
    {
      id: `rpc-chain-${blockNumber}`,
      kind: "rpc",
      source: rpcUrl,
      observedAt,
      blockNumber,
      value: { chainId, blockHashContext: blockHex },
      confidence: 1,
      verified: true,
      stale: false,
    },
    {
      id: `contract-code-${blockNumber}`,
      kind: "contract",
      source: rpcUrl,
      observedAt,
      blockNumber,
      value: {
        hasBytecode: code !== "0x" && code !== "0x0",
        byteLength: Math.max(0, (code.length - 2) / 2),
        effectRecipient,
      },
      confidence: 1,
      verified: true,
      stale: false,
    },
    {
      id: `simulation-${blockNumber}`,
      kind: "simulation",
      source: rpcUrl,
      observedAt,
      blockNumber,
      value: simulationSucceeded
        ? { success: true, returnData: simulationResponse.result }
        : {
            success: false,
            errorCode: simulationResponse.error?.code,
            error: simulationResponse.error?.message ?? "Transaction simulation reverted.",
          },
      confidence: 1,
      verified: true,
      stale: false,
    },
    {
      id: `signature-scan-${blockNumber}`,
      kind: "signature",
      source: rpcUrl,
      observedAt,
      blockNumber,
      value: { completed: false, reason: "Hive signature registry is not active." },
      confidence: 0,
      verified: false,
      stale: false,
    },
  ];

  return {
    blockNumber,
    effectRecipient,
    signals: {
      simulationSucceeded,
      approvalIsUnlimited: isUnlimitedApproval(intent.data),
    },
    evidence,
  };
}
