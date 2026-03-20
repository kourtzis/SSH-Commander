FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json lib/db/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-zod/package.json lib/api-zod/
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/mikro-manager/package.json artifacts/mikro-manager/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/lib/db/node_modules ./lib/db/node_modules
COPY --from=deps /app/lib/api-spec/node_modules ./lib/api-spec/node_modules
COPY --from=deps /app/lib/api-client-react/node_modules ./lib/api-client-react/node_modules
COPY --from=deps /app/lib/api-zod/node_modules ./lib/api-zod/node_modules
COPY --from=deps /app/artifacts/api-server/node_modules ./artifacts/api-server/node_modules
COPY --from=deps /app/artifacts/mikro-manager/node_modules ./artifacts/mikro-manager/node_modules
COPY --from=deps /app/scripts/node_modules ./scripts/node_modules
COPY . .
ENV BASE_PATH=/
RUN pnpm build

FROM base AS production
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && \
    rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/lib/db/package.json lib/db/
COPY --from=build /app/scripts/package.json scripts/
COPY --from=build /app/artifacts/api-server/package.json artifacts/api-server/
COPY --from=build /app/lib/api-spec/package.json lib/api-spec/
COPY --from=build /app/lib/api-client-react/package.json lib/api-client-react/
COPY --from=build /app/lib/api-zod/package.json lib/api-zod/
COPY --from=build /app/artifacts/mikro-manager/package.json artifacts/mikro-manager/
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
