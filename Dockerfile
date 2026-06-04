FROM node:20-slim AS base
# Cache corepack's pnpm in a shared, world-readable location (not root's home)
# so the non-root `node` user can run pnpm at build AND runtime without
# re-downloading it. The runtime entrypoint shells out to `pnpm exec
# drizzle-kit push` / `pnpm --filter ... run seed` as the node user.
ENV COREPACK_HOME=/opt/corepack
# Pin pnpm to the version that generated pnpm-lock.yaml (lockfileVersion 9.0).
# Do NOT use pnpm@latest: pnpm 11.x requires Node >=22.13 (it imports the
# node:sqlite builtin), which crashes on this node:20 base with
# "No such built-in module: node:sqlite". Pinning also keeps --frozen-lockfile
# from drifting against a newer pnpm.
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate \
    && chmod -R a+rX /opt/corepack
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
# Run as the non-root `node` user (uid/gid 1000) from the very start. Without
# this, any RCE in our process — or a malicious SSH script that abuses ssh2's
# local socket APIs — runs as root with full container privileges. Container-only
# defence in depth; capabilities can still be further dropped at `docker run`
# time with --cap-drop=ALL --security-opt=no-new-privileges.
#
# We deliberately do NOT end with `RUN chown -R node:node /app`: that recurses
# over pnpm's node_modules virtual store (tens of thousands of hardlinked files)
# and adds minutes to every build. Instead we chown the (empty) workdir once,
# switch to `node`, and let `COPY --chown` + a node-run `pnpm install` create
# every file already owned by node. corepack's pnpm lives in the shared
# /opt/corepack (see base stage), so the node user can run it.
RUN chown node:node /app
USER node
COPY --chown=node:node pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY --chown=node:node lib/db/package.json lib/db/tsconfig.json ./lib/db/
COPY --chown=node:node lib/api-spec/package.json lib/api-spec/
COPY --chown=node:node lib/api-client-react/package.json lib/api-client-react/
COPY --chown=node:node lib/api-zod/package.json lib/api-zod/
COPY --chown=node:node artifacts/api-server/package.json artifacts/api-server/
COPY --chown=node:node artifacts/mikro-manager/package.json artifacts/mikro-manager/
COPY --chown=node:node scripts/package.json scripts/
RUN pnpm install --frozen-lockfile
COPY --chown=node:node --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --chown=node:node --from=build /app/artifacts/mikro-manager/dist/public ./public
COPY --chown=node:node --from=build /app/lib/db ./lib/db
COPY --chown=node:node --from=build /app/scripts ./scripts
COPY --chown=node:node docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PUBLIC_DIR=/app/public
ENV PORT=3000
EXPOSE 3000

# Container-level liveness probe. Hits the public health endpoint we expose
# at /api/healthz; node's built-in fetch (Node 18+) avoids needing wget/curl
# in the slim image. Failing health flips the container to "unhealthy" so
# orchestrators (Docker swarm, k8s, watchtower) can restart it. Start period
# allows for the first-boot drizzle-kit push + seed step to complete.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "artifacts/api-server/dist/index.cjs"]
