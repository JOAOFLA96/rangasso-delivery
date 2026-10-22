# Imagem de produção: API (Fastify) servindo também o build do cardápio/painel.
ARG NODE_IMAGE=node:22-bookworm-slim
# Build:  docker build -t rangasso-delivery .
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
RUN npm ci --no-audit --no-fund
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm -w apps/api run build && npm -w apps/web run build

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
RUN npm ci --omit=dev --workspace apps/api --include-workspace-root=false --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    WEB_DIST_DIR=/app/web \
    UPLOAD_DIR=/data/uploads \
    TRUST_PROXY=true
WORKDIR /app/api
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=deps /app/apps/api/node_modules* /app/api/node_modules/
COPY --from=build /src/apps/api/package.json ./package.json
COPY --from=build /src/apps/api/dist ./dist
COPY --from=build /src/apps/api/migrations ./migrations
COPY --from=build /src/apps/web/dist /app/web
RUN chmod -R a+rX /app/web /app/api && mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/public/store').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
