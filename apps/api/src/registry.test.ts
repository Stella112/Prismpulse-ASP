import { describe, expect, it, vi } from "vitest";
import { UnconfiguredSealRegistry, XLayerSealRegistry } from "./registry.js";

const digest = `0x${"a".repeat(64)}`;
const address = "0x1111111111111111111111111111111111111111";

describe("Seal registry boundary", () => {
  it("reports an explicit unconfigured state", async () => {
    await expect(new UnconfiguredSealRegistry().getStatus(digest)).resolves.toEqual({
      state: "NOT_CONFIGURED",
    });
  });

  it("decodes an anchored receipt", async () => {
    const timestamp = 1_752_364_800;
    const encoded = `0x${"0".repeat(24)}${address.slice(2)}${timestamp.toString(16).padStart(64, "0")}`;
    const rpc = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: encoded })),
    );
    const registry = new XLayerSealRegistry(
      "https://rpc.xlayer.tech",
      address,
      "https://www.oklink.com/x-layer",
      rpc,
    );

    await expect(registry.getStatus(digest)).resolves.toMatchObject({
      state: "ANCHORED",
      issuer: address,
      anchoredAt: new Date(timestamp * 1000).toISOString(),
    });
    expect(await rpc.mock.calls[0]?.[1]?.body).toContain(`0xb01b6d53${digest.slice(2)}`);
  });

  it("reports pending for an unanchored digest", async () => {
    const rpc = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: `0x${"0".repeat(128)}` })),
    );
    await expect(
      new XLayerSealRegistry("https://rpc.xlayer.tech", address, "https://explorer.test", rpc)
        .requestAnchor(digest),
    ).resolves.toMatchObject({ state: "PENDING", registryAddress: address });
  });
});
