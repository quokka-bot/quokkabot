# syntax=docker/dockerfile:1.7
# Trusted Node services. One target per service:
#   docker build --target control    -t quokkabot/control .
#   docker build --target egress     -t quokkabot/egress .
#   docker build --target supervisor -t quokkabot/supervisor .
# deploy/compose.yaml builds all three. Each runtime image carries only its app's production files
# (`pnpm deploy --prod`) and runs as a non-root user:
#   control    uid 10001 (quokkabot-control); joins group 1000 in Compose for the supervisor socket and downloads
#   egress     uid 10002 (quokkabot-egress)
#   supervisor uid 1000 (the sandbox user, so the per-run files it writes for the CLI are owned correctly without
#              CAP_CHOWN); Compose adds the Docker socket's group with `group_add` (DOCKER_GID in quokkabot.env)

FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS node

# Whole-workspace install once; each service stage builds only what it needs.
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
RUN corepack pnpm@12.14.0 install --frozen-lockfile
COPY packages packages
COPY apps apps
COPY --chmod=0555 images/prune-deploy.sh /usr/local/bin/prune-deploy

FROM build AS build-control
RUN corepack pnpm@12.14.0 --filter "@quokkabot/control..." run build \
 && corepack pnpm@12.14.0 --filter @quokkabot/web run build \
 && test -f apps/web/dist/index.html \
 && corepack pnpm@12.14.0 --filter @quokkabot/control deploy --prod /out/app \
 && prune-deploy /out/app \
 && cp -R apps/web/dist /out/web

FROM build AS build-egress
RUN corepack pnpm@12.14.0 --filter "@quokkabot/egress..." run build \
 && corepack pnpm@12.14.0 --filter @quokkabot/egress deploy --prod /out/app \
 && prune-deploy /out/app

FROM build AS build-supervisor
RUN corepack pnpm@12.14.0 --filter "@quokkabot/supervisor..." run build \
 && corepack pnpm@12.14.0 --filter @quokkabot/supervisor deploy --prod /out/app \
 && prune-deploy /out/app

# Node and tini only: npm, npx, corepack and yarn are removed from the runtime.
FROM node AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && userdel --remove node
ENV NODE_ENV=production
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/main.js"]

FROM runtime AS control
RUN groupadd --gid 10001 quokkabot-control \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin quokkabot-control
COPY --from=build-control /out/app /app
COPY --from=build-control /out/web /srv/web
ENV QUOKKABOT_CONTROL_CONFIG=/etc/quokkabot/control.json \
    QUOKKABOT_WEB_ROOT=/srv/web
USER 10001:10001
CMD ["serve"]

FROM runtime AS egress
RUN groupadd --gid 10002 quokkabot-egress \
 && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin quokkabot-egress
COPY --from=build-egress /out/app /app
ENV QUOKKABOT_EGRESS_CONFIG=/etc/quokkabot/egress.json
USER 10002:10002

FROM runtime AS supervisor
RUN groupadd --gid 1000 quokkabot-supervisor \
 && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin quokkabot-supervisor
COPY --from=build-supervisor /out/app /app
ENV QUOKKABOT_SUPERVISOR_CONFIG=/etc/quokkabot/supervisor.json
USER 1000:1000
