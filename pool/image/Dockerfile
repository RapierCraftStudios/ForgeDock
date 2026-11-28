# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
# Lane image: everything `forgedock run-issue` needs. Versions are pinned; bump them together with the router host.
# IS_SANDBOX=1: lanes run as root in a throwaway container; Claude Code refuses --dangerously-skip-permissions as root without it.
FROM ubuntu:24.04

ARG NODE_VERSION=22.23.3  # lanes need >=22.19 (undici 8 via vitest)
# Node 22.12 bundles corepack 0.29.4, whose npm signing keys are stale: `corepack pnpm` fails to verify
# pnpm, so lanes get no dependencies. A current corepack carries the rotated keys.
ARG COREPACK_VERSION=0.34.7
# No default: the lane image is built from the installed ForgeDock version (docker build --build-arg FORGEDOCK_VERSION=...).
ARG FORGEDOCK_VERSION
ARG CLAUDE_CODE_VERSION=2.1.309
ARG UV_VERSION=0.12.5
ARG POETRY_VERSION=2.4.3
ARG YQ_VERSION=4.44.3
ARG PLAYWRIGHT_VERSION=1.49.1

# Image recipe hash (versionOf().image); pool agents check it after pulling the published image (#6166).
ARG FORGEDOCK_RECIPE=
LABEL org.opencontainers.image.version=$FORGEDOCK_VERSION forgedock.recipe=$FORGEDOCK_RECIPE
RUN test -n "$FORGEDOCK_VERSION" || { echo "FORGEDOCK_VERSION build arg is required" >&2; exit 1; }

ENV NODE_OPTIONS=--dns-result-order=ipv4first IS_SANDBOX=1 DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/opt/playwright UV_PYTHON_INSTALL_DIR=/opt/uv-python PATH=/opt/cs/bin:/opt/node/bin:/root/.local/bin:$PATH

# IPv4 for apt: hosts whose Docker networking dials IPv6 first with no IPv6 route (WSL mirrored) fail apt fetches in
# lane_tools variant builds FROM this image (#6187).
RUN echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq xz-utils build-essential python3 python3-venv python3-dev python3-yaml gnupg pkg-config libpq-dev \
      shellcheck xvfb xauth postgresql-client redis-tools \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends gh docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt \
    && mv "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node \
    && NODE_OPTIONS=--dns-result-order=ipv4first npm install -g --include=optional "corepack@${COREPACK_VERSION}" "forgedock@${FORGEDOCK_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && claude --version && forgedock --version   # smoke: a missing native binary (failed optional download) fails the build, never a lane

RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv tool install "poetry==${POETRY_VERSION}" \
    && uv python install 3.11 3.13 \
    && ln -s "$(uv python find 3.11)" /usr/local/bin/python3.11 \
    && ln -s "$(uv python find 3.13)" /usr/local/bin/python3.13

# yq (mikefarah): pinned release binary. Playwright chromium lives at PLAYWRIGHT_BROWSERS_PATH, shared by every lane user.
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/download/v${YQ_VERSION}/yq_linux_amd64" -o /usr/local/bin/yq \
    && chmod 0755 /usr/local/bin/yq \
    && npx --yes "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm

COPY entrypoint.sh /usr/local/bin/cs-entrypoint
COPY warm-refresh.sh /usr/local/bin/cs-warm-refresh
COPY mirror.sh /usr/local/bin/cs-mirror
COPY cs-cred /usr/local/bin/cs-cred
COPY cs-relay /usr/local/bin/cs-relay
COPY gh-shim /opt/cs/bin/gh
COPY claude-shim /opt/cs/bin/claude
RUN chmod 0755 /usr/local/bin/cs-entrypoint /usr/local/bin/cs-warm-refresh /usr/local/bin/cs-mirror /usr/local/bin/cs-cred /usr/local/bin/cs-relay /opt/cs/bin/gh /opt/cs/bin/claude
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/cs-entrypoint"]
