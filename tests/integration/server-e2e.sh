#!/usr/bin/env bash
# Self-test of a running install, without a model: run on the server as root from the repository checkout.
# 1. opens a diagnostic run, 2. runs the red-team shell probes in the tools sandbox, 3. runs the MCP attacks and the
# browser end-to-end from the CLI network (exactly where the CLI sits), 4. checks the live view through Caddy,
# 5. closes the run. Exit code is the number of failed groups.
set -uo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
fixture_base="${QUOKKABOT_FIXTURE_BASE:?set QUOKKABOT_FIXTURE_BASE to the published test site, e.g. https://<project>.pages.dev}"
fixture_host="$(printf '%s' "$fixture_base" | sed -E 's#^https://([^/]+).*#\1#')"
set -a; . /etc/quokkabot/quokkabot.env; set +a
compose=/usr/local/bin/quokkabot-compose
failed=0

start=$($compose exec -T control node dist/main.js diagnostic start "--allow=$fixture_host") || { echo "diagnostic start failed"; exit 1; }
json() { printf '%s' "$start" | python3 -c "import json,sys; print(json.load(sys.stdin)['$1'])"; }
run_id=$(json runId); token=$(json mcpToken); session=$(json sessionToken); agent=$(json agentId); mcp_url=$(json mcpUrl)
cleanup() { $compose exec -T control node dist/main.js diagnostic end "$run_id" "$session" >/dev/null || echo "diagnostic end failed"; }
trap cleanup EXIT

echo "== runtimes and sockets"
for c in qb-cli-1 qb-tools-1 qb-browser-1; do
  rt=$(docker inspect -f '{{.HostConfig.Runtime}}' "$c"); echo "$c runtime=$rt"; [ "$rt" = runsc ] || failed=$((failed + 1))
done
with_sock=$(docker ps -q | xargs docker inspect -f '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' | grep docker.sock | awk '{print $1}' | tr '\n' ' ')
echo "containers with the Docker socket: $with_sock"
[ "$(echo "$with_sock" | wc -w)" = 1 ] && echo "$with_sock" | grep -q supervisor || failed=$((failed + 1))

echo "== red team: the model's shell (tools sandbox)"
docker exec -i -u 1000:1000 qb-tools-1 bash -s < "$here/redteam/tools-shell.sh" || failed=$((failed + 1))

echo "== red team: tool calls, from the CLI network"
docker run --rm --network qb-cli-1 -v "$here:/t:ro" node:24-trixie-slim node /t/redteam/mcp-attacks.mjs "$mcp_url" "$token" || failed=$((failed + 1))

echo "== red team: the CLI's network position (only the CLI runs there)"
docker run --rm --network qb-cli-1 -v "$here:/t:ro" node:24-trixie-slim \
  node /t/redteam/cli-network.mjs "${QUOKKABOT_CLI_PROXY:-10.231.1.2:3128}" "${QUOKKABOT_CONTROL_ON_CLI_NET:-10.231.1.3}:8080" || failed=$((failed + 1))

echo "== browser end to end, from the CLI network"
docker run --rm --network qb-cli-1 -v "$here:/t:ro" node:24-trixie-slim \
  node /t/integration/server-e2e.mjs "$mcp_url" "$token" "$fixture_base" /t/fixtures/site || failed=$((failed + 1))

echo "== login vault in real Chrome, from the CLI network"
owner_api() {
  if [ -n "${3:-}" ]; then
    curl -s -X "$1" -H "origin: https://$QUOKKABOT_DOMAIN" -H "cookie: qb_session=$session" -H "content-type: application/json" --data "$3" "https://$QUOKKABOT_DOMAIN$2"
  else
    curl -s -X "$1" -H "origin: https://$QUOKKABOT_DOMAIN" -H "cookie: qb_session=$session" "https://$QUOKKABOT_DOMAIN$2"
  fi
}
vault_user="fixture-$(openssl rand -hex 4)@example.com"
vault_pass="pw-$(openssl rand -base64 18 | tr -d '/+=')"
vault_totp=JBSWY3DPEHPK3PXP
login_json=$(owner_api POST "/api/agents/$agent/logins" "{\"name\":\"Fixture\",\"sites\":[\"$fixture_host\"],\"username\":\"$vault_user\",\"password\":\"$vault_pass\",\"totp\":\"$vault_totp\"}")
other_json=$(owner_api POST "/api/agents/$agent/logins" "{\"name\":\"Elsewhere\",\"sites\":[\"elsewhere.example\"],\"username\":\"$vault_user\",\"password\":\"$vault_pass\",\"totp\":\"$vault_totp\"}")
login_id=$(printf '%s' "$login_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
other_id=$(printf '%s' "$other_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
if [ -n "$login_id" ] && [ -n "$other_id" ]; then
  docker run --rm --network qb-cli-1 -v "$here:/t:ro" -e QB_LOGIN_ID="$login_id" -e QB_OTHER_LOGIN_ID="$other_id" \
    -e QB_USERNAME="$vault_user" -e QB_PASSWORD="$vault_pass" -e QB_TOTP_SECRET="$vault_totp" node:24-trixie-slim \
    node /t/integration/vault-e2e.mjs "$mcp_url" "$token" "$fixture_base" || failed=$((failed + 1))
  logs=$($compose logs --since 10m control 2>&1)
  if printf '%s' "$logs" | grep -qF "$vault_pass"; then echo "password found in control logs"; failed=$((failed + 1)); else echo "control logs: no password"; fi
  for id in "$login_id" "$other_id"; do
    [ "$(owner_api DELETE "/api/logins/$id")" = "{}" ] || { echo "could not delete fixture login $id"; failed=$((failed + 1)); }
  done
else
  echo "could not save the fixture logins: $login_json $other_json"; failed=$((failed + 1))
fi

echo "== live view through Caddy"
ticket_url=$(curl -s -X POST -H "origin: https://$QUOKKABOT_DOMAIN" -H "cookie: qb_session=$session" "https://$QUOKKABOT_DOMAIN/api/agents/$agent/view-ticket" | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
jar=$(mktemp)
code=$(curl -s -L -c "$jar" -b "$jar" -o /dev/null -w '%{http_code}' "$ticket_url"); echo "viewer page: $code"; [ "$code" = 200 ] || failed=$((failed + 1))
view_cookie=$(awk '$6=="qb_view"{print $7}' "$jar")
ws=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: https://$QUOKKABOT_VIEW_DOMAIN" -H "Cookie: qb_view=$view_cookie" \
  --max-time 5 "https://$QUOKKABOT_VIEW_DOMAIN/agents/$agent/api/websockets"); echo "viewer websocket: $ws"; [ "$ws" = 101 ] || failed=$((failed + 1))
evil=$(curl -s -o /dev/null -w '%{http_code}' --http1.1 -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Origin: https://evil.example" -H "Cookie: qb_view=$view_cookie" \
  --max-time 5 "https://$QUOKKABOT_VIEW_DOMAIN/agents/$agent/api/websockets"); echo "viewer websocket from another origin: $evil"; [ "$evil" = 403 ] || failed=$((failed + 1))
api=$(curl -s -o /dev/null -w '%{http_code}' "https://$QUOKKABOT_VIEW_DOMAIN/agents/$agent/api/tokens" -b "$jar"); echo "Selkies API through the viewer: $api"; [ "$api" = 404 ] || failed=$((failed + 1))
rm -f "$jar"

echo "== failed groups: $failed"
exit "$failed"
