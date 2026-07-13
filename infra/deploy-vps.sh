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
  hive_capture_token=$(openssl rand -hex 32)
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
OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_MODEL=llama3.2:1b
OLLAMA_TIMEOUT_MS=20000
HIVE_STORE_FILE=/app/data/seals/hive-signatures.json
HIVE_CAPTURE_TOKEN=${hive_capture_token}
SENTINEL_HIGH_VALUE_USD=100
PER_TRANSACTION_CAP_USD=100
DAILY_CAP_USD=500
ROLLING_DAILY_SPEND_USD=0
GLOBAL_KILL_SWITCH=false
EOF
  chmod 0600 .env
fi

if ! grep -q '^OLLAMA_BASE_URL=' .env; then
  printf 'OLLAMA_BASE_URL=http://ollama:11434\nOLLAMA_MODEL=llama3.2:1b\nOLLAMA_TIMEOUT_MS=20000\n' >>.env
fi
if ! grep -q '^HIVE_CAPTURE_TOKEN=' .env; then
  printf 'HIVE_STORE_FILE=/app/data/seals/hive-signatures.json\nHIVE_CAPTURE_TOKEN=%s\n' "$(openssl rand -hex 32)" >>.env
fi
if ! grep -q '^SENTINEL_HIGH_VALUE_USD=' .env; then
  printf 'SENTINEL_HIGH_VALUE_USD=100\nPER_TRANSACTION_CAP_USD=100\nDAILY_CAP_USD=500\nROLLING_DAILY_SPEND_USD=0\nGLOBAL_KILL_SWITCH=false\n' >>.env
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
docker compose config --quiet
if docker compose ps --status running -q postgres | grep -q .; then
  bash infra/backup-vps.sh
fi
docker compose build --pull
docker compose up -d --remove-orphans --wait --wait-timeout 120
docker compose exec -T -u root api chown -R node:node /app/data/seals
docker compose ps

smoke_require_registry=false
if grep -Eq '^RECEIPT_ANCHOR_ADDRESS=0x[0-9a-fA-F]{40}$' .env && \
  grep -Eq '^ANCHOR_ISSUER_PRIVATE_KEY=0x[0-9a-fA-F]{64}$' .env; then
  smoke_require_registry=true
fi

docker compose exec -T \
  -e SMOKE_BASE_URL="${SMOKE_BASE_URL:-https://getprismpulse.xyz}" \
  -e SMOKE_ISSUE_SEAL=true \
  -e SMOKE_REQUIRE_REGISTRY="${smoke_require_registry}" \
  api node /app/scripts/smoke-production.mjs


echo "PrismPulse deployment completed at $(git rev-parse --short HEAD)."
