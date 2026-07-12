import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  evidenceSealSchema,
  sentinelVerdictSchema,
  transactionIntentSchema,
  type EvidenceSeal,
  type SentinelVerdict,
  type TransactionIntent,
} from "@prismpulse/schemas";

export interface StoredEvidenceSeal {
  seal: EvidenceSeal;
  verdict: SentinelVerdict;
  intent: TransactionIntent;
  storedAt: string;
}

export interface EvidenceSealStore {
  save(record: StoredEvidenceSeal): Promise<void>;
  findByDecisionDigest(digest: string): Promise<StoredEvidenceSeal | null>;
}

function parseRecord(value: unknown): StoredEvidenceSeal {
  const record = value as StoredEvidenceSeal;
  return {
    seal: evidenceSealSchema.parse(record.seal),
    verdict: sentinelVerdictSchema.parse(record.verdict),
    intent: transactionIntentSchema.parse(record.intent),
    storedAt: new Date(record.storedAt).toISOString(),
  };
}

export class MemoryEvidenceSealStore implements EvidenceSealStore {
  readonly records = new Map<string, StoredEvidenceSeal>();

  async save(record: StoredEvidenceSeal): Promise<void> {
    this.records.set(record.seal.decisionDigest, structuredClone(record));
  }

  async findByDecisionDigest(digest: string): Promise<StoredEvidenceSeal | null> {
    const record = this.records.get(digest);
    return record ? structuredClone(record) : null;
  }
}

export class FileEvidenceSealStore implements EvidenceSealStore {
  constructor(private readonly directory: string) {}

  private filePath(digest: string): string {
    return join(this.directory, `${digest.slice(2)}.json`);
  }

  async save(record: StoredEvidenceSeal): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const destination = this.filePath(record.seal.decisionDigest);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
  }

  async findByDecisionDigest(digest: string): Promise<StoredEvidenceSeal | null> {
    try {
      const serialized = await readFile(this.filePath(digest), "utf8");
      return parseRecord(JSON.parse(serialized));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
}

export function createEvidenceSealStore(
  environment: NodeJS.ProcessEnv = process.env,
): EvidenceSealStore {
  const directory = environment.EVIDENCE_SEAL_DIR;
  if (directory) return new FileEvidenceSealStore(directory);
  if (environment.NODE_ENV === "production") {
    throw new Error("EVIDENCE_SEAL_DIR is required in production.");
  }
  return new MemoryEvidenceSealStore();
}
