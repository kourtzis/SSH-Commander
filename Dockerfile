FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY lib/db/package.json lib/db/tsconfig.json ./lib/db/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-zod/package.json lib/api-zod/
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/mikro-manager/package.json artifacts/mikro-manager/
COPY scripts/package.json scripts/
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
COPY . .
ENV BASE_PATH=/
ENV PORT=3000
RUN pnpm -r --filter @workspace/db --if-present run build && \
    pnpm -r --filter @workspace/api-zod --if-present run build && \
    pnpm -r --filter @workspace/api-client-react --if-present run build && \
    pnpm --filter @workspace/mikro-manager run build && \
    pnpm --filter @workspace/api-server run build

FROM base AS production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY lib/db/package.json lib/db/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-zod/package.json lib/api-zod/
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/mikro-manager/package.json artifacts/mikro-manager/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/mikro-manager/dist/public ./public
COPY --from=build /app/lib/db ./lib/db
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PUBLIC_DIR=/app/public
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "artifacts/api-server/dist/index.cjs"]
