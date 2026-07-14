import { createEvidenceSeal } from "@prismpulse/core";
import type { EvidenceSeal, SentinelVerdict, TransactionIntent } from "@prismpulse/schemas";
import { verifyMessage, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function sealAttestationMessage(seal: EvidenceSeal): string {
  return [
    "PrismPulse Evidence Seal",
    `version:${seal.version}`,
    `network:${seal.network}`,
    `decisionDigest:${seal.decisionDigest}`,
  ].join("\n");
}

export async function attestSeal(
  seal: EvidenceSeal,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EvidenceSeal> {
  const privateKey = environment.ANCHOR_ISSUER_PRIVATE_KEY;
  if (!privateKey) {
    if (environment.NODE_ENV === "production" && environment.RECEIPT_ANCHOR_ADDRESS) {
      throw new Error("Evidence Seal attestation key is unavailable.");
    }
    return seal;
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error("Evidence Seal attestation key is invalid.");
  }
  const account = privateKeyToAccount(privateKey as Hex);
  const signature = await account.signMessage({ message: sealAttestationMessage(seal) });
  return {
    ...seal,
    attestation: { scheme: "eip191", signer: account.address, signature },
  };
}

export async function verifySealRecord(input: {
  seal: EvidenceSeal;
  intent: TransactionIntent;
  verdict: SentinelVerdict;
}): Promise<{
  valid: boolean;
  checks: { digests: boolean; attestation: boolean; signer: string | null };
}> {
  const expected = createEvidenceSeal(input.intent, input.verdict);
  const digests =
    expected.intentDigest === input.seal.intentDigest &&
    expected.evidenceDigest === input.seal.evidenceDigest &&
    expected.decisionDigest === input.seal.decisionDigest &&
    expected.verdict === input.seal.verdict &&
    expected.policyVersion === input.seal.policyVersion;
  const attestation = input.seal.attestation
    ? await verifyMessage({
        address: input.seal.attestation.signer as `0x${string}`,
        message: sealAttestationMessage(input.seal),
        signature: input.seal.attestation.signature as Hex,
      })
    : false;
  return {
    valid: digests && attestation,
    checks: {
      digests,
      attestation,
      signer: input.seal.attestation?.signer ?? null,
    },
  };
}
