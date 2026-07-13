#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/prismpulse/app}
BACKUP_DIR=${BACKUP_DIR:-/opt/prismpulse/backups}
RETENTION_DAYS=${RETENTION_DAYS:-14}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
destination="${BACKUP_DIR}/${timestamp}"
temporary="${destination}.tmp"

cd "${APP_DIR}"
umask 077
mkdir -p "${temporary}"

docker compose exec -T postgres pg_dump -U prismpulse -d prismpulse | gzip -9 >"${temporary}/postgres.sql.gz"
project=$(docker compose config --format json | jq -r ''.name'')
docker run --rm \
  -v "${project}_evidence_seals:/source:ro" \
  -v "${temporary}:/backup" \
  alpine:3.21 tar -C /source -czf /backup/evidence-seals.tar.gz .
sha256sum "${temporary}"/* >"${temporary}/SHA256SUMS"
mv "${temporary}" "${destination}"
find "${BACKUP_DIR}" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" -exec rm -rf -- {} +

echo "PrismPulse backup created: ${destination}"
