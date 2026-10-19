# syntax=docker/dockerfile:1.7
# Browser sandbox: Xfce on display :1, Selkies (live view, secure mode), headed Chrome for Testing, agent-browser and
# the Quokka Bot browser service. Built from the repository root:
#   docker build -f images/browser/Dockerfile -t quokkabot/browser .
# The supervisor runs it under gVisor with PUID/PGID 1000, /config (profile) and /staging (downloads) bound from
# the encrypted volume, and passes SELKIES_MASTER_TOKEN, SELKIES_ALLOWED_ORIGINS, QUOKKABOT_BROWSER_SERVICE_TOKEN and
# QUOKKABOT_PROXY.
#
# Debian's chromium crashes under gVisor; Chrome for Testing from Playwright 1.64.1 runs headed with its own
# sandbox on, so it replaces it.

FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf AS playwright

FROM node:24-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315 AS node

# Builds apps/browser-service and its workspace dependencies, then keeps only its production files.
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
RUN corepack pnpm@12.14.0 install --frozen-lockfile --filter "@quokkabot/browser-service..."
COPY packages/shared packages/shared
COPY apps/browser-service apps/browser-service
COPY --chmod=0555 images/prune-deploy.sh /usr/local/bin/prune-deploy
# Until apps/browser-service has src/main.ts the image ships without it and the s6 service reports that once.
RUN mkdir -p /out/etc-quokkabot \
 && if [ -f apps/browser-service/agent-browser-policy.json ]; then \
      cp apps/browser-service/agent-browser-policy.json /out/etc-quokkabot/agent-browser-policy.json; \
    fi \
 && if [ -f apps/browser-service/src/main.ts ]; then \
      corepack pnpm@12.14.0 --filter "@quokkabot/browser-service..." run build \
      && corepack pnpm@12.14.0 --filter @quokkabot/browser-service deploy --prod /out/browser-service \
      && prune-deploy /out/browser-service \
      && test -f /out/browser-service/dist/main.js; \
    else \
      echo "apps/browser-service/src/main.ts is missing: building the placeholder image" \
      && mkdir -p /out/browser-service; \
    fi

FROM lscr.io/linuxserver/webtop:debian-xfce@sha256:d925f9c84663fe57735be4defe95a338d32bc37f2e12b9e0f0981e91b6bd0a5d

# The viewer origin Selkies accepts WebSocket connections from comes at container creation from the supervisor
# (SELKIES_ALLOWED_ORIGINS); the startup check refuses to start without it.

# Debian's chromium (crashes under gVisor) and sudo go. The desktop user loses the sudo and docker groups. No
# autostart entries: the session runs only what xfce4-session.xml lists.
# sudo's pre-removal script refuses to run without SUDO_FORCE_REMOVE=yes when root has no password.
RUN SUDO_FORCE_REMOVE=yes apt-get purge -y chromium chromium-common chromium-l10n sudo \
 && rm -rf /var/lib/apt/lists/* /usr/local/bin/wrapped-chromium /etc/chromium /etc/chromium.d \
 && printf '# sudo is not installed in the Quokka Bot browser image.\n' >/etc/sudoers \
 && chmod 0440 /etc/sudoers \
 && gpasswd --delete abc sudo \
 && gpasswd --delete abc docker \
 && rm -f /etc/xdg/autostart/*.desktop
COPY --chmod=0644 images/browser/xfce4-session.xml /etc/xdg/xfce4/xfconf/xfce-perchannel-xml/xfce4-session.xml

# Playwright 1.64.1 chromium-1248: Chrome for Testing 156.0.8078.4 on amd64, Playwright's own Chromium 156 build on
# arm64. /opt/pw-browsers/chrome is the stable path on both.
ARG TARGETARCH
COPY --from=playwright /ms-playwright/chromium-1248 /opt/pw-browsers/chromium-1248
RUN case "${TARGETARCH}" in \
      amd64) ln -s chromium-1248/chrome-linux64/chrome /opt/pw-browsers/chrome \
             && /opt/pw-browsers/chrome --version | grep -q '^Google Chrome for Testing 156\.0\.8078\.4' ;; \
      arm64) ln -s chromium-1248/chrome-linux-arm64/chrome /opt/pw-browsers/chrome \
             && /opt/pw-browsers/chrome --version | grep -q ' 156\.0\.' ;; \
      *) echo "unsupported architecture ${TARGETARCH}" >&2; exit 1 ;; \
    esac
# Managed policies: Chrome for Testing reads /etc/opt/chrome_for_testing/policies/managed (verified on amd64 with
# chrome://policy); Chromium builds read /etc/chromium/policies/managed (the arm64 build; not verified).
COPY --chmod=0444 images/browser/chrome-policy.json /etc/opt/chrome_for_testing/policies/managed/quokkabot.json
COPY --chmod=0444 images/browser/chrome-policy.json /etc/chromium/policies/managed/quokkabot.json
RUN chmod 0555 /etc/opt/chrome_for_testing /etc/opt/chrome_for_testing/policies \
      /etc/opt/chrome_for_testing/policies/managed /etc/chromium /etc/chromium/policies /etc/chromium/policies/managed

# Node 24 (the browser service) and agent-browser 0.39.1. npm is only needed for the install.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN /usr/local/bin/node /usr/local/lib/node_modules/npm/bin/npm-cli.js install -g agent-browser@0.39.1 \
 && test "$(/usr/local/bin/agent-browser --version)" = "agent-browser 0.39.1" \
 && rm -rf /usr/local/lib/node_modules/npm /root/.npm /root/.cache

COPY --from=build /out/browser-service /opt/quokkabot/browser-service
COPY --from=build /out/etc-quokkabot/ /etc/quokkabot/

# s6 services: init-quokkabot checks the settings before Selkies, nginx and the desktop start;
# svc-quokkabot-browser runs the browser service as abc after the desktop is up.
COPY --chmod=0755 images/browser/s6/init-quokkabot /etc/s6-overlay/s6-rc.d/init-quokkabot
COPY --chmod=0755 images/browser/s6/svc-quokkabot-browser /etc/s6-overlay/s6-rc.d/svc-quokkabot-browser
RUN touch /etc/s6-overlay/s6-rc.d/user/contents.d/init-quokkabot \
      /etc/s6-overlay/s6-rc.d/user/contents.d/svc-quokkabot-browser \
      /etc/s6-overlay/s6-rc.d/svc-selkies/dependencies.d/init-quokkabot \
      /etc/s6-overlay/s6-rc.d/svc-nginx/dependencies.d/init-quokkabot \
      /etc/s6-overlay/s6-rc.d/svc-de/dependencies.d/init-quokkabot \
 && install -d -o 1000 -g 1000 -m 0700 /staging

ENV QUOKKABOT_CHROME=/opt/pw-browsers/chrome \
    QUOKKABOT_AGENT_BROWSER=/usr/local/bin/agent-browser \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    NO_AT_BRIDGE=1 \
    HARDEN_DESKTOP=true \
    DISABLE_SUDO=true \
    START_DOCKER=false \
    SELKIES_COMMAND_ENABLED=false \
    SELKIES_FILE_TRANSFERS="" \
    SELKIES_PRINTING_ENABLED=false \
    SELKIES_AUDIO_ENABLED=false \
    SELKIES_MICROPHONE_ENABLED=false \
    SELKIES_GAMEPAD_ENABLED=false \
    SELKIES_UI_SIDEBAR_SHOW_FILES=false \
    SELKIES_UI_SIDEBAR_SHOW_APPS=false \
    SELKIES_MANUAL_WIDTH=1280 \
    SELKIES_MANUAL_HEIGHT=800
