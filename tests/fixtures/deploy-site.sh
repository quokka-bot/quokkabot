#!/usr/bin/env bash
# Publishes the test site (download fixtures and the red-team probe) to a Cloudflare Pages project.
# Needs CLOUDFLARE_API_TOKEN (Pages edit) and CLOUDFLARE_ACCOUNT_ID. Usage: deploy-site.sh <pages project name>
set -euo pipefail
project="${1:?pages project name}"
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mktemp -d)"
cp "$here"/site/* "$here"/site/_headers "$out"/
cp "$here/../redteam/browser-probe.html" "$out/index.html"
cd "$out"
npx --yes wrangler@4 pages deploy . --project-name "$project" --branch main --commit-dirty=true
