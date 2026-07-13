const baseUrl = (process.env.SMOKE_BASE_URL ?? "https://getprismpulse.xyz").replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 15_000);

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

const consolePage = await (await checked("/")).text();
if (!consolePage.includes("PrismPulse Console")) throw new Error("Console HTML marker is missing");

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
  const retrieved = await (
    await checked(`/api/v1/seals/${issued.seal.decisionDigest}`)
  ).json();
  if (retrieved.seal?.decisionDigest !== issued.seal.decisionDigest) {
    throw new Error("Issued Seal was not retrievable");
  }
}

console.log(`PrismPulse production smoke passed for ${baseUrl}`);
