# Public ReloCat MCP server (apps/mcp-server). Build context is trimmed by .dockerignore.
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

COPY --chown=node:node apps/mcp-server ./apps/mcp-server
COPY --from=build --chown=node:node /app/apps/mcp-server/dist ./apps/mcp-server/dist
COPY --chown=node:node packages ./packages
COPY --chown=node:node data ./data

USER node
EXPOSE 8787
CMD ["node", "apps/mcp-server/index.ts"]
