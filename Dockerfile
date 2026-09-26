FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# O SQLite fica aqui — monte um volume para não perder os vínculos.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
USER node
# Só usada quando WEBHOOK_PUBLIC_URL está definido (também responde GET /health)
EXPOSE 3000
CMD ["node", "dist/index.js"]
