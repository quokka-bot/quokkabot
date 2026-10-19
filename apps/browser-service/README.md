# Browser service

`src/main.ts` listens on `0.0.0.0:7800`. Every route, including health, requires the control plane's bearer
secret. Required environment: `QUOKKABOT_BROWSER_SERVICE_TOKEN`, `QUOKKABOT_CHROME`, `QUOKKABOT_AGENT_BROWSER`,
`QUOKKABOT_PROXY`. The image runs this service as the container user and installs `agent-browser-policy.json`
at `/etc/quokkabot/agent-browser-policy.json`. Chrome's managed policies remain the image's responsibility.

`createBrowserService(deps)` is asynchronous and injects process execution, CDP, clock, and filesystem roots.
It loads durable downloads before returning. `start()` supervises Chrome and configures CDP; the exported
`server` is a standard Node HTTP server. Tests use `handle()` to exercise the same authenticated routes without
opening a listening socket. Production roots are `/staging`, `/tmp/quokkabot-browser` and `~/.agent-browser`.
Build the shared workspace package before starting the compiled service.

Commands execute in one queue. Repeated command ids return the same result; reusing an id for a different
request is invalid. The service retains 500 results. Only control advances lease generations; changed leases
must carry a newer generation. A lease transition fences queued commands immediately and waits up to ten
seconds for the current command. If that grace expires, the service reads the daemon pid from its socket
directory and sends `SIGKILL`, cancels the CLI and waits for its exit before applying the new lease. The command
returns `outcome_unknown`; no replacement daemon starts until the command ends, and readiness must be checked
again. Snapshot counters remain monotonic while cached generations and refs are discarded, preventing an old
snapshot number from aliasing a later snapshot after takeover.

`POST /v1/secret-fill` accepts the shared `SecretFillRequest` from control using the same bearer token, queue,
lease generations and command-id cache. It is separate from model-chosen browser operations. The service
validates the tab's latest snapshot and ref before `focus @ref`; it switches targets only when necessary,
requiring a new snapshot after a switch because agent-browser discards refs. DevTools inspects the focused
element in each frame's service-created isolated world, including a separate target session for out-of-process
iframes. It reads field metadata and the frame's security origin, never the field value or the page's main world.
The focused frame must match an allowed host pattern and use HTTPS. Under `NODE_ENV=test`, `*.localhost`
fixture hosts may use HTTP with an explicit matching pattern. Passwords require password inputs; usernames require text, email or tel;
codes require one-time-code autocomplete or a text, number or tel input with numeric inputmode or maxlength
4–10. Password inputs never accept username or code fills. Disabled and read-only inputs are refused.

After validating the site and kind, CDP selects all and deletes the existing text, rechecks the focused frame
and field, then uses `Input.insertText` on the page target. Optional submission sends Enter through CDP too.
Agent-browser receives only the ref. Responses and cached results contain no value; keyed, process-local HMAC
fingerprints detect request-id reuse without retaining secret values or exposing guesses of short codes.
Request bodies, CDP payloads and upstream errors are never logged. A takeover that exceeds the ten-second
grace kills the daemon, closes the service's CDP connection and aborts the fill with `outcome_unknown`, fencing
all later input. A fill that cannot inspect a frame fails closed. Real Chrome frame behavior, input dispatch
and isolation still require the image integration run; validation and input are separate CDP messages, and
the intended site's scripts can observe a value entered into their own field.

Tab handles follow CDP target identities across agent-browser daemon restarts. Page navigation events, URL
changes, lease transitions and daemon changes discard refs. Snapshot page 1 creates a generation; later pages
read that same masked snapshot without rebuilding it. Every textbox, searchbox, spinbutton and combobox line
is reconstructed with its role, accessible name, ref and `[hidden]`; descendant text is omitted. Comboboxes are
masked conservatively because the tree does not reliably identify which ones are editable. Ref-looking page
text cannot grant a handle: refs must also exist in the daemon's structured ref table. Before every type action,
the service privately reads the ref's `type` and `autocomplete` attributes and refuses password, code and card
fields. Password-like names and bullets provide a second signal. Attribute values are never returned through
the API, which has no `get` operation.

All agent-browser invocations use a fixed prefix and argv arrays. The supplied CLI docs do not promise `--`
support for all operands, so leading hyphens and NUL are rejected in text, options and wait operands. Newlines
remain a single argv element. Text disappearance uses an internally generated quoted `text=` selector with
`--state hidden`; URL containment uses an escaped glob. No executable wait or selector comes from the API.

Readiness requires CDP download configuration and a daemon with its stream confirmed disabled. The daemon pid
and socket identity are checked around CLI invocations. A changed daemon is gated again; uncertain mutations
are never repeated. PNG screenshots come from agent-browser; oversized images are captured again through the
service's private CDP connection with a reduced viewport scale. JPEG is never used.

Download events update GUID-keyed records persisted with file fsync, atomic rename and directory fsync. Files
are opened with `O_NOFOLLOW`, checked for regular-file type, link count and exact recorded size, hashed and
streamed through the same descriptor. Acknowledgement removes both staging content and its durable record.
The listing's `since` filter includes completion time and active downloads, so long transfers are discoverable
when they finish. Shutdown uses `Browser.close` and waits for Chrome exit; it does not substitute a signal.

Validation from the repository root:

```sh
corepack pnpm@12.14.0 exec vitest run --project browser-service
corepack pnpm@12.14.0 --filter @quokkabot/browser-service typecheck
corepack pnpm@12.14.0 --filter @quokkabot/browser-service build
```

Tests use a generated executable Node CLI fixture and injected CDP events. A separate fake CDP WebSocket server
and real HTTP transport test skip only when listening is refused with `EPERM` or `EACCES`. Real Chrome for
Testing, agent-browser 0.39.1 action-policy names/JSON responses, and Node 24 image startup still require the
image integration run. The local runtime is Node 26.8.2; implementation APIs are available in Node 24. A CDP
outage can leave a download in progress if Chrome's terminal event was missed; the service does not infer
completion from a pathname or file size.

`POST /v1/site-data/clear` accepts the shared `{ patterns }` contract and returns `{ cookiesDeleted,
originsCleared }`. Browser-level CDP reads all cookies and open page targets. Matching cookie domains (without
their leading dot) and page hosts use the shared wildcard matcher. The service removes matching cookies,
restores unrelated cookies with their writable metadata, and clears all storage for both http and https
origins, including open tabs with nondefault ports. The operation runs in the command queue and invalidates
refs even on failure. Every CDP or response-validation failure returns 500 with the failing step. Cookie
rewrites are not atomic; a failed restore can remove unrelated cookies, so the caller must treat an error as
incomplete cleanup. An unrelated opaque partitioned cookie prevents the rewrite before any cookie is changed.
