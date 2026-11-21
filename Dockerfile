FROM node:24-bookworm-slim AS widget

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY apps/mcp-server/town-explorer-widget.ts ./apps/mcp-server/
COPY packages/contracts ./packages/contracts
RUN npm run build:mcp-ui

FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node apps/mcp-server ./apps/mcp-server
COPY --chown=node:node apps/interviewer ./apps/interviewer
COPY --from=widget --chown=node:node /app/apps/mcp-server/dist ./apps/mcp-server/dist
COPY --chown=node:node apps/profile-api/finance.ts apps/profile-api/store.ts ./apps/profile-api/
COPY --chown=node:node apps/habits-agent/agent.ts apps/habits-agent/contracts.ts ./apps/habits-agent/
COPY --chown=node:node packages ./packages
COPY --chown=node:node data/towns.json data/incentives.json data/travel-estimates.json data/relocat-pilot-data.json ./data/

USER node
EXPOSE 8787
CMD ["node", "apps/mcp-server/index.ts"]
