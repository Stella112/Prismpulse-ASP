const API_BASE = "/api";
const addressPattern = /^0x[a-fA-F0-9]{40}$/;
const hexPattern = /^0x[a-fA-F0-9]*$/;
const digestPattern = /^0x[a-f0-9]{64}$/;

const viewNames = {
  pulse: ["PULSE", "Pulse Console"],
  seals: ["SEALS", "Seal Explorer"],
  hive: ["HIVE", "Hive Registry"],
  system: ["SYSTEM", "System Status"],
};

const apiDot = document.querySelector("#api-dot");
const sidebarStatus = document.querySelector("#sidebar-status");
const apiStatus = document.querySelector("#api-status");
const systemApi = document.querySelector("#system-api");
const paymentState = document.querySelector("#payment-state");
const systemPayments = document.querySelector("#system-payments");
const sealButton = document.querySelector("#seal-button");
const sealNote = document.querySelector("#seal-note");

function setServiceState(live, label) {
  for (const dot of [apiDot, sidebarStatus]) {
    dot.classList.toggle("live", live);
    dot.classList.toggle("down", !live);
  }
  apiStatus.textContent = label;
  systemApi.textContent = label;
}

async function loadMetadata() {
  try {
    const response = await fetch(`${API_BASE}/v1/metadata`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    setServiceState(true, "API live");
    const paymentLabel = metadata.paidRoutesEnabled ? "Exact active" : "Setup pending";
    paymentState.textContent = paymentLabel;
    systemPayments.textContent = paymentLabel;
    if (metadata.paidRoutesEnabled) {
      sealNote.textContent = "Available to x402-compatible agents.";
    }
  } catch {
    setServiceState(false, "API unavailable");
    paymentState.textContent = "Unknown";
    systemPayments.textContent = "Unknown";
  }
}

function switchView(name) {
  const next = viewNames[name];
  if (!next) return;
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === `view-${name}`);
  });
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === name);
  });
  document.querySelector("#view-crumb").textContent = next[0];
  document.querySelector("#view-title").textContent = next[1];
  window.location.hash = name;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

const initialView = window.location.hash.slice(1);
if (viewNames[initialView]) switchView(initialView);

function readIntent() {
  const from = document.querySelector("#from").value.trim();
  const to = document.querySelector("#to").value.trim();
  const value = document.querySelector("#value").value.trim();
  const data = document.querySelector("#calldata").value.trim();
  const declaredPurpose = document.querySelector("#purpose").value.trim();
  const expectedRecipient = document.querySelector("#expected-recipient").value.trim();

  if (!addressPattern.test(from)) throw new Error("From must be a valid EVM address.");
  if (!addressPattern.test(to)) throw new Error("To must be a valid EVM address.");
  if (!/^\d+$/.test(value)) throw new Error("Value must be an integer in wei.");
  if (!hexPattern.test(data) || data.length % 2 !== 0) {
    throw new Error("Calldata must be even-length hexadecimal beginning with 0x.");
  }
  if (declaredPurpose.length < 3) throw new Error("Declared purpose is required.");
  if (expectedRecipient && !addressPattern.test(expectedRecipient)) {
    throw new Error("Expected recipient must be a valid EVM address.");
  }

  return {
    chainId: 196,
    from,
    to,
    value,
    data,
    declaredPurpose,
    ...(expectedRecipient ? { expectedRecipient } : {}),
  };
}

function signalItem(label, value, tone = "") {
  const item = document.createElement("div");
  item.className = `signal-item ${tone}`.trim();
  const name = document.createElement("span");
  const result = document.createElement("strong");
  name.textContent = label;
  result.textContent = value;
  item.append(name, result);
  return item;
}

function evidenceItem(claim) {
  const item = document.createElement("div");
  item.className = "evidence-item";
  const kind = document.createElement("span");
  kind.className = "evidence-kind";
  kind.textContent = String(claim.kind ?? "unknown").toUpperCase();
  const id = document.createElement("span");
  id.className = "evidence-id";
  id.textContent = claim.id ?? "Unnamed claim";
  id.title = claim.id ?? "";
  const verified = document.createElement("span");
  verified.className = `evidence-verification${claim.verified ? "" : " unverified"}`;
  verified.textContent = claim.verified ? "Verified" : "Unavailable";
  item.append(kind, id, verified);
  return item;
}

function renderInspection(inspection) {
  const signalGrid = document.querySelector("#signal-grid");
  const evidenceList = document.querySelector("#evidence-list");
  const contractClaim = inspection.evidence.find((claim) => claim.kind === "contract");
  const hasBytecode = Boolean(contractClaim?.value?.hasBytecode);

  signalGrid.replaceChildren(
    signalItem(
      "Simulation",
      inspection.signals.simulationSucceeded ? "Passed" : "Reverted",
      inspection.signals.simulationSucceeded ? "" : "danger",
    ),
    signalItem(
      "Approval scope",
      inspection.signals.approvalIsUnlimited ? "Unlimited" : "No unlimited approval",
      inspection.signals.approvalIsUnlimited ? "danger" : "",
    ),
    signalItem("Destination", hasBytecode ? "Contract bytecode" : "Externally owned", ""),
    signalItem("Hive scan", "Unavailable", "warning"),
  );
  evidenceList.replaceChildren(...inspection.evidence.map(evidenceItem));
  document.querySelector("#block-number").textContent = `Block ${inspection.blockNumber}`;
  document.querySelector("#empty-result").hidden = true;
  document.querySelector("#result-content").hidden = false;

  const state = document.querySelector("#result-state");
  const needsAttention =
    !inspection.signals.simulationSucceeded || inspection.signals.approvalIsUnlimited;
  state.textContent = needsAttention ? "Attention" : "Evidence ready";
  state.className = `result-state ${needsAttention ? "danger" : "success"}`;
}

document.querySelector("#inspection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#form-error");
  const button = document.querySelector("#inspect-button");
  error.textContent = "";

  let intent;
  try {
    intent = readIntent();
  } catch (validationError) {
    error.textContent = validationError.message;
    return;
  }

  button.disabled = true;
  button.firstElementChild.textContent = "Collecting evidence";
  try {
    const response = await fetch(`${API_BASE}/v1/pulse/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ intent }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message ?? `Inspection failed (${response.status}).`);
    renderInspection(payload);
  } catch (inspectionError) {
    error.textContent = inspectionError.message;
    const state = document.querySelector("#result-state");
    state.textContent = "Unavailable";
    state.className = "result-state danger";
  } finally {
    button.disabled = false;
    button.firstElementChild.textContent = "Run Pulse";
  }
});

document.querySelector("#clear-button").addEventListener("click", () => {
  document.querySelector("#inspection-form").reset();
  document.querySelector("#value").value = "0";
  document.querySelector("#calldata").value = "0x";
  document.querySelector("#form-error").textContent = "";
  document.querySelector("#empty-result").hidden = false;
  document.querySelector("#result-content").hidden = true;
  const state = document.querySelector("#result-state");
  state.textContent = "Idle";
  state.className = "result-state idle";
});

function sealRows(seal) {
  return [
    ["Version", seal.version],
    ["Network", seal.network],
    ["Verdict", seal.verdict],
    ["Policy", seal.policyVersion],
    ["Created", seal.createdAt],
    ["Intent digest", seal.intentDigest],
    ["Evidence digest", seal.evidenceDigest],
    ["Decision digest", seal.decisionDigest],
  ];
}

document.querySelector("#seal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const error = document.querySelector("#seal-error");
  const button = document.querySelector("#seal-search-button");
  error.textContent = "";
  const digest = document.querySelector("#seal-digest").value.trim();
  if (!digestPattern.test(digest)) {
    error.textContent = "Enter a lowercase 32-byte decision digest.";
    return;
  }
  button.disabled = true;
  button.firstElementChild.textContent = "Retrieving";
  try {
    const response = await fetch(`${API_BASE}/v1/seals/${digest}`, {
      headers: { accept: "application/json" },
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(
        response.status === 404
          ? "No persisted Seal matches this digest."
          : payload.message ?? `Seal lookup failed (${response.status}).`,
      );
    }
    const { seal, verdict, storedAt } = payload;

    const details = document.querySelector("#seal-details");
    details.replaceChildren(
      ...[...sealRows(seal), ["Score", `${verdict.score} / 100`], ["Stored", storedAt]].map(([label, value]) => {
        const row = document.createElement("div");
        const term = document.createElement("dt");
        const description = document.createElement("dd");
        term.textContent = label;
        description.textContent = value;
        row.append(term, description);
        return row;
      }),
    );
    const evidence = Array.isArray(verdict.evidence) ? verdict.evidence : [];
    document.querySelector("#seal-evidence-list").replaceChildren(
      ...evidence.map(evidenceItem),
    );
    document.querySelector("#seal-evidence-count").textContent = `${evidence.length} claim${evidence.length === 1 ? "" : "s"}`;
    document.querySelector("#seal-empty").hidden = true;
    document.querySelector("#seal-result").hidden = false;
    window.history.replaceState(null, "", `#seals/${digest}`);
  } catch (sealError) {
    error.textContent = sealError.message;
  } finally {
    button.disabled = false;
    button.firstElementChild.textContent = "Retrieve Seal";
  }
});

const hashSealDigest = window.location.hash.match(/^#seals\/(0x[a-f0-9]{64})$/)?.[1];
if (hashSealDigest) {
  switchView("seals");
  document.querySelector("#seal-digest").value = hashSealDigest;
  document.querySelector("#seal-form").requestSubmit();
}

sealButton.addEventListener("click", () => {
  sealNote.textContent = "Use the paid A2MCP endpoint from an x402-compatible agent.";
});

loadMetadata();
