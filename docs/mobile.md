# The iPhone app

`apps/mobile` is an Expo (SDK 58) app with native screens for the agents, their chat and cards, and a live view of
each agent's computer for takeovers. It talks to the control plane like the web app, with a session token in the
Keychain instead of a cookie (docs/architecture.md, "Owner sessions").

## Signing in

- **Passkey**: on the server whose domain is built into the app (`QB_PASSKEY_DOMAIN`, app.quokkabot.com by
  default). iOS allows native passkeys only on domains in the app's entitlements, and only when that server lists
  the build in `QUOKKABOT_APPLE_APP_IDS`.
- **Your own server**: type its address, or scan the QR code in Settings, Connect a phone. The phone shows a code;
  approve it with your passkey in a browser where you are signed in (on the phone, or on a computer in Settings,
  Connect a phone).
- **A code**: `pairing-code` on the server (docs/install.md, "The iPhone app"), then "I have a code" in the app.

## Variants

`APP_VARIANT` picks the build: `development` (a dev client for the simulator), `preview` (internal) or
`production`. Each is its own app with its own bundle id (`com.quokkabot.app`, `.preview`, `.dev`), URL scheme and
Keychain.

## Building it

```sh
pnpm install
cd apps/mobile
APP_VARIANT=development npx expo prebuild --platform ios
xcodebuild -workspace ios/QuokkaBotDev.xcworkspace -scheme QuokkaBotDev -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO
APP_VARIANT=development npx expo start --dev-client
```

Store builds run on EAS (`eas.json`): set `QB_EAS_PROJECT_ID` and `QB_EXPO_OWNER` to your EAS project, and
`QB_PASSKEY_DOMAIN` to your server, then `eas build --profile production`. A copy published under another Apple
team also needs its own bundle identifiers (`VARIANTS` in `app.config.ts`) and its own App Store Connect app
(`ascAppId` in `eas.json`): both name Quokka Bot's own app. The GitHub workflow
`.github/workflows/mobile-eas.yml` does the same when the repository has an `EXPO_TOKEN` secret, and does nothing
without one.

Over-the-air updates reach only builds with the same native code and the same app version, so a fix ships over the
air and a new feature ships in a new, reviewed version.

## Checks

`pnpm check` typechecks the app and runs its tests (the plain TypeScript under `src/` and `test/`). `pnpm build`
bundles it and checks the licences of everything in the bundle (`scripts/check-mobile-licenses.mjs`): no GPL,
AGPL, LGPL or SSPL code ships. CI also compiles it for the simulator on macOS when a change touches it.
