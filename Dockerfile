FROM node:22.22.1-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
RUN npm run build && mkdir -p /app/.data && chown node:node /app/.data
USER node
EXPOSE 3000
CMD ["node", "dist/apps/server/src/main.js"]
