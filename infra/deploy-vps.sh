#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/prismpulse/app}
REPOSITORY=${REPOSITORY:-https://github.com/Stella112/Prismpulse-ASP.git}

if [[ ! -d ${APP_DIR}/.git ]]; then
  git clone --branch main --single-branch "${REPOSITORY}" "${APP_DIR}"
else
  git -C "${APP_DIR}" pull --ff-only origin main
fi

cd "${APP_DIR}"
umask 077

if [[ ! -f .env ]]; then
  postgres_password=$(openssl rand -hex 32)
  cat >.env <<EOF
COMPOSE_PROJECT_NAME=prismpulse
NODE_ENV=production
PORT=4021
PUBLIC_BASE_URL=https://api.getprismpulse.xyz
POSTGRES_PASSWORD=${postgres_password}
DATABASE_URL=postgresql://prismpulse:${postgres_password}@postgres:5432/prismpulse
EVIDENCE_SEAL_DIR=/app/data/seals
XLAYER_NETWORK=eip155:196
XLAYER_RPC_URL=https://rpc.xlayer.tech
RECEIPT_ANCHOR_ADDRESS=
XLAYER_EXPLORER_URL=https://www.oklink.com/x-layer
ANCHOR_JOB_DIR=/app/data/seals/anchors
ANCHOR_ISSUER_PRIVATE_KEY=
ANCHOR_WORKER_INTERVAL_MS=5000
COVERAGE_POOL_ADDRESS=
CONSOLE_ISSUANCE_ENABLED=true
PAYMENTS_ENABLED=false
OKX_API_KEY=
OKX_SECRET_KEY=
OKX_PASSPHRASE=
OKX_BASE_URL=https://web3.okx.com
PAY_TO_ADDRESS=
SENTINEL_PRICE_USD=\$0.01
LLM_PROVIDER=
LLM_API_KEY=
LLM_MODEL=
EOF
  chmod 0600 .env
fi

if ! grep -q '^CONSOLE_ISSUANCE_ENABLED=' .env; then
  printf '\nCONSOLE_ISSUANCE_ENABLED=true\n' >>.env
fi
if ! grep -q '^XLAYER_EXPLORER_URL=' .env; then
  printf 'XLAYER_EXPLORER_URL=https://www.oklink.com/x-layer\n' >>.env
fi

if ! grep -q '^RECEIPT_ANCHOR_ADDRESS=' .env; then
  printf 'RECEIPT_ANCHOR_ADDRESS=\n' >>.env
fi
if ! grep -q '^ANCHOR_ISSUER_PRIVATE_KEY=' .env; then
  printf 'ANCHOR_ISSUER_PRIVATE_KEY=\n' >>.env
fi
if ! grep -q '^ANCHOR_JOB_DIR=' .env; then
  printf 'ANCHOR_JOB_DIR=/app/data/seals/anchors\n' >>.env
fi
if ! grep -q '^ANCHOR_WORKER_INTERVAL_MS=' .env; then
  printf 'ANCHOR_WORKER_INTERVAL_MS=5000\n' >>.env
fi
docker compose build --pull
docker compose config --quiet
docker compose up -d --remove-orphans
docker compose ps

SMOKE_BASE_URL=${SMOKE_BASE_URL:-https://getprismpulse.xyz} SMOKE_ISSUE_SEAL=true pnpm smoke:production

echo "PrismPulse deployment completed at $(git rev-parse --short HEAD)."
