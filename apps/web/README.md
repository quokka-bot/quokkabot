# Owner web app

React app served from `dist/` by control at the app origin. Control must serve `index.html` for app routes such
as `/agents/:agentId/files` and `/tasks/:taskId`, while preserving `/api` routes. Build assets use `/assets/`.
There are no runtime configuration variables or external font, image or script dependencies.

## Entry points

- `src/api.ts`: all HTTP access, request and response validation, download handling, SSE decoding and terminal
  frame encoding/decoding. JSON responses use the shared schemas, with composed schemas for page wrappers.
- `src/app.tsx`, `src/main.tsx`: routes, session routing, global navigation and TanStack Query initialization.
- `src/auth.tsx`: setup, passkey sign-in and fresh verification. The setup ticket is captured from the fragment,
  removed from browser history and sent only in POST bodies. It is not persisted.
- `src/desktop.tsx`, `src/link.tsx`: desktop bridge typing and browser-confirmation flows. `/link` removes the
  display code from the fragment before requests, keeps it in sessionStorage across browser sign-in, then
  approves using the link-specific passkey options and assertion. Done states remove the saved code.
- `src/logins.tsx`: login metadata and write-only add/edit forms, reused inline by owner login requests.
- `src/tasks.tsx`, `src/task-stream.tsx`, `src/requests.tsx`: inbox, composer, history, task details and owner
  actions. Model text is rendered as React text. Model-provided URLs remain text.
- `src/computer.tsx`, `src/terminal-session.tsx`: one-time viewer ticket per mount, control lease, power,
  attended mode, kill switch and fresh-authenticated terminal. The xterm bundle loads after fresh verification.
- `src/files.tsx`, `src/download-link.tsx`, `src/domains.tsx`, `src/audit.tsx`, `src/settings.tsx`: remaining
  agent sections.
- `src/ui.tsx`, `src/style.css`: shared presentation, visibility-aware polling, elapsed time, safe areas,
  responsive layout and system light/dark themes.

## Behavior that matters

Mutations are never automatically retried. A missing response may follow an action that already happened.
HTTP 401 responses clear the query cache and navigate to sign-in, including file downloads. Server errors
appear beside the initiating action. File responses must have attachment disposition and `nosniff` protection;
the app buffers a Blob to handle errors before handing the download to the browser.

The task stream starts with `after=0` to replay history. Native EventSource reconnects retain `Last-Event-ID`.
A manual reconnect sends `after=<last validated seq>`. Duplicates are ignored. Wrong task IDs, malformed
envelopes, mismatched SSE IDs and sequence gaps close the connection with a visible error. A draft occupies
one text block; the next `assistant_text` replaces that draft even when tool events appeared between them.
Task and run status come from control data and typed state/run events. Waiting times use request creation
timestamps or state-event timestamps rather than treating arbitrary task updates as the start of a wait.

Polling for agents and inbox runs every five seconds while the document is visible. The terminal uses WSS,
validates every frame, sends fitted dimensions on connection and resize, and disposes the socket, input
subscription, observer and xterm instance on unmount. Kill engagement dispatches immediately; release first
completes a fresh check. Viewer URLs must use HTTPS on a separate origin.

When `window.quokkabotDesktop` is present, sign-in and fresh checks use the bridge and display the browser code
with cancellation and retry. Main owns the flow token, cookies and downloaded bytes. Download controls pass
typed file targets to main; the browser version retains the existing links and attachment validation. Native
navigation uses app routes only; `/?new=1` focuses the first agent's task composer once per navigation.

Global `/settings` and each agent's Settings section show signed-in devices and revocation. Desktop mode adds
launch-at-login, notification preferences, downloads, server switching and polled update status. Update install
is offered only in the ready state.

Logins show only metadata. Forms never load saved passwords or 2FA secrets, omit an empty replacement password
and 2FA value, and use an explicit control to remove 2FA. Sites use DomainPattern; new 2FA values must be base32
or an otpauth://totp URI. Secrets stay in the form until a successful save, then are cleared. Neither input
secrets nor mutation inputs are put in the query cache or browser storage. Saving an inline login request uses
the same POST as the Logins screen; control answers matching open requests.

`public/manifest.webmanifest`, the PNG icons and `index.html` supply standalone-install metadata, an Apple touch
icon and theme colour. The desktop source icon was resized locally with macOS sips to actual 512 and 192 sizes.

## Missing shared response schemas

No shared files were edited, and the desktop slice needs no contract changes. The following pre-existing route
responses are documented but have no exported zod schema.
`src/api.ts` validates them locally. For one source of truth, add these exports to `packages/shared/src/api.ts`:

- `RegistrationOptionsResponse`: the JSON shape of SimpleWebAuthn's
  `PublicKeyCredentialCreationOptionsJSON`, returned directly by setup options.
- `AuthenticationOptionsResponse`: the JSON shape of `PublicKeyCredentialRequestOptionsJSON`, returned directly
  by sign-in options and fresh-auth options.
- `FreshAuthResponse`: `{ freshUntil: IsoTime }`, returned by fresh-auth verification.
- `AuditVerifyResponse`: the same discriminated union as `AuditVerification` in `shared/src/node.ts`:
  `{ ok: true, count: number, head: Sha256Hex }` or
  `{ ok: false, count: number, failedAtSeq: number, reason: string }`.
- An explicit success status/body for logout and domain-rule deletion. The client currently accepts HTTP 204
  or a JSON `{}` response.

These additions do not require new routes. The audit verification assumption is especially worth confirming:
the route comment does not specify the type of `head`; this client follows the existing Node helper's hash
string rather than the audit page's `{ seq, hash }` checkpoint.

## Verification

From the repository root:

```sh
corepack pnpm@12.14.0 exec vitest run --project web
corepack pnpm@12.14.0 --filter @quokkabot/web typecheck
corepack pnpm@12.14.0 --filter @quokkabot/web build
```

The 63 jsdom tests in `test/` mock fetch, EventSource, WebSocket, xterm, the desktop bridge and passkeys. They cover streaming and
reconnect, plain-text output, invalid events/responses, question replies, domain decisions, immediate kill,
fresh-authenticated release and cancelled authentication, navigation, fresh viewer tickets, setup ticket
handling, unauthorized downloads, terminal frames/resize/disposal, task pagination and visibility-aware polling.
Desktop coverage includes approval/refusal/expiry/cancellation/errors and retry, fresh checks for terminal and
kill release, link-specific approval assertions, sign-in return with a stored code, device revocation, settings,
updates, native navigation/focus, typed downloads, login CRUD and inline requests on Home and task pages.

The verification host runs Node 26.8.2. Code targets ES2024 and uses browser APIs and Node 24-compatible build
APIs; it has not been executed under a separate Node 24 binary in this session.

Layout was reviewed in CSS for 390×844 and 1440×900: below 760px the page has one column and scrollable section
tabs; at laptop widths agents and inbox use two columns and agent navigation becomes a sidebar. Task detail
uses two columns above 1100px, with owner actions first on smaller screens. Controls have 44px minimum touch
targets, form fields use 16px text and padding includes safe-area insets. This is a static review, not a browser
layout measurement or screenshot verification.

No live browser or Electron session was run for this slice. Real WebAuthn, desktop cookie exchange and reload,
native downloads, notifications and update installation remain integration checks against the native app and
control plane. All requested web tests, typecheck and production build passed; no socket-based tests were needed.
