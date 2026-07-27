const baseUrl = (process.env.SMOKE_BASE_URL ?? "https://getprismpulse.xyz").replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);
const requireRegistry = process.env.SMOKE_REQUIRE_REGISTRY === "true";
const anchorTimeoutMs = Number(process.env.SMOKE_ANCHOR_TIMEOUT_MS ?? 120_000);

async function checked(path, options) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`${options?.method ?? "GET"} ${path} returned ${response.status}: ${await response.text()}`);
  }
  return response;
}

const health = await (await checked("/api/health")).json();
if (health.status !== "ok") throw new Error("API health payload is not ok");

const metadata = await (await checked("/api/v1/metadata")).json();
for (const capability of ["console-seal-issuance", "evidence-receipts", "registry-status"]) {
  if (!metadata.capabilities?.includes(capability)) throw new Error(`Missing capability: ${capability}`);
}
if (requireRegistry && !metadata.registry?.configured) {
  throw new Error("Seal registry is not configured");
}
if (requireRegistry && !metadata.registry?.workerEnabled) {
  throw new Error("Seal registry issuer worker is not enabled");
}

const landingPage = await (await checked("/")).text();
if (!landingPage.includes("Risk intelligence") || !landingPage.includes('id="pulse"')) {
  throw new Error("Landing page marker is missing");
}
const consolePage = await (await checked("/console.html")).text();
if (!consolePage.includes("PrismPulse Pulse Console")) {
  throw new Error("Pulse Console HTML marker is missing");
}

if (process.env.SMOKE_ISSUE_SEAL === "true") {
  if (!metadata.consoleIssuanceEnabled) throw new Error("Console issuance is not enabled");
  const issued = await (
    await checked("/api/v1/console/seals", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        intent: {
          chainId: 196,
          from: "0x0000000000000000000000000000000000000001",
          to: "0x0000000000000000000000000000000000000002",
          value: "0",
          data: "0x",
          declaredPurpose: "PrismPulse production smoke test",
        },
      }),
    })
  ).json();
  if (!/^0x[a-f0-9]{64}$/.test(issued.seal?.decisionDigest)) {
    throw new Error("Issued Seal has no valid decision digest");
  }
  const sealPath = `/api/v1/seals/${issued.seal.decisionDigest}`;
  let retrieved = await (await checked(sealPath)).json();
  if (retrieved.seal?.decisionDigest !== issued.seal.decisionDigest) {
    throw new Error("Issued Seal was not retrievable");
  }

  if (requireRegistry) {
    const deadline = Date.now() + anchorTimeoutMs;
    while (retrieved.anchoring?.state !== "ANCHORED" && Date.now() < deadline) {
      if (retrieved.anchoring?.state === "FAILED") {
        throw new Error(
          `Seal anchoring failed: ${retrieved.anchoring.message ?? "unknown error"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      retrieved = await (await checked(sealPath)).json();
    }
    if (retrieved.anchoring?.state !== "ANCHORED") {
      throw new Error(`Seal was not anchored within ${anchorTimeoutMs}ms`);
    }
    console.log(
      `Confirmed anchored Seal ${issued.seal.decisionDigest} at ${retrieved.anchoring.explorerUrl}`,
    );
  }
}

console.log(`PrismPulse production smoke passed for ${baseUrl}`);
