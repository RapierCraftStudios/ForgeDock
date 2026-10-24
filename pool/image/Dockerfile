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

LABEL org.opencontainers.image.version=$FORGEDOCK_VERSION
RUN test -n "$FORGEDOCK_VERSION" || { echo "FORGEDOCK_VERSION build arg is required" >&2; exit 1; }

ENV IS_SANDBOX=1 DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 PATH=/opt/cs/bin:/opt/node/bin:/root/.local/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq xz-utils build-essential python3 python3-venv python3-dev pkg-config libpq-dev \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends gh docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" | tar -xJ -C /opt \
    && mv "/opt/node-v${NODE_VERSION}-linux-x64" /opt/node \
    && npm install -g "corepack@${COREPACK_VERSION}" "forgedock@${FORGEDOCK_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv tool install "poetry==${POETRY_VERSION}"

COPY entrypoint.sh /usr/local/bin/cs-entrypoint
COPY cs-cred /usr/local/bin/cs-cred
COPY gh-shim /opt/cs/bin/gh
COPY claude-shim /opt/cs/bin/claude
RUN chmod 0755 /usr/local/bin/cs-entrypoint /usr/local/bin/cs-cred /opt/cs/bin/gh /opt/cs/bin/claude
WORKDIR /work
ENTRYPOINT ["/usr/local/bin/cs-entrypoint"]
