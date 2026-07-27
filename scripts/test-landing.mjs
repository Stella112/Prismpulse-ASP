import assert from "node:assert/strict";
import { access, readFile, stat } from "node:fs/promises";
import test from "node:test";

const webRoot = new URL("../apps/web/", import.meta.url);

test("ships the complete PrismPulse landing page and preserves the live console", async () => {
  const [landing, consolePage, css] = await Promise.all([
    readFile(new URL("index.html", webRoot), "utf8"),
    readFile(new URL("console.html", webRoot), "utf8"),
    readFile(new URL("landing.css", webRoot), "utf8"),
  ]);

  for (const marker of [
    'id="pulse"',
    'id="system"',
    'id="services"',
    'id="proof"',
    "Risk intelligence",
    "Five-part Sentinel",
    "Market Intelligence",
    "PrismBond coverage",
    "Agent Risk Underwriting",
    "Web2-simple",
    "https://www.okx.ai/agents/5738?source=search",
    "/console.html#pulse",
  ]) {
    assert.match(landing, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(consolePage, /PrismPulse Pulse Console/);
  assert.match(consolePage, /id="inspection-form"/);
  assert.ok(css.length > 10_000, "landing stylesheet is unexpectedly small");

  for (const asset of ["prismpulse-logo.jpg", "og.png", "app.js", "styles.css"]) {
    await access(new URL(asset, webRoot));
  }

  const logo = await stat(new URL("prismpulse-logo.jpg", webRoot));
  assert.ok(logo.size < 1_000_000, "submitted logo must stay below 1 MB");
});
