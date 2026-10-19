#!/bin/sh
# prune-deploy.sh <dir>
# Removes development files from a `pnpm deploy --prod` output (the app and its workspace dependencies), so the
# runtime image carries only package.json, dist/ and production node_modules.
set -eu
dir=$1
[ -f "$dir/package.json" ] || { echo "prune-deploy: $dir/package.json is missing" >&2; exit 1; }
[ -d "$dir/dist" ] || { echo "prune-deploy: $dir/dist is missing; build before deploying" >&2; exit 1; }
for package in "$dir" "$dir"/node_modules/@quokkabot/*; do
  [ -d "$package" ] || continue
  rm -rf "$package/src" "$package/test" "$package/tsconfig.json" "$package/tsconfig.build.json" \
    "$package/vitest.config.ts" "$package/README.md"
done
rm -f "$dir/pnpm-lock.yaml" "$dir/pnpm-workspace.yaml"
