# The Agent World hub — a self-contained image.
#
# Multi-stage: build the core SDK + studio server with pnpm, then ship only the
# built dist + production node_modules on a slim runtime. State (journal.jsonl,
# hub.key) lives on a mounted volume at /state, never in the image.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /src

# The hub depends on core/ workspace packages; copy both trees.
COPY core ./core
COPY studio ./studio

WORKDIR /src/core
RUN pnpm install --frozen-lockfile=false && pnpm -r build

WORKDIR /src/studio
RUN pnpm install --frozen-lockfile=false && pnpm -r build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Unprivileged user; state dir owned by it.
RUN useradd --system --create-home --uid 10001 aw
WORKDIR /app

COPY --from=build /src/core /app/core
COPY --from=build /src/studio /app/studio

RUN mkdir -p /state && chown -R aw:aw /state /app
USER aw
VOLUME /state
EXPOSE 7800

ENV AW_HUB_HOST=0.0.0.0 AW_HUB_PORT=7800
# --dir on the volume; --host from env (0.0.0.0 so the container is reachable).
ENTRYPOINT ["node", "studio/server/dist/index.js"]
CMD ["--dir", "/state", "--port", "7800", "--host", "0.0.0.0"]
