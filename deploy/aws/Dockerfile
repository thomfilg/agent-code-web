# syntax=docker/dockerfile:1
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runner
ARG CODEX_VERSION=0.156.1
ARG CLAUDE_VERSION=2.1.280
ARG GH_VERSION=2.89.0
ARG AWSCLI_VERSION=2.35.20
ENV NODE_ENV=production LANG=C.UTF-8 NO_COLOR=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-client python3 unzip util-linux procps libicu72 libssl3 libzstd1 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64-${AWSCLI_VERSION}.zip" -o /tmp/aws.zip \
    && cd /tmp && unzip -q aws.zip && ./aws/install && rm -rf /tmp/aws /tmp/aws.zip
RUN cd /tmp && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
    && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt" \
    && grep " gh_${GH_VERSION}_linux_amd64.tar.gz$" "gh_${GH_VERSION}_checksums.txt" | sha256sum --check \
    && tar -xzf "gh_${GH_VERSION}_linux_amd64.tar.gz" \
    && install "gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
    && rm -rf /tmp/gh_*
RUN npm install --global "@openai/codex@${CODEX_VERSION}" "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && npm cache clean --force
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/build-auth.mjs ./scripts/build-auth.mjs
COPY src/shared-auth-entry.mjs ./src/shared-auth-entry.mjs
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY chrome-extension ./chrome-extension
COPY deploy/aws/container-entry.mjs ./deploy/aws/container-entry.mjs
COPY deploy/aws/worker-key.mjs ./deploy/aws/worker-key.mjs
COPY deploy/aws/host-event-collector.py ./deploy/aws/host-event-collector.py
COPY deploy/aws/host-event-collector.service ./deploy/aws/host-event-collector.service
RUN chmod -R a+rX /app \
    && node --input-type=module -e "await import('./deploy/aws/worker-key.mjs')" \
    && codex --version && claude --version && gh --version && aws --version
ENV AGENT_WEB_HOST=0.0.0.0 AGENT_WEB_PORT=8787 AGENT_WORKER_BACKEND=ec2 \
    AGENT_CONTROL_DIR=/var/lib/relay/control AGENT_DATA_DIR=/var/lib/relay/state \
    AGENT_HOST_EVENT_DIR=/var/lib/relay/host-events \
    AGENT_DATABASE_MODE=embedded AGENT_DATABASE_PORT=55438 \
    AGENT_COOKIE_SECURE=1 AGENT_GOOGLE_AUTH=1 AGENT_ENABLE_MOCK=0 \
    AGENT_PROCESS_ISOLATION=none CODEX_AUTH_MODE=gateway CLAUDE_AUTH_MODE=gateway
USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
CMD ["node", "deploy/aws/container-entry.mjs"]
