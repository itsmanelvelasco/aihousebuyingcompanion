# The ReloCat server (apps/server): MCP endpoint, board, workspace, API and connect page on one origin.
FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY apps ./apps
COPY packages ./packages
COPY scripts/build.ts ./scripts/build.ts
RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /app
# The database gets a folder of its own so a volume can hold it together with its write-ahead log.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATABASE_FILE=data/db/relocat.db

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build --chown=node:node /app/apps ./apps
COPY --chown=node:node packages ./packages
COPY --chown=node:node data ./data
RUN mkdir -p data/db data/cache data/runtime-users data/runtime-habits && chown -R node:node data

# Mount data/db to keep all runtime state (the SQLite database) and data/cache to keep fetched
# official data. The two runtime-* folders are only read, once, to import JSON files written by
# versions without a database; mount them when upgrading such a deployment.
VOLUME ["/app/data/db", "/app/data/cache", "/app/data/runtime-users", "/app/data/runtime-habits"]

USER node
EXPOSE 8787
CMD ["node", "apps/server/index.ts"]
