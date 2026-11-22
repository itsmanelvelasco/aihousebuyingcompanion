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
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build --chown=node:node /app/apps ./apps
COPY --chown=node:node packages ./packages
COPY --chown=node:node data ./data
RUN mkdir -p data/cache data/runtime-users data/runtime-habits && chown -R node:node data

# Mount these to keep profiles, habits and the data cache across deployments.
VOLUME ["/app/data/runtime-users", "/app/data/runtime-habits", "/app/data/cache"]

USER node
EXPOSE 8787
CMD ["node", "apps/server/index.ts"]
