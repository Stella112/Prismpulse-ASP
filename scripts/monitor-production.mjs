const baseUrl = (process.env.MONITOR_BASE_URL ?? "https://getprismpulse.xyz").replace(/\/$/, "");
const timeoutMs = Number(process.env.MONITOR_TIMEOUT_MS ?? 15_000);
const requireLaunch = process.env.MONITOR_REQUIRE_LAUNCH === "true";
const results = [];

async function check(name, path, validate, acceptedStatuses = [200]) {
  try {
    const response = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    const ok = acceptedStatuses.includes(response.status) && validate(body);
    results.push({ name, ok, status: response.status, body });
  } catch (error) {
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

await check("health", "/api/health", (body) => body.status === "ok");
await check(
  "metadata",
  "/api/v1/metadata",
  (body) => body.registry?.configured && body.registry?.workerEnabled,
);
await check(
  "readiness",
  "/api/v1/readiness",
  (body) => body.operational === true && (!requireLaunch || body.launchReady === true),
  [200, 503],
);

const failed = results.filter((result) => !result.ok);
const report = { checkedAt: new Date().toISOString(), baseUrl, ok: failed.length === 0, results };
console.log(JSON.stringify(report, null, 2));

if (failed.length > 0 && process.env.ALERT_WEBHOOK_URL) {
  await fetch(process.env.ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      text: `PrismPulse production monitor failed: ${failed.map((item) => item.name).join(", ")}`,
      report,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
if (failed.length > 0) process.exit(1);
