# Architecture (stage 1: the agent's own computer)

What runs today. What comes next is in [ROADMAP.md](../ROADMAP.md).

## Containers

```
 owner's browser / phone ──https──> caddy ──> control ───────────── db (PostgreSQL)
        (app origin and viewer origin)       │  │  │  └─ unix socket ─> supervisor ─> Docker (runsc)
                                             │  │  └─ ctl network ──> egress (policy API)
                       MCP on the cli network│  └─ browser network ─> browser service, Selkies
                                             ▼
   cli sandbox (gVisor)        tools sandbox (gVisor)          browser sandbox (gVisor)
   Claude Code CLI only        shell, documents, files         Xfce, Chrome for Testing,
   owner's sign-in state       no network at all               Selkies, browser service
        │                                                       │
        └── egress cli listener                                 └── egress browser listener ──> internet
```

| Container | Trust | What it does |
|---|---|---|
| caddy | edge | TLS for the app origin and the viewer origin |
| control | trusted | Owner API and web app, passkey sign-in, MCP endpoint for the CLI, tasks and runs, file broker, live-view and terminal relays, audit log, kill switch |
| db | trusted | PostgreSQL; the audit table is append-only for the application role |
| supervisor | trusted, no network | The only holder of the Docker socket; creates the three sandboxes from a fixed template and runs fixed commands in them |
| egress | trusted | HTTP proxy; one listener per sandbox network, so the listener decides whose policy applies |
| cli sandbox | untrusted model, trusted CLI | The unmodified Claude Code CLI with its built-in tools removed (`--tools ""`); nothing model-driven runs here |
| tools sandbox | untrusted | Runs the model's shell commands and file operations; no network |
| browser sandbox | untrusted web content | Headed Chrome with its own sandbox on, driven only by the browser service |

All three sandboxes run under gVisor (`runsc`).

The installer provisions fixed agent slots, each with its own networks, control addresses, egress listeners, secrets
and data directories. PostgreSQL `agents.added_at` decides which slots the owner has added; null means free. Names live
in the database and survive restarts. Creating an agent claims the lowest free slot under a row lock and increments
its occupant generation. Delayed Gmail callbacks, Claude sign-in sessions and web mutations check that generation
under the slot lock before writing. Free slots are unknown to every owner API and viewer or terminal connection.
Control binds MCP to each configured slot's `mcpUrl`; the run's token is accepted only on that slot's local socket address.

Removal fences new work, cancels tasks, stops the computer and confirms connector revocation before deleting local
records. The supervisor wipes the slot under its lifecycle lock, preserving the six data directories' owners and
modes. Only a confirmed wipe frees the slot. `agents.removing_at` keeps interrupted removals visible and retryable.
Audit history stays append-only across slot reuse; the owner's audit page starts at the current `added_at`, while
verification checks the entire chain.

## How the agent acts

Claude Code connects to one MCP server, Quokka Bot's, with a token valid for one run. Every action is a tool call:
browser operations (navigate, snapshot, click, type, wait, download, screenshot), file operations and shell commands in
the tools sandbox, and owner requests (ask a question, request a takeover, request sites, attach proof). The control
plane validates each call with a strict schema, checks the run is still allowed to act, records it in the audit log and
executes it. There is no eval, cookie, storage, raw DevTools, upload or clipboard tool.

## Boundaries

- **The sign-in.** The owner opens Claude's sign-in page from the agent's card and pastes its one-time code back into
  the card, with the terminal in Computer available as a fallback. The credential stays in the CLI sandbox's private
  home on an encrypted volume that server snapshots never include; Quokka Bot never reads it.
- **Shell.** Commands the model runs execute in the tools sandbox: no network, no CLI home, no browser profile, no
  Docker socket. Downloads are mounted read-only.
- **Browser.** The agent never touches Chrome's DevTools port. Password and code fields are hidden in snapshots and
  refused for typing: the owner types them through the live view. Downloads land in a staging folder, the browser
  service streams them to control, and control hashes and publishes them into Downloads.
- **Network.** The CLI reaches only the model provider. The browser reaches only sites the owner allowed; the proxy
  checks the name before any DNS lookup, refuses private, loopback, metadata and the host's own addresses, and closes
  open connections when a grant is removed. Government and bank sites can be marked "attended": reachable only while the
  owner has an attended session open.
- **Owner sessions.** The web and Mac apps hold a session cookie, and every change they make must carry the app's own
  Origin. The iPhone app keeps its token in the Keychain and sends it in an Authorization header, which a web page
  cannot send to this origin; with that header every cookie is ignored. Each session works only the way it travels. A
  phone session stays signed in for 30 days after its last use and ends after 180 days at the latest; it never counts
  as a fresh passkey check. Signing a device out closes its streams and live views; a viewer socket also closes when
  its 12-hour viewer cookie runs out.
- **Live view.** Selkies runs in secure mode; control holds its master token. The owner watches on a separate viewer
  origin. The agent holds the input lock by default; "Take over" moves it to the owner on the server, and an expired or
  disconnected takeover pauses the agent instead of handing control back.
- **Kill switch.** One request freezes the agent's egress, stops all three sandboxes and revokes its tokens; it works
  without the database or the job queue on the headerless emergency path. Web requests carrying an occupant generation
  first take the slot lock and check the database. Nothing restarts until the owner confirms with a passkey.
- **Audit.** Every owner action, tool call, browser command, download, domain decision, takeover and terminal session is
  appended to a per-agent hash chain. Typed text is stored as a keyed hash.

## Tasks

A task is a conversation with one CLI session. The database is the queue: a task with a pending prompt gets a run when
its agent has none. When the agent asks the owner something, its run is fenced (further tool calls are refused), the
task waits, and the owner's answer resumes the same session. A task completes only with a clean CLI result, no open
requests and no browser action of uncertain outcome; otherwise it ends as failed or `outcome_unknown`.

Owner images upload to PostgreSQL as unbound attachments and bind atomically with the owner message. Dispatch records
the attachment ids on the run, writes copies under `attachments/` in the workspace through the supervisor, and sends
base64 image blocks followed by text in one stream-json user message to the CLI (including resumed sessions).
Owner image content is served only to signed-in owner sessions with private caching and a sandbox CSP.

## Code

| Path | Contents |
|---|---|
| `packages/shared` | Contracts: zod schemas for tools, browser operations, tasks, egress, supervisor, audit, the owner API, and the Claude Code launch |
| `apps/control` | Control plane |
| `apps/web` | Owner web app (React) |
| `apps/supervisor` | Docker lifecycle and exec |
| `apps/egress` | Egress proxy |
| `apps/browser-service` | Browser service in the browser sandbox |
| `apps/files-helper` | File helper in the tools sandbox |
| `images/` | Sandbox images |
| `deploy/` | Compose files, installer, firewall |
| `tests/redteam` | Red-team probes |
