# PrismPulse — The Underwriter and Intelligence Layer for the Agent Economy

PrismPulse is a production agent on X Layer that combines transaction underwriting, market intelligence, evidence receipts, conditional bond coverage, and agent-to-agent service operations. It serves both crypto-native agents and people using OKX.AI: callers submit a transaction or analysis request, while PrismPulse gathers the evidence, applies deterministic safety rules, uses a private local Llama model for explanation, and returns a machine-readable result.

- Console: https://getprismpulse.xyz
- API: https://api.getprismpulse.xyz
- OKX.AI agent: https://www.okx.ai/agents/5738?source=search
- Network: X Layer mainnet (`eip155:196`)
- Hackathon category: Software Services, with financial-safety capabilities

## What PrismPulse does

### 1. Sentinel transaction underwriting

Sentinel checks a proposed X Layer transaction before execution. The caller supplies intent; PrismPulse independently collects RPC and contract evidence, checks declared purpose, recipient, calldata, value, slippage, signatures, Hive intelligence, and configured risk policy, then returns `ALLOW`, `WARN`, or `BLOCK`.

A successful result includes a canonical Evidence Seal. The seal is stored offchain and its digest is anchored on X Layer so another agent can verify that the decision record was not altered.

### 2. Market intelligence and trading advice

The market service analyzes any supported X Layer token, not only meme coins. It combines authenticated OKX Onchain OS v6 evidence:

- live token price, liquidity, market capitalization, and holders;
- recent candles, momentum, volatility, and volume trend;
- advanced token-risk metadata and holder concentration;
- smart-money signals when available;
- local `llama3.2:1b` reasoning for a concise explanation.

The deterministic engine returns a bounded prediction (`BULLISH`, `NEUTRAL`, `BEARISH`, or `RISK_BLOCKED`) and action (`CONSIDER_ENTRY`, `WATCH`, `WAIT`, or `AVOID`). Honeypot indicators, severe risk controls, extreme concentration, and critically low liquidity can hard-block an entry. Llama explains the evidence but cannot override the deterministic safety decision.

Market advice is evidence-backed analysis, not a profit guarantee. Advice does not silently become a trade: DEX execution remains a separate policy-gated action.

### 3. Hive honeypot network

Hive passively captures adversarial payload patterns from authenticated decoys, deduplicates them, and propagates reviewed signatures into Sentinel. The next protected request can therefore block the same attack class.

### 4. PrismBond coverage pool

PrismBond is a deployed, funded X Layer pool for narrowly defined objective coverage. Stakers supply capital, coverage locks exposure, premiums accrue to the pool, and eligible compensation follows per-transaction and global caps. Guardian pause, veto, kill switch, authorized-oracle, and delayed non-trivial payout controls limit loss.

Coverage is conditional, capped, and subject to the onchain policy; it is not unlimited insurance.

### 5. Bounded DEX execution and GasVault

The runtime supports policy-bounded OKX DEX quotes and swaps. It rejects wrong-chain routes, excessive slippage, unsafe token evidence, disabled execution, and breached size or daily-loss limits. GasVault monitors OKB and stable reserves and can refill OKB only when the configured threshold, target, reserve, and execution controls permit it.

### 6. A2A negotiation and escrow lifecycle

The live OKX A2A daemon supports offer intake, negotiation, acceptance, escrow-aware delivery, buyer confirmation, ratings, rejection, disputes, and arbitration handoff. This is how users without coding knowledge can purchase PrismPulse underwriting through the OKX.AI marketplace.

### 7. Five-part Sentinel and receipts

The full product flow is:

1. **Pulse** — collect timestamped evidence.
2. **Refract** — normalize and detect stale or conflicting claims.
3. **Forge** — produce the deterministic verdict.
4. **Seal** — persist and anchor the canonical decision digest.
5. **Sentinel** — enforce the final transaction gate and coverage policy.

OnchainJournal-compatible records preserve outcomes for audit and reputation workflows.

## Live paid services

| Service | Type | Price | Endpoint |
| --- | --- | ---: | --- |
| Sentinel Transaction Check | A2MCP / x402 | 0.01 USDT | `POST /v1/sentinel/check` |
| Market Intelligence and Trading Advice | A2MCP / x402 | 0.03 USDT | `POST /v1/market/advice` |
| Agent Risk Underwriting | A2A | 0.03 USDT starting price | OKX.AI agent 5738 |

Valid unpaid A2MCP requests return a standard x402 v2 HTTP 402 challenge on X Layer. Malformed requests return field-named HTTP 400 errors before the payment middleware. For paid market requests, PrismPulse prefetches required market evidence before settlement so unavailable upstream data cannot create a paid dead end.

## API surfaces

- `GET /health` — service health.
- `GET /v1/metadata` — capabilities, registry state, prices, schemas, and examples.
- `GET /v1/sentinel/schema` — machine-readable Sentinel request schema.
- `POST /v1/sentinel/check` — paid transaction underwriting and Evidence Seal.
- `GET /v1/market/schema` — machine-readable market request schema and example.
- `POST /v1/market/advice` — paid X Layer token prediction and trading advice.
- `POST /v1/pulse/inspect` — server-collected X Layer evidence without a verdict.
- `POST /v1/console/seals` — separately gated browser Seal issuance.
- `GET /v1/seals/:decisionDigest` — persisted Evidence Seal retrieval.
- `POST /v1/hive/capture` — authenticated passive Hive capture.

### Market request example

```json
{
  "market": {
    "tokenContractAddress": "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "horizon": "1h",
    "riskMode": "balanced"
  }
}
```

Supported horizons are `15m`, `1h`, `4h`, and `24h`. Supported risk modes are `conservative`, `balanced`, and `aggressive`. The service also accepts flat bodies and common marketplace wrappers such as `input` and `task`.

## Verified X Layer contracts

- PrismSealRegistry: `0x86f9fCBdE02D25efebf0567b82f49C629FD7dE3c`
- PrismBondPool: `0xB51Fb06eC4Ca30a07E443B15F7aBdF79CB60a366`
- Coverage/payment asset (USD₮0): `0x779Ded0c9e1022225f8E0630b35a9b54bE713736`

Registry confirmation verifies deployed bytecode, ownership, and the authorized issuer. Bond confirmation verifies bytecode, asset, owner, guardian, payout delay, caps, shares, capital, and exposure.

## Safety boundaries

- X Layer mainnet is enforced for payment and execution.
- Buyer request bodies are validated before payment settlement.
- Required market price and candle evidence fail closed.
- Optional risk or signal sources are reported as unavailable and reduce confidence.
- Local Llama output cannot override deterministic blocking rules.
- Private keys and OKX credentials stay in environment-managed VPS secrets.
- DEX execution and GasVault have independent enable flags, thresholds, limits, and journals.
- Coverage has explicit capital, exposure, payout, pause, veto, and kill-switch constraints.
- A2A and API daemons run independently so one path cannot silently replace the other.

## Development and verification

```bash
pnpm install
pnpm -r build
pnpm -r lint
pnpm -r test
pnpm contracts:test
pnpm smoke:production
```

Registry tools:

```bash
pnpm registry:simulate
pnpm registry:deploy
pnpm registry:confirm
```

Bond tools:

```bash
pnpm bond:deploy
pnpm bond:confirm
```

Never commit wallet keys, VPS passwords, email codes, or OKX credentials.
