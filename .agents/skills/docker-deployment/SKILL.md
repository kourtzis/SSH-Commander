---
name: docker-deployment
description: Best practices for Dockerizing Node.js/pnpm monorepo apps. Use when creating Dockerfiles, docker-compose files, or debugging Docker build/runtime errors for any Node.js application.
---

# Docker Deployment for Node.js / pnpm Monorepos

## Common Pitfalls and Solutions

### 1. pnpm node_modules Cannot Be Copied Between Docker Stages

pnpm uses a content-addressable store with symlinks in `node_modules`. Docker `COPY` flattens symlinks, breaking module resolution for native modules (`bcrypt`, `ssh2`, `pg`, etc.).

**Wrong:**
```dockerfile
COPY --from=build /app/node_modules ./node_modules
```

**Correct:** Run a fresh `pnpm install` in the production stage:
```dockerfile
FROM base AS production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Copy all workspace package.json files...
RUN pnpm install --frozen-lockfile
COPY --from=build /app/path/to/dist ./path/to/dist
```

### 2. import.meta.url Is Undefined in CJS Bundles

When esbuild bundles ESM code to CJS format (`format: "cjs"`), `import.meta.url` and `import.meta.dirname` are `undefined`. Using `fileURLToPath(import.meta.url)` will throw `ERR_INVALID_ARG_TYPE`.

**Wrong:**
```typescript
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(__dirname, "../public");
```

**Correct:** Use `process.cwd()` or `process.env` for paths:
```typescript
const dir = process.env.PUBLIC_DIR || path.resolve(process.cwd(), "public");
```

### 3. Vite Config Must Not Require Env Vars at Build Time

Vite config files that throw on missing `PORT` or other runtime env vars will crash during `docker build` since those vars don't exist at build time.

**Wrong:**
```typescript
const port = process.env.PORT;
if (!port) throw new Error("PORT required");
```

**Correct:** Provide sensible defaults for build mode:
```typescript
const isBuild = process.argv.includes("build");
const port = process.env.PORT || (isBuild ? "3000" : undefined);
if (!port) throw new Error("PORT required");
```

### 4. Replit-Specific Plugins Must Be Optional

Plugins like `@replit/vite-plugin-runtime-error-modal`, `@replit/vite-plugin-cartographer`, and `@replit/vite-plugin-dev-banner` are not available outside Replit.

**Wrong:**
```typescript
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";
plugins: [runtimeErrorOverlay()]
```

**Correct:** Use dynamic import with try/catch:
```typescript
try {
  const mod = await import("@replit/vite-plugin-runtime-error-modal");
  plugins.push(mod.default());
} catch {}
```

### 5. Shell Script Line Endings (CRLF vs LF)

Entrypoint scripts with Windows-style line endings (`\r\n`) cause `exec ./script.sh: no such file or directory` even though the file exists. The shebang line `#!/bin/sh\r` is not recognized.

**Always add this safety net in the Dockerfile:**
```dockerfile
COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh
```

### 6. Dev Dependencies Needed at Runtime

Tools like `tsx` (TypeScript executor) are typically devDependencies but may be needed at container startup (e.g., for seed scripts or migrations that use `.ts` files). Using `pnpm install --prod` will exclude them.

**Solutions (pick one):**
- Don't use `--prod` flag — run full `pnpm install --frozen-lockfile`
- Pre-compile seed/migration scripts during the build stage
- Move runtime-critical tools to `dependencies`

### 7. Native Module Build Tools

Native modules (`bcrypt`, `ssh2`, `cpu-features`, `pg`) require build tools. Always install them:
```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
```

## Recommended Dockerfile Structure for pnpm Monorepos

```dockerfile
FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# --- Build stage: install ALL deps, compile everything ---
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
# Copy ALL workspace package.json files
COPY lib/*/package.json ./lib/
COPY artifacts/*/package.json ./artifacts/
COPY scripts/package.json scripts/
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN pnpm install --frozen-lockfile
COPY . .
# Set build-time env vars with safe defaults
ENV PORT=3000
RUN pnpm -r run build

# --- Production stage: fresh install + built artifacts ---
FROM base AS production
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
# Copy ALL workspace package.json files (same as build stage)
COPY lib/*/package.json ./lib/
COPY artifacts/*/package.json ./artifacts/
COPY scripts/package.json scripts/
RUN pnpm install --frozen-lockfile
# Copy ONLY built output from build stage
COPY --from=build /app/artifacts/server/dist ./artifacts/server/dist
COPY --from=build /app/artifacts/frontend/dist ./public
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "artifacts/server/dist/index.cjs"]
```

### 8. Packages That Depend on Native Externals Must Also Be External

If a package (like `connect-pg-simple`) is in the esbuild bundle allowlist but internally `require()`s a native external (like `pg`), the resolution breaks at runtime. The bundled code can't find the native module.

**Wrong:** Bundling `connect-pg-simple` while `pg` is external:
```typescript
const allowlist = ["connect-pg-simple", ...]; // bundled
const nativeExternals = ["pg", ...]; // external
// connect-pg-simple's require('pg') fails at runtime
```

**Correct:** Move packages that depend on native externals to the externals list:
```typescript
const nativeExternals = ["connect-pg-simple", "pg", ...]; // both external
```

**Rule of thumb:** If package A depends on package B, and B is external, then A must also be external.

### 9. Express 5 Wildcard Routes Use Different Syntax

Express 5 uses a new `path-to-regexp` that rejects bare `*` wildcards. This crashes the app at startup with `TypeError: Missing parameter name at index 1: *`.

**Wrong (Express 5):**
```typescript
app.get("*", handler);
```

**Correct (Express 5):**
```typescript
app.get("/{*splat}", handler);
```

This is especially common in SPA catch-all routes that serve `index.html`. The error only surfaces in the production bundle because the catch-all route is often gated behind `NODE_ENV === "production"`.

### 10. Always Test the Production Bundle Locally Before Dockerizing

Run the built bundle with production env vars to catch runtime errors early:
```bash
PORT=3000 NODE_ENV=production PUBLIC_DIR=./public node dist/index.cjs
```

This catches issues like missing modules, broken `import.meta`, and Express 5 route syntax errors — all of which pass the build step but crash at runtime.

## Checklist Before Creating a Dockerfile

- [ ] Identify all native modules (externals in esbuild config) — they need build tools
- [ ] Check for `import.meta.url` / `import.meta.dirname` usage in bundled code
- [ ] Check vite.config for hard env var requirements — add build-time defaults
- [ ] Check for Replit-specific imports — wrap in try/catch
- [ ] Check seed/migration scripts — do they need devDependencies at runtime?
- [ ] Ensure entrypoint scripts have LF line endings (add `sed` safety net)
- [ ] Use fresh `pnpm install` in production stage — never copy `node_modules`
