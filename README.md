# Quokka Bot

[![CI](https://github.com/quokka-bot/quokkabot/actions/workflows/ci.yml/badge.svg)](https://github.com/quokka-bot/quokkabot/actions/workflows/ci.yml)

An open-source agent with its own cloud computer. Each agent works in its own isolated desktop with a browser,
a workspace and the official Claude Code CLI, on the owner's existing Claude plan. It signs in to sites with logins
the owner saved (it types them without ever seeing them), asks before it reaches a new site, and hands the browser
to the owner for anything only a person can do.

Self-host it on one Linux server, or use the hosted version at [quokkabot.com](https://quokkabot.com) (coming).

## What works today

- **Its own computer.** One set of gVisor sandboxes per agent: Chrome, a shell workspace and Claude Code, behind
  an egress proxy that only reaches sites the owner allowed. Live view and takeover from the app.
- **Login vault.** Saved passwords and 2FA secrets are encrypted on the server; the agent types them into the page
  without seeing them. A login covers its whole site, subdomains included.
- **Cards instead of settings.** When the agent needs a site, a login or the owner's hands, a card appears in the
  chat at the point it asked; writing a message instead skips it.
- **Gmail** through Google's own consent page: search, read and drafts.
- **Apps.** Web app and a signed Mac app; an iPhone app is next.
- **Audit log and kill switch.** Every action the agent takes is recorded in a hash-chained log.
- **Backups.** Encrypted off-server backups with restic to any S3-compatible bucket.

## Install

Requirements, the encrypted data volume, backups and restore: [docs/install.md](docs/install.md). How the pieces fit:
[docs/architecture.md](docs/architecture.md). What comes next: [ROADMAP.md](ROADMAP.md).

## Bring your own plan

The agent runs the providers' official, unmodified CLIs signed in with the owner's own plan; Quokka Bot never reads
or stores the plan's token.

## Security

The agent's computer holds logins and reads untrusted pages, so the boundaries sit outside the model: one isolated
computer per agent, a default-deny egress proxy, a vault the model cannot read, takeover for sign-ins it cannot do,
and an audit log. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).
