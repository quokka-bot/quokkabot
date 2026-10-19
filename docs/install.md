# Installing Quokka Bot

One server runs everything: the control plane, the web app, the database, the egress proxy, the supervisor and,
per agent, three gVisor sandboxes (CLI, tools, browser).

## Requirements

- Ubuntu 24.04, amd64 or arm64, root access. 4 vCPU and 8 GB RAM run four agent slots, with about two agents
  working at the same time (measured on a Hetzner CX33: one agent's computer uses about 750 MiB with Chrome open,
  and its sandboxes are capped at 6 GiB together).
- No swap. The installer refuses to run while swap is active.
- A second block device for the data volume (for example a 10 GB or larger Hetzner Volume), empty.
- Two DNS names, both A records (and AAAA if you use IPv6) pointing at the server, DNS only (no proxying CDN):
  - `QUOKKABOT_DOMAIN`, the owner app, for example `quokkabot.example.com`;
  - `QUOKKABOT_VIEW_DOMAIN`, the live viewer on its own origin, for example `view.quokkabot.example.com`.
- Ports 80 and 443 open to the internet (Let's Encrypt certificates and the app).
- The repository at `/opt/quokkabot/src` (git clone or a copy).

Docker (with the containerd image store, the default on new installs) and gVisor are installed by the script
when missing.

## The data volume

Everything Quokka Bot stores lives on one LUKS-encrypted volume mounted at `/var/lib/quokkabot`: the CLI sign-in,
workspaces, browser profiles, downloads, run logs, the database and the TLS certificates. The key is
`/etc/quokkabot/volume.key` (root only, 0400) on the root disk, so the volume opens at boot without a prompt. Server
snapshots and Hetzner Backups do not include attached volumes, so the CLI sign-in never ends up in a backup.

First install, with an empty device:

```sh
/opt/quokkabot/src/deploy/install.sh --setup-volume /dev/sdb
```

This formats the device with LUKS2, adds `/etc/crypttab` and `/etc/fstab` entries, mounts it and writes the marker
file `/var/lib/quokkabot/.quokkabot-volume` (`luks:<uuid>`). The installer refuses a device that carries any
filesystem, partition or LUKS header; wipe it yourself first if you mean to replace it. On later runs, and at every
start of the supervisor, `/var/lib/quokkabot` must be the mounted encrypted volume named in the marker.

## Off-server backups

The volume has no copy anywhere else until you turn these on. `quokkabot-backup` dumps the database and backs it up
together with the agents' workspaces, downloads and browser profiles and the TLS certificates, encrypted with
[restic](https://restic.net), to any S3-compatible bucket. It never backs up the CLI sign-ins or `/etc/quokkabot`.

1. Create a bucket and a key that can read and write only that bucket (Cloudflare R2: an Account API token with
   Object Read & Write on the bucket; use the EU endpoint for an EU bucket).
2. Write `/etc/quokkabot/backup.env` (root, 0400):

   ```sh
   RESTIC_REPOSITORY=s3:https://<account>.eu.r2.cloudflarestorage.com/<bucket>
   RESTIC_PASSWORD_FILE=/etc/quokkabot/secrets/backup_password
   AWS_ACCESS_KEY_ID=<key id>
   AWS_SECRET_ACCESS_KEY=<secret>
   AWS_DEFAULT_REGION=auto
   ```

   and the repository password: `openssl rand -base64 32 > /etc/quokkabot/secrets/backup_password; chmod 0400 …`.
3. Run `install.sh` again (it installs restic and the daily timer), then `quokkabot-backup init` and
   `quokkabot-backup run`. `quokkabot-backup status` shows the last result and the snapshots; the result is also in
   `/var/lib/quokkabot/backup/status.json`.
4. Keep offline, away from the server and the bucket: `/etc/quokkabot/quokkabot.env`, the `/etc/quokkabot/secrets`
   directory (it holds the vault key, without which saved logins cannot be read) and `backup.env`. A restore needs
   all three.

Snapshots are kept for 7 days, 5 weeks and 12 months. Every run checks the repository; on Sundays it also reads back
a tenth of the stored data.

### Restore

On a new server with a new data volume:

1. Put the saved `/etc/quokkabot/quokkabot.env`, `/etc/quokkabot/secrets` and `/etc/quokkabot/backup.env` in place
   (root only), and point the DNS names at the new server.
2. Run `install.sh --setup-volume <device>` as for a first install. It keeps the saved secrets and agent ids.
3. Run `quokkabot-backup restore` (or `restore <snapshot id>`). It stops the control plane, restores the database
   and the agents' files, and starts everything again.
4. Each agent signs in to Claude again from its card; the CLI sign-ins are never in a backup.

## Install

```sh
QUOKKABOT_DOMAIN=quokkabot.example.com QUOKKABOT_VIEW_DOMAIN=view.quokkabot.example.com \
  /opt/quokkabot/src/deploy/install.sh
```

Add `--setup-volume <device>` on the first run if the volume is not set up yet. The script is idempotent: run it
again after changing the source or the settings. A run with nothing changed rebuilds from cache, keeps every
container running and changes no file. It ends by printing a one-time setup link (valid 30 minutes); open it on
the device that will hold your passkey.

### Agent slots

`QUOKKABOT_AGENTS` (default 4, at most 99) is the number of agent slots. Each slot gets its own sandbox networks,
egress-proxy listeners, control-plane addresses, firewall entries, secrets and data directories at install time;
the owner creates, renames and removes agents in those slots from the app. For more agents, raise it and run the
installer again:

```sh
QUOKKABOT_AGENTS=6 /opt/quokkabot/src/deploy/install.sh
```

The number is kept in `quokkabot.env`. Lowering it hides the agents in the slots above it; their data and ids stay,
and raising the number again brings them back. The installer refuses to hide a slot whose computer is running.

`QUOKKABOT_PUBLIC_CONTACT` (optional) is the contact address shown on the public About and Privacy pages; it is kept
in `quokkabot.env` too.

New setup link later:

```sh
quokkabot-compose exec control node dist/main.js setup-link
```

### The iPhone app

The iPhone app connects to any server: in the app, Connect to your server, then scan the QR code in Settings,
Connect a phone (or type the server's address), and approve the code it shows in a browser where you are signed in.
On a server you never open in a browser, sign the phone in with a code instead:

```sh
quokkabot-compose exec control node dist/main.js pairing-code --uses 1 --days 1
```

In the app, choose "I have a code". A code works `--uses` times (at most 20) for `--days` days (at most 30).
`revoke-pairing-codes` revokes every code and signs out the phones that used one. Settings, Signed-in devices signs
out one phone.

`QUOKKABOT_APPLE_APP_IDS` (optional, comma-separated `<team id>.<bundle id>`) lets those iPhone builds use native
passkeys on this domain. A build can only use them on domains in its own entitlements, so this matters only when you
build the app yourself for your domain.

## What it creates

| Path | Contents |
|---|---|
| `/etc/quokkabot/quokkabot.env` | Domains, agent slot count and ids, resolvers, runtime, Docker socket group, contact (0600) |
| `/etc/quokkabot/control.json`, `egress.json`, `supervisor.json` | Generated service configuration |
| `/etc/quokkabot/compose.agents.yaml` | Generated: each agent slot's networks and the control plane's and proxy's addresses on them |
| `/etc/quokkabot/secrets/` | Generated secrets (root, 0400); `by-service/<name>/` holds each container's copy, owned by its user |
| `/etc/quokkabot/nftables.conf` | Host firewall rules, loaded by `quokkabot-firewall.service` before Docker starts |
| `/etc/docker/daemon.json` | `runsc` runtime, core dumps off for containers |
| `/etc/systemd/system/docker.service.d/10-quokkabot.conf` | Docker waits for the volume and the firewall |
| `/etc/sysctl.d/90-quokkabot.conf`, `/etc/security/limits.d/90-quokkabot.conf` | Core dumps off |
| `/usr/local/bin/quokkabot-compose` | `docker compose` with this install's files, from any directory |
| `/var/lib/quokkabot/` | `db/`, `caddy/`, `runs/`, `supervisor-socket/`, `agents/<N>/{cli-state,workspace,downloads,browser-profile,staging,run}` per slot |

Containers (`quokkabot-compose ps`): `caddy` (ports 80 and 443), `control`, `db` (PostgreSQL 17), `egress`,
`supervisor`. Images built locally: `quokkabot/{control,egress,supervisor}:local` and the sandbox images
`quokkabot/{cli,tools,browser}:local`. The supervisor creates an agent's sandboxes (`qb-cli-N`, `qb-tools-N`,
`qb-browser-N` for slot N) under gVisor when its computer is started from the app.

The firewall drops all traffic from the sandbox networks (bridges `qbc<N>` and `qbb<N>` for every slot, subnets
`10.231.0.0/16` and `10.232.0.0/16`) to the host and everything routed in or out of them. Inside each sandbox network only the egress
proxy and the control plane answer; the sandbox bridges have no host address.

## Logs

```sh
quokkabot-compose ps
quokkabot-compose logs -f                 # all trusted containers
quokkabot-compose logs -f control         # one service: caddy, control, db, egress, supervisor
docker logs -f qb-browser-1              # a sandbox (qb-cli-1, qb-tools-1, qb-browser-1)
journalctl -u docker -u quokkabot-firewall
nft list table inet quokkabot             # firewall rules with drop counters
```

## Stop and start

```sh
quokkabot-compose down        # stops the trusted containers; data stays on the volume
quokkabot-compose up -d       # starts them again
```

`down` does not touch the sandboxes; stop the computer from the app first (or `docker stop qb-cli-1 qb-tools-1
qb-browser-1`). The stack starts by itself after a reboot once the volume is mounted.

## Development on a Mac

```sh
deploy/install.sh --dev
```

Uses OrbStack or Docker Desktop: sandboxes with the `runc` runtime, plain http on `quokkabot.localhost` and
`view.quokkabot.localhost` at port 8080 (browsers treat `*.localhost` as a secure context), data, configs and
secrets under `deploy/.dev/`. The wrapper is `deploy/.dev/quokkabot-compose`. Nothing on the Mac outside the
repository is changed.
