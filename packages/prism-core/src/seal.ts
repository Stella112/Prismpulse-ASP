import { createHash } from "node:crypto";
import type {
  EvidenceClaim,
  EvidenceSeal,
  SentinelVerdict,
  TransactionIntent,
} from "@prismpulse/schemas";

const SEAL_VERSION = "1" as const;
const XLAYER_NETWORK = "eip155:196" as const;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nestedValue]) => nestedValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, canonicalize(nestedValue)]),
    );
  }

  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalDigest(value: unknown): `0x${string}` {
  const hash = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return `0x${hash}`;
}

function canonicalEvidence(evidence: EvidenceClaim[]): EvidenceClaim[] {
  return [...evidence].sort((left, right) => left.id.localeCompare(right.id));
}

export function createEvidenceSeal(
  intent: TransactionIntent,
  verdict: SentinelVerdict,
): EvidenceSeal {
  const intentDigest = canonicalDigest(intent);
  const evidenceDigest = canonicalDigest(canonicalEvidence(verdict.evidence));
  const decisionDigest = canonicalDigest({
    createdAt: verdict.createdAt,
    evidenceDigest,
    intentDigest,
    policyVersion: verdict.policyVersion,
    reasonCodes: [...verdict.reasonCodes].sort(),
    score: verdict.score,
    verdict: verdict.verdict,
    version: SEAL_VERSION,
  });

  return {
    version: SEAL_VERSION,
    network: XLAYER_NETWORK,
    intentDigest,
    evidenceDigest,
    decisionDigest,
    verdict: verdict.verdict,
    policyVersion: verdict.policyVersion,
    createdAt: verdict.createdAt,
  };
}
