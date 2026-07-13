import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AnchorWorker,
  FileAnchorJobStore,
  type AnchorSubmitter,
} from "./anchor-worker.js";

const digest = `0x${"a".repeat(64)}`;
const transactionHash = `0x${"b".repeat(64)}`;

let directory: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function createStore(): Promise<FileAnchorJobStore> {
  directory = await mkdtemp(join(tmpdir(), "prismpulse-anchor-"));
  return new FileAnchorJobStore(join(directory, "queue.json"));
}

describe("AnchorWorker", () => {
  it("submits a queued digest and confirms its receipt", async () => {
    const store = await createStore();
    await store.enqueue(digest);
    const submitter: AnchorSubmitter = {
      submit: vi.fn().mockResolvedValue(transactionHash),
      receipt: vi.fn().mockResolvedValue("CONFIRMED"),
    };
    const worker = new AnchorWorker(store, submitter);

    await worker.runOnce();
    await expect(store.find(digest)).resolves.toMatchObject({
      state: "SUBMITTED",
      attempts: 1,
      transactionHash,
    });

    await worker.runOnce();
    await expect(store.find(digest)).resolves.toMatchObject({
      state: "CONFIRMED",
      attempts: 1,
      transactionHash,
    });
    expect(submitter.submit).toHaveBeenCalledOnce();
    expect(submitter.receipt).toHaveBeenCalledWith(transactionHash);
  });

  it("backs off failed submissions and retries when they become due", async () => {
    const store = await createStore();
    await store.enqueue(digest);
    let now = new Date("2030-01-01T00:00:00.000Z");
    const submitter: AnchorSubmitter = {
      submit: vi
        .fn()
        .mockRejectedValueOnce(new Error("RPC unavailable"))
        .mockResolvedValue(transactionHash),
      receipt: vi.fn().mockResolvedValue("PENDING"),
    };
    const worker = new AnchorWorker(store, submitter, { now: () => now });

    await worker.runOnce();
    await expect(store.find(digest)).resolves.toMatchObject({
      state: "FAILED",
      attempts: 1,
      error: "RPC unavailable",
      nextAttemptAt: "2030-01-01T00:00:05.000Z",
    });

    now = new Date("2030-01-01T00:00:04.999Z");
    await worker.runOnce();
    expect(submitter.submit).toHaveBeenCalledTimes(1);

    now = new Date("2030-01-01T00:00:05.000Z");
    await worker.runOnce();
    await expect(store.find(digest)).resolves.toMatchObject({
      state: "SUBMITTED",
      attempts: 2,
      transactionHash,
    });
  });

  it("does not overlap worker passes", async () => {
    const store = await createStore();
    await store.enqueue(digest);
    let release!: (hash: string) => void;
    const pendingSubmission = new Promise<string>((resolve) => {
      release = resolve;
    });
    const submitter: AnchorSubmitter = {
      submit: vi.fn().mockReturnValue(pendingSubmission),
      receipt: vi.fn().mockResolvedValue("PENDING"),
    };
    const worker = new AnchorWorker(store, submitter);

    const firstPass = worker.runOnce();
    await worker.runOnce();
    release(transactionHash);
    await firstPass;

    expect(submitter.submit).toHaveBeenCalledOnce();
  });
});
