#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=${APP_DIR:-/opt/prismpulse/app}
LOG_DIR=${LOG_DIR:-/opt/prismpulse/logs}
BACKUP_DIR=${BACKUP_DIR:-/opt/prismpulse/backups}
MONITOR_BASE_URL=${MONITOR_BASE_URL:-https://getprismpulse.xyz}

mkdir -p "${LOG_DIR}" "${BACKUP_DIR}"
temporary=$(mktemp)
trap 'rm -f "${temporary}"' EXIT

crontab -l 2>/dev/null | awk '
  $0 == "# BEGIN PRISMPULSE OPS" { managed = 1; next }
  $0 == "# END PRISMPULSE OPS" { managed = 0; next }
  !managed { print }
' >"${temporary}" || true

cat >>"${temporary}" <<EOF
# BEGIN PRISMPULSE OPS
*/5 * * * * cd ${APP_DIR} && /usr/bin/flock -n /tmp/prismpulse-monitor.lock /usr/bin/docker compose exec -T -e MONITOR_BASE_URL=${MONITOR_BASE_URL} -e MONITOR_REQUIRE_LAUNCH=true api node /app/scripts/monitor-production.mjs >>${LOG_DIR}/monitor.log 2>&1
17 2 * * * /usr/bin/flock -n /tmp/prismpulse-backup.lock /usr/bin/bash ${APP_DIR}/infra/backup-vps.sh >>${LOG_DIR}/backup.log 2>&1
# END PRISMPULSE OPS
EOF

crontab "${temporary}"
echo "PrismPulse operations schedules installed:"
crontab -l | sed -n '/# BEGIN PRISMPULSE OPS/,/# END PRISMPULSE OPS/p'
