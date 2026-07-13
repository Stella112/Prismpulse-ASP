import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { inspectPayloadText } from "@prismpulse/core";

export type HiveTechnique =
  | "INSTRUCTION_OVERRIDE"
  | "ADDRESS_REDIRECT"
  | "OWNER_CONCEALMENT"
  | "OBFUSCATED_INSTRUCTION"
  | "AMBIGUOUS_REDIRECT";

export interface HiveSignature {
  id: string;
  fingerprint: string;
  technique: HiveTechnique;
  indicators: string[];
  source: string;
  capturedAt: string;
  occurrences: number;
  active: boolean;
}

export interface HiveMatch {
  matched: boolean;
  signatureIds: string[];
  anomalyScore: number;
}

export interface HiveStore {
  capture(payload: string, source: string, observedAt?: string): Promise<HiveSignature>;
  inspect(payload: string | undefined, addresses?: string[]): Promise<HiveMatch>;
  list(): Promise<HiveSignature[]>;
}

function normalize(payload: string): string {
  return payload
    .normalize("NFKC")
    .toLowerCase()
    .replace(/0x[a-f0-9]{40}/g, "<address>")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprint(payload: string): string {
  return `0x${createHash("sha256").update(normalize(payload)).digest("hex")}`;
}

function indicators(payload: string): string[] {
  return [...new Set(payload.match(/0x[a-fA-F0-9]{40}/g)?.map((item) => item.toLowerCase()) ?? [])];
}

function classify(payload: string): HiveTechnique {
  if (/ignore\s+(all\s+)?previous|override\s+(the\s+)?(system|policy|safety)/i.test(payload)) {
    return "INSTRUCTION_OVERRIDE";
  }
  if (/do\s+not\s+(tell|notify|inform)/i.test(payload)) return "OWNER_CONCEALMENT";
  if (/(?:base64|hex|unicode)[- ]?(?:decode|encoded)/i.test(payload)) {
    return "OBFUSCATED_INSTRUCTION";
  }
  if (/send\s+(the\s+)?funds?\s+instead|replace\s+(the\s+)?(wallet|payment)\s+address/i.test(payload)) {
    return "ADDRESS_REDIRECT";
  }
  return "AMBIGUOUS_REDIRECT";
}

function createSignature(payload: string, source: string, observedAt: string): HiveSignature {
  const inspection = inspectPayloadText(payload);
  if (inspection.status === "PASS") {
    throw new Error("Hive only activates signatures for suspicious or ambiguous inbound payloads.");
  }
  const digest = fingerprint(payload);
  return {
    id: `hive-${digest.slice(2, 18)}`,
    fingerprint: digest,
    technique: classify(payload),
    indicators: indicators(payload),
    source,
    capturedAt: observedAt,
    occurrences: 1,
    active: true,
  };
}

export class MemoryHiveStore implements HiveStore {
  protected signatures = new Map<string, HiveSignature>();

  async capture(payload: string, source: string, observedAt = new Date().toISOString()): Promise<HiveSignature> {
    const candidate = createSignature(payload, source, observedAt);
    const existing = this.signatures.get(candidate.fingerprint);
    const signature = existing
      ? { ...existing, occurrences: existing.occurrences + 1 }
      : candidate;
    this.signatures.set(signature.fingerprint, signature);
    await this.persist();
    return signature;
  }

  async inspect(payload: string | undefined, addressesToCheck: string[] = []): Promise<HiveMatch> {
    const payloadFingerprint = payload ? fingerprint(payload) : undefined;
    const addresses = new Set(addressesToCheck.map((item) => item.toLowerCase()));
    const matched = [...this.signatures.values()].filter(
      (signature) =>
        signature.active &&
        (signature.fingerprint === payloadFingerprint ||
          signature.indicators.some((indicator) => addresses.has(indicator))),
    );
    return {
      matched: matched.length > 0,
      signatureIds: matched.map((signature) => signature.id),
      anomalyScore: matched.length > 0 ? 100 : 0,
    };
  }

  async list(): Promise<HiveSignature[]> {
    return [...this.signatures.values()].sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
  }

  protected async persist(): Promise<void> {}
}

export class FileHiveStore extends MemoryHiveStore {
  private constructor(private readonly filePath: string) { super(); }

  static async open(filePath: string): Promise<FileHiveStore> {
    const store = new FileHiveStore(filePath);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as HiveSignature[];
      for (const signature of parsed) store.signatures.set(signature.fingerprint, signature);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return store;
  }

  protected override async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(await this.list(), null, 2), { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export async function createHiveStore(environment: NodeJS.ProcessEnv): Promise<HiveStore> {
  if (environment.NODE_ENV === "test") return new MemoryHiveStore();
  return FileHiveStore.open(environment.HIVE_STORE_FILE ?? "./data/seals/hive-signatures.json");
}