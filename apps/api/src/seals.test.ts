import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StoredEvidenceSeal } from "./seals.js";
import { FileEvidenceSealStore } from "./seals.js";

const digest = `0x${"a".repeat(64)}` as const;
const record: StoredEvidenceSeal = {
  seal: {
    version: "1",
    network: "eip155:196",
    intentDigest: `0x${"b".repeat(64)}`,
    evidenceDigest: `0x${"c".repeat(64)}`,
    decisionDigest: digest,
    verdict: "ALLOW",
    policyVersion: "sentinel-test",
    createdAt: "2026-07-12T00:00:01.000Z",
  },
  verdict: {
    verdict: "ALLOW",
    score: 0,
    reasonCodes: [],
    perCheck: [
      {
        "check": "PAYLOAD_INSPECTION",
        "status": "PASS",
        "confidence": 1,
        "reasons": [],
        "summary": "Passed."
      },
      {
        "check": "COUNTERPARTY_VERIFICATION",
        "status": "PASS",
        "confidence": 1,
        "reasons": [],
        "summary": "Passed."
      },
      {
        "check": "TRANSACTION_INTENT_GUARD",
        "status": "PASS",
        "confidence": 1,
        "reasons": [],
        "summary": "Passed."
      },
      {
        "check": "COUNTERPARTY_ANOMALY",
        "status": "PASS",
        "confidence": 1,
        "reasons": [],
        "summary": "Passed."
      },
      {
        "check": "SPEND_CIRCUIT_BREAKER",
        "status": "PASS",
        "confidence": 1,
        "reasons": [],
        "summary": "Passed."
      }
    ],
    confidence: 1,
    summary: "No active policy violations.",
    evidence: [],
    policyVersion: "sentinel-test",
    createdAt: "2026-07-12T00:00:01.000Z",
  },
  intent: {
    chainId: 196,
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: "0",
    data: "0x",
    declaredPurpose: "Persistence test",
  },
  storedAt: "2026-07-12T00:00:02.000Z",
};

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("FileEvidenceSealStore", () => {
  it("survives store recreation and returns a validated record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prismpulse-seals-"));
    directories.push(directory);
    await new FileEvidenceSealStore(directory).save(record);

    const restored = await new FileEvidenceSealStore(directory).findByDecisionDigest(digest);

    expect(restored).toEqual(record);
  });

  it("returns null when the digest has not been persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prismpulse-seals-"));
    directories.push(directory);
    await expect(
      new FileEvidenceSealStore(directory).findByDecisionDigest(digest),
    ).resolves.toBeNull();
  });
});
