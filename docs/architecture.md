# PrismPulse architecture

## Trust boundary

Sentinel verdicts are deterministic. Model output may explain evidence or propose an investigation, but it cannot lower risk, override a policy, authorize a transaction, activate a Hive signature, approve coverage, or trigger a payout.

Clients submit transaction intent, never authoritative risk signals. Pulse derives chain identity, block context, destination bytecode, and simulation outcome from the configured X Layer RPC. Missing Hive signature coverage remains visible and raises risk until the registry is active.

## Evidence rules

- Every factual claim identifies its source and observation time.
- Chain-derived claims include a block number where available.
- Conflicting sources remain visible; they are not silently averaged.
- Stale evidence increases risk and can force a block.
- No evidence is a blocking condition, not permission to guess.
- Fixture and mock data are forbidden in production responses.

## Runtime services

- `api`: public metadata, paid endpoints, receipts, and health checks.
- `worker`: simulation, evidence collection, receipt anchoring, and outcome tracking.
- `agent`: OKX.AI negotiation and delivery state machine.
- `web`: operator and judge-facing dashboard.
- `postgres`: evidence, receipts, tasks, signatures, claims, and audit events.

The 4 GB VPS target requires hard container memory limits. LLM inference and archive-chain indexing remain external services.

## Receipt boundary

`POST /v1/sentinel/check` returns a verdict and a versioned evidence Seal. The Seal contains canonical SHA-256 digests for the intent, evidence set, and final decision. Evidence is sorted by claim ID and object keys are canonicalized before hashing, so transport ordering cannot change a receipt. A later worker submits only the `decisionDigest` to the X Layer anchoring contract; raw transaction evidence remains offchain.

`PrismSealRegistry` accepts each nonzero decision digest once from an authorized issuer. Issuer rotation is owner-controlled and ownership uses an explicit two-step handoff. The production owner should be a multisig; the API hot key should be an issuer only, never the owner.
