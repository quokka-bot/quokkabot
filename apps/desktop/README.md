# Quokka Bot desktop

The main process owns the server session, link tokens, background work and filesystem access. The remote
renderer gets only the frozen Quokka Bot bridge. A separate bundled connect page has two IPC methods and no
network or filesystem access. Server partitions are persistent and keyed by the canonical origin.

From the repository root:

```sh
corepack pnpm@12.14.0 --filter @quokkabot/desktop typecheck
corepack pnpm@12.14.0 exec vitest run --project desktop
corepack pnpm@12.14.0 --filter @quokkabot/desktop build
corepack pnpm@12.14.0 --filter @quokkabot/desktop start
QUOKKABOT_E2E_SERVER=https://app.example.com node apps/desktop/scripts/e2e.mjs
```

`electron .` also starts the previously built development app from this directory. E2E needs an accessible
Quokka Bot server with a trusted TLS certificate, or a `.localhost` HTTP server. Use two hosts on the same site,
for example `app.quokkabot.localhost` and `view.quokkabot.localhost`. E2E creates a temporary userData directory
for every test. Its build stubs external browser opening in main, and the runner restores an ordinary build
afterward. `--list` checks test discovery without launching Electron. No test server is started by this package.

Closing the app window destroys it and its streams. The menu bar app keeps polling every ten seconds. Cmd+Q
quits; the Dock, tray, menu and second launch reopen the window. Stop everything uses main's authenticated HTTP
session and works when the renderer is closed or has crashed. Its notification reports the server's actual
network-freeze and sandbox-stop results.

Downloads reserve unique filenames with exclusive creation and remove partial files after a failure. The default
directory is `~/Downloads/Quokka Bot`. Page downloads must come from the selected server. Clicking a saved-file
notification reveals the file in Finder. The download bridge resolves only after the bytes are written.

## macOS packaging

```sh
corepack pnpm@12.14.0 --filter @quokkabot/desktop dist:mac
```

Set `QUOKKABOT_MAC_IDENTITY` to a Developer ID Application identity for a signed build. Without it, artifacts are
explicitly named unsigned development builds and updates are disabled. `QUOKKABOT_RELEASE=1` makes a missing
identity fatal. Ad-hoc signing is refused. `QUOKKABOT_BUNDLE_ID` optionally overrides `org.quokkabot.app`.
Notarization is enabled only when all of `APPLE_API_KEY` (key file), `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER` are
present. Partial credentials are an error. No signing secrets are stored in this package.

The builder applies the security fuses before signing and emits arm64 DMG and ZIP artifacts. Hardened-runtime
entitlements allow JIT and unsigned executable memory; library validation stays enabled. Verify the packaged
build on macOS before distribution, including the menu bar, notifications, login item and Developer ID update.

Updates are supported only in signed macOS packages. Main replaces the reserved bootstrap feed with
`<serverOrigin>/desktop/` before checking. It fences remote update requests and redirects to that exact origin,
checks artifact paths, downloads in the background and installs only through the owner's bridge request.
Squirrel.Mac performs the same-identity signature check during installation. Its authenticated local helper
server is part of electron-updater. Changing servers cancels pending background work and clears the local session.

The public-suffix snapshot includes private hosting suffixes so independent tenants are not accepted as the
same site. Its data provenance and license are in `build/PUBLIC-SUFFIX-NOTICE.txt`; refresh the snapshot when
updating releases. No additional runtime package is needed. Renderer settings, device management and bridge
consumption belong to the separate web slice.
