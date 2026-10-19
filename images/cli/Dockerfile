# syntax=docker/dockerfile:1.7
# CLI sandbox: the unmodified Claude Code CLI and nothing model-driven. Built from the repository root:
#   docker build -f images/cli/Dockerfile -t quokkabot/cli .
# The supervisor runs it under gVisor with a read-only root, user 1000:1000, /home/claude bound from the encrypted
# volume and /run/quokkabot holding the per-run MCP config. Command: sleep infinity; runs arrive through docker exec.
FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315

ARG CLAUDE_CODE_VERSION=2.1.302

# tini reaps orphans that exec'd runs leave behind, so cancel-cli never waits on zombies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && npm cache clean --force \
 && test "$(readlink -f /usr/local/bin/claude)" = /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe \
 && test "$(/usr/local/bin/claude --version)" = "${CLAUDE_CODE_VERSION} (Claude Code)"

# The node image's uid 1000 becomes `claude` with home /home/claude (bind-mounted from the volume at run time).
RUN groupmod --new-name claude node \
 && usermod --login claude --home /home/claude --move-home --shell /bin/bash node \
 && chmod 0700 /home/claude

# Managed policy and memory: root-owned, read-only to the CLI user.
COPY --chmod=0444 images/cli/managed-settings.json /etc/claude-code/managed-settings.json
COPY --chmod=0444 images/cli/CLAUDE.md /etc/claude-code/CLAUDE.md
COPY --chmod=0755 images/cli/run-cli images/cli/cancel-cli images/cli/cleanup-session \
  images/cli/owner-shell images/cli/close-owner-shell images/cli/sign-in-cli images/cli/cancel-sign-in /opt/quokkabot/bin/

# Trusted, empty working directory for runs; /run/quokkabot is the mount point for mcp.json.
RUN chmod 0555 /etc/claude-code \
 && install -d -o root -g root -m 0555 /opt/quokkabot/cli-workdir \
 && install -d -o 1000 -g 1000 -m 0700 /run/quokkabot \
 && chmod 0755 /opt/quokkabot /opt/quokkabot/bin

WORKDIR /opt/quokkabot/cli-workdir
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
