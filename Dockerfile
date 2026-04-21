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
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY lib/db/package.json lib/db/tsconfig.json ./lib/db/
COPY lib/api-spec/package.json lib/api-spec/
COPY lib/api-client-react/package.json lib/api-client-react/
COPY lib/api-zod/package.json lib/api-zod/
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/mikro-manager/package.json artifacts/mikro-manager/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/mikro-manager/dist/public ./public
COPY --from=build /app/lib/db ./lib/db
COPY --from=build /app/scripts ./scripts
COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PUBLIC_DIR=/app/public
ENV PORT=3000
EXPOSE 3000

# Run as a non-root user. The base image's `node` user (uid/gid 1000) already
# exists, so we just chown the app tree and switch to it. Without this, any
# RCE in our process — or a malicious SSH script that abuses ssh2's local
# socket APIs — runs as root with full container privileges. Container-only
# defence in depth; capabilities can still be further dropped at `docker run`
# time with --cap-drop=ALL --security-opt=no-new-privileges.
RUN chown -R node:node /app
USER node

# Container-level liveness probe. Hits the public health endpoint we expose
# at /api/healthz; node's built-in fetch (Node 18+) avoids needing wget/curl
# in the slim image. Failing health flips the container to "unhealthy" so
# orchestrators (Docker swarm, k8s, watchtower) can restart it. Start period
# allows for the first-boot drizzle-kit push + seed step to complete.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "artifacts/api-server/dist/index.cjs"]
