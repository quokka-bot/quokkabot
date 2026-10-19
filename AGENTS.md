# Working on Quokka Bot

For people and coding agents changing this repository.

## Layout

- `apps/control`: the control plane (Fastify, PostgreSQL): API, tasks and runs, the MCP tools the agent uses,
  vault, cards, audit log.
- `apps/web`: the web app (Vite, React). `apps/desktop`: the Mac app (Electron) around it.
- `apps/supervisor`: starts and stops each agent's sandboxes (Docker with gVisor).
- `apps/browser-service`: drives Chrome inside the browser sandbox; types vault values the model never sees.
- `apps/egress`: the proxy every agent request goes through; default deny.
- `apps/files-helper`: file access inside the tools sandbox.
- `packages/shared`: types and schemas shared by everything (zod).
- `images/`: the sandbox images (cli, tools, browser). `images/cli/CLAUDE.md` is the agent's own instructions.
- `deploy/`: the installer, Compose files, firewall, backups. `docs/`: architecture, install, measurements.

## Commands

- `pnpm install`, then `pnpm check`: typecheck, all unit tests and the text check. Run it before every PR.
- Control plane integration tests need Docker: `QB_INTEGRATION=1 pnpm vitest run apps/control` (Linux).
- Local development: `deploy/install.sh --dev` (docs/install.md, "Development on a Mac").

## Rules

- The boundaries sit outside the model: anything the agent can do goes through the control plane, the egress proxy
  or the vault. Never give the agent a route around them (raw CDP, the vault key, the CLI token).
- Every change that crosses a boundary (control plane, supervisor, browser service, egress) needs a test that
  proves the boundary still holds.
- User-facing text says what happens, in short plain sentences. Never use an em dash; `pnpm check` rejects it.
- No secrets, personal data or real accounts in code, tests or docs.
- Do not commit plans, research notes or agent scratch files.
- Every PR description ends with `Harness:`, `Model:` and `Effort:` lines naming the tool, the model id and the
  reasoning effort that wrote it (`.github/pull_request_template.md`). The PR description check fails without them.
