FROM node:24-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libicu72 libstdc++6 libssl3 \
    && rm -r /var/lib/apt/lists
WORKDIR /app

FROM base AS build
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY skills ./skills
COPY tests ./tests
COPY deploy/schema.sql ./deploy/schema.sql
RUN npm test && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS production
ARG APP_REVISION
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/tmp/copilot-mobile APP_REVISION=$APP_REVISION
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src/shared.ts ./src/shared.ts
COPY --from=build /app/skills ./skills
COPY --from=build /app/deploy/schema.sql ./deploy/schema.sql
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=20s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/index.ts"]
