ARG NODE_IMAGE=node:24-alpine
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG INSTALL_PYTHON_RUNTIME=false

# ─── builder: install dependencies and compile TypeScript ───────────────────
FROM ${NODE_IMAGE} AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY"
RUN npm install -g npm@11.21.2
# shortcut: npm ci crashes with "Exit handler never called" in this Alpine
# image; replace npm install with npm ci once the base image ships this npm.
RUN npm install --no-audit --no-fund --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev --ignore-scripts

# ─── runtime: production dependencies and compiled output only ──────────────
FROM ${NODE_IMAGE}
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    LOG_LEVEL=info \
    DATA_DIR=/app/data \
    WORKPLACES_DIR=/app/workplaces \
    AGENT_DIR=/app/.pi \
    DEFAULT_PROVIDER=openai \
    DEFAULT_MODEL=gpt-4o \
    DB_HOST=127.0.0.1 \
    DB_PORT=3306 \
    DB_USER=root \
    DB_NAME=agent_service_kit

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Runtime sources are needed for migrations and scripts executed by workspaces.
COPY src/ ./src/
COPY migrations/ ./migrations/

# Bake the demo agent registry and workspace into the image.
COPY agents.json ./agents.json
COPY workplaces/ ./workplaces/
COPY workplaces/ .workplaces-baked/

COPY baked-workspace-check.cjs /app/baked-workspace-check.cjs
RUN node /app/baked-workspace-check.cjs

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh && chmod +x /app/docker-entrypoint.sh

RUN set -e; \
    apk_ok=0; \
    for i in 1 2 3 4 5; do \
      if apk add --no-cache su-exec; then apk_ok=1; break; fi; \
      echo "[build] apk fetch failed (attempt $i/5), retrying in 10s"; \
      sleep 10; \
    done; \
    [ "$apk_ok" -eq 1 ]
ENV PATH="/app/.venv/bin:$PATH"

ARG INSTALL_PYTHON_RUNTIME
# Optional Python runtime and per-workspace dependencies. Disabled by default
# so the quick-start image stays small and builds on restricted networks.
RUN if [ "$INSTALL_PYTHON_RUNTIME" = "true" ]; then \
      set -e; \
      apk add --no-cache python3 py3-pip; \
      python3 -m venv /app/.venv; \
      for ws in /app/workplaces/*/; do \
        if [ -f "$ws/requirements.txt" ]; then \
          pip install --no-cache-dir -r "$ws/requirements.txt"; \
        elif [ -f "$ws/pyproject.toml" ]; then \
          python3 -c "import tomllib; print('\n'.join(tomllib.load(open('$ws/pyproject.toml','rb')).get('project', {}).get('dependencies', [])))" > /tmp/ws-deps.txt; \
          if [ -s /tmp/ws-deps.txt ]; then pip install --no-cache-dir -r /tmp/ws-deps.txt; fi; \
        fi; \
      done; \
      rm -f /tmp/ws-deps.txt /root/.cache/pip; \
    fi

RUN mkdir -p /app/data /app/workplaces /app/.pi \
    && chown -R node:node /app

USER root
EXPOSE 3001
VOLUME ["/app/data", "/app/workplaces"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
