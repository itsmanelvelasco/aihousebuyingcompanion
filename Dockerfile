FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node apps/mcp-server ./apps/mcp-server
COPY --chown=node:node apps/interviewer ./apps/interviewer
COPY --chown=node:node packages ./packages
COPY --chown=node:node data/towns.json data/incentives.json ./data/

USER node
EXPOSE 8787
CMD ["node", "apps/mcp-server/index.ts"]
