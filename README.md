# PrismPulse ASP

PrismPulse is a transaction-underwriting agent for agent commerce. It verifies proposed onchain actions, emits evidence-backed verdicts, seals receipts on X Layer, and can attach narrowly defined conditional coverage.

## Product spine

1. **Pulse** gathers timestamped evidence from declared sources.
2. **Refract** normalizes, cross-checks, and marks stale or conflicting claims.
3. **Forge** produces a deterministic `ALLOW`, `WARN`, or `BLOCK` verdict.
4. **Seal** canonicalizes the report and anchors its digest on X Layer.

Sentinel is the transaction gate, Hive supplies reviewed attack signatures, Bond provides capped objective coverage, and OnchainJournal records outcomes.

## Development

```bash
pnpm install
pnpm test
pnpm contracts:test
pnpm dev
```

Copy `.env.example` to `.env` locally and provide secrets through the deployment environment. Never commit wallet keys, VPS passwords, or OKX credentials.

## Seal contract roles

- The owner authorizes and revokes receipt issuers and should be a multisig in production.
- An issuer anchors API-generated decision digests and should use a separate low-balance hot key.
- Evidence and transaction details remain offchain; only the canonical decision digest is anchored.

## Mainnet policy

Production targets X Layer mainnet (`eip155:196`). Every contract and payment path must pass local, testnet, and mainnet-fork gates before mainnet deployment. Coverage remains disabled until its contracts are independently reviewed and funded with explicit caps.
