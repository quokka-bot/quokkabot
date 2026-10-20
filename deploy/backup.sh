#!/usr/bin/env bash
# Off-server backups for a Quokka Bot server: the database and the agents' files, encrypted by restic and sent to an
# S3-compatible bucket (Cloudflare R2, Hetzner Object Storage, Backblaze B2...). Settings: /etc/quokkabot/backup.env.
#
#   quokkabot-backup init             create the encrypted repository in the bucket (once)
#   quokkabot-backup run              dump the database, back up, prune old snapshots (the daily timer runs this)
#   quokkabot-backup status           the last result and the snapshots
#   quokkabot-backup restore          put the latest snapshot back on this server (docs/install.md, "Restore")
#
# Never backed up: the Claude sign-ins (claude-sign-in, agents/*/cli-state), run and staging scratch, the desktop
# update feed (rebuilt from releases) and /etc/quokkabot. The secrets in /etc/quokkabot (the vault key above all) and
# the repository password are kept offline by the owner; a restore needs them.
set -euo pipefail

ETC=/etc/quokkabot
DATA=/var/lib/quokkabot
STATE=$DATA/backup
ENV_FILE=$ETC/backup.env
COMPOSE=/usr/local/bin/quokkabot-compose

die() { echo "quokkabot-backup: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing; see docs/install.md, \"Off-server backups\""
command -v restic >/dev/null || die "restic is not installed; run install.sh again"

# KEY=VALUE lines, read without executing anything; only these keys are used.
while IFS='=' read -r key value; do
  case "$key" in
    RESTIC_REPOSITORY | RESTIC_PASSWORD_FILE | AWS_ACCESS_KEY_ID | AWS_SECRET_ACCESS_KEY | AWS_DEFAULT_REGION) export "$key=$value" ;;
  esac
done <"$ENV_FILE"
for key in RESTIC_REPOSITORY RESTIC_PASSWORD_FILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  [[ -n "${!key:-}" ]] || die "$key is not set in $ENV_FILE"
done
[[ -r "$RESTIC_PASSWORD_FILE" ]] || die "$RESTIC_PASSWORD_FILE is missing"

# status.json for the control plane and monitors: when the last attempt ran, whether it worked, and the last success.
write_status() {
  local ok=$1 message=$2
  install -d -m 0700 "$STATE"
  python3 - "$STATE/status.json" "$ok" "$message" <<'EOF'
import json, os, sys, datetime
path, ok, message = sys.argv[1], sys.argv[2] == "true", sys.argv[3]
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
try:
    previous = json.load(open(path))
except (OSError, ValueError):
    previous = {}
status = {"attemptAt": now, "ok": ok, "message": message[-2000:],
          "lastSuccessAt": now if ok else previous.get("lastSuccessAt")}
with open(path + ".tmp", "w") as out:
    json.dump(status, out)
os.chmod(path + ".tmp", 0o644)
os.replace(path + ".tmp", path)
EOF
}

backup() {
  install -d -m 0700 "$STATE"
  local dump=$STATE/quokkabot.dump
  # Custom-format dump: consistent at one point in time while the server keeps running.
  "$COMPOSE" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' >"$dump.tmp"
  [[ -s "$dump.tmp" ]] || die "the database dump is empty"
  chmod 0600 "$dump.tmp"
  mv "$dump.tmp" "$dump"
  restic backup --quiet --tag daily --exclude-caches \
    --exclude "$DATA/agents/*/cli-state" --exclude "$DATA/agents/*/run" --exclude "$DATA/agents/*/staging" \
    "$dump" "$DATA/agents" "$DATA/caddy"
  rm -f "$dump"
  restic forget --quiet --keep-daily 7 --keep-weekly 5 --keep-monthly 12 --prune
  # Every day the repository structure; on Sundays also a tenth of the stored data, read back and verified.
  if [[ $(date -u +%u) == 7 ]]; then
    restic check --quiet --read-data-subset=10%
  else
    restic check --quiet
  fi
  restic snapshots --latest 1 --json | python3 -c 'import json, sys; print(json.load(sys.stdin)[-1]["short_id"])'
}

restore() {
  local snapshot=${1:-latest}
  local work=$STATE/restore
  [[ ! -e "$work" ]] || die "$work exists from an earlier restore; remove it first"
  "$COMPOSE" ps --services --status running | grep -qx db || die "the database is not running; run install.sh first"
  install -d -m 0700 "$work"
  restic restore "$snapshot" --target "$work"
  local dump=$work$STATE/quokkabot.dump
  [[ -s "$dump" ]] || die "the snapshot has no database dump"
  echo "Stopping the control plane, supervisor and egress proxy"
  "$COMPOSE" stop control supervisor egress
  echo "Restoring the database"
  "$COMPOSE" exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --exit-on-error' <"$dump"
  echo "Restoring the agents' files"
  local agent
  for agent in "$work$DATA"/agents/*/; do
    agent=${agent%/}
    local target=$DATA/agents/${agent##*/}
    install -d "$target"
    # The snapshot keeps owners and modes; the CLI sign-in on this server stays as it is.
    rsync -a --delete --exclude cli-state --exclude run --exclude staging "$agent/" "$target/"
  done
  [[ ! -d "$work$DATA/caddy" ]] || rsync -a --delete "$work$DATA/caddy/" "$DATA/caddy/"
  rm -rf "$work"
  echo "Starting the stack"
  "$COMPOSE" up --detach --wait --wait-timeout 180 >/dev/null
  echo "Restored snapshot $snapshot. Sign in again with a setup link if this server has a new domain."
}

case "${1:-}" in
  init)
    restic cat config >/dev/null 2>&1 && die "the repository already exists"
    restic init
    ;;
  run)
    if output=$(backup 2>&1); then
      write_status true "snapshot $(printf '%s' "$output" | tail -n 1)"
      printf '%s\n' "$output"
    else
      write_status false "$output"
      printf '%s\n' "$output" >&2
      exit 1
    fi
    ;;
  status)
    [[ -f "$STATE/status.json" ]] && cat "$STATE/status.json" && echo
    restic snapshots --compact
    ;;
  restore) restore "${2:-latest}" ;;
  *) die "usage: quokkabot-backup init|run|status|restore [snapshot]" ;;
esac
