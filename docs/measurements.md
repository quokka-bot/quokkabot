# Measurements

Measured on 2026-10-17 on a Hetzner CX33 (4 shared vCPU, 8 GB, x86), Ubuntu 24.04, gVisor `runsc` release-20261012.0
on the systrap platform (no KVM). One agent. Figures are `docker stats` snapshots, not long-run averages.

## One agent's computer, idle (no task, nobody watching)

| Sandbox | Memory | CPU (100% = one vCPU) | Limit |
|---|---|---|---|
| browser (Xfce, Selkies, Chrome for Testing on one page, browser service) | 542 MiB | about 12% | 3 GiB, 2 CPUs |
| cli (Claude Code, between runs) | 15 MiB | under 1% | 1.5 GiB, 1 CPU |
| tools (shell and document tools, between commands) | 14 MiB | under 1% | 1.5 GiB, 1 CPU |

The images subagent measured the browser sandbox alone at 318 MiB with only the desktop and Selkies, 552 MiB with
Chrome on about:blank and 617 MiB with one Wikipedia article.

## Shared services

| Container | Memory |
|---|---|
| caddy | 55 MiB |
| control | 53 MiB |
| db (PostgreSQL 17) | 57 MiB |
| egress | 25 MiB |
| supervisor | 29 MiB |

The whole host used 1.47 GB of 7.6 GB at that moment.

## Disk

| Item | Size |
|---|---|
| Browser image (webtop, Chrome for Testing, agent-browser) | 6.55 GB |
| Tools image (LibreOffice, poppler, ImageMagick, Python) | 1.12 GB |
| CLI image | 762 MB |
| Control, egress, supervisor images | 346–406 MB each |
| Data volume after the self-test (profile, database, five downloads) | 67 MB |

## Actions

- Kill switch: 1.2 s from the request to all three sandboxes stopped (exit 137).
- Server self-test (`tests/integration/server-e2e.sh`): about 90 s, most of it in the five downloads and the probe page.
- Fresh install on a new Hetzner CPX22 (2 vCPU, 4 GB) with neither Docker nor gVisor installed, including LUKS setup of
  a new volume and Let's Encrypt certificates: 4 min 6 s. The self-test passed there, and after a reboot the volume,
  firewall and all five services came back on their own.

## Not measured yet

A live viewer on a phone, a long task with a signed-in CLI, and model token use per run: they need the owner's Claude
sign-in. They are next.
