# syntax=docker/dockerfile:1.7
# Tools sandbox: the agent's shell and document toolchain, no network. Built from the repository root:
#   docker build -f images/tools/Dockerfile -t quokkabot/tools .
# The supervisor runs it under gVisor with a read-only root, user 1000:1000, network none, /workspace rw,
# /downloads ro and /tmp as tmpfs. Commands arrive through docker exec (bash -lc); file operations through
# /opt/quokkabot/bin/qb-files with a JSON request on stdin.

FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS node

# Builds apps/files-helper and its workspace dependencies, then keeps only its production files.
FROM node AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=true
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/browser-service/package.json apps/browser-service/
COPY apps/control/package.json apps/control/
COPY apps/egress/package.json apps/egress/
COPY apps/files-helper/package.json apps/files-helper/
COPY apps/supervisor/package.json apps/supervisor/
COPY apps/web/package.json apps/web/
RUN corepack pnpm@12.14.0 install --frozen-lockfile --filter "@quokkabot/files-helper..."
COPY packages/shared packages/shared
COPY apps/files-helper apps/files-helper
COPY --chmod=0555 images/prune-deploy.sh /usr/local/bin/prune-deploy
# Until apps/files-helper has src/main.ts the image ships without it and qb-files exits 1.
RUN if [ -f apps/files-helper/src/main.ts ]; then \
      corepack pnpm@12.14.0 --filter "@quokkabot/files-helper..." run build \
      && corepack pnpm@12.14.0 --filter @quokkabot/files-helper deploy --prod /out/files-helper \
      && prune-deploy /out/files-helper \
      && test -f /out/files-helper/dist/main.js; \
    else \
      echo "apps/files-helper/src/main.ts is missing: building the placeholder image" \
      && mkdir -p /out/files-helper; \
    fi

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils procps findutils grep sed gawk file less tini ca-certificates \
      poppler-utils qpdf ghostscript imagemagick \
      libreoffice-writer-nogui libreoffice-calc-nogui \
      python3 python3-pypdf python3-openpyxl \
      fonts-dejavu fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

# Node 24 from the official image: the binary is all qb-files needs.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

RUN groupadd --gid 1000 agent \
 && useradd --uid 1000 --gid 1000 --home-dir /home/agent --create-home --shell /bin/bash agent \
 && install -d -o 1000 -g 1000 -m 0755 /workspace \
 && install -d -o root -g root -m 0755 /downloads

COPY --from=build /out/files-helper /opt/quokkabot/files-helper
COPY --chmod=0755 images/tools/qb-files images/tools/reset-tools /opt/quokkabot/bin/

# The root filesystem is read-only at run time and /tmp is the only writable place besides /workspace, so
# programs that keep per-user state (LibreOffice's profile, fontconfig's cache) get HOME=/tmp.
ENV HOME=/tmp \
    LANG=C.UTF-8 \
    PATH=/opt/quokkabot/bin:/usr/local/bin:/usr/bin:/bin \
    PYTHONDONTWRITEBYTECODE=1 \
    QB_WORKSPACE=/workspace \
    QB_DOWNLOADS=/downloads \
    QB_PDFTOTEXT=/usr/bin/pdftotext

WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
