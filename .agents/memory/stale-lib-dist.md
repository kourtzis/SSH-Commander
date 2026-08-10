---
name: stale lib dist breaks typecheck (TS6305)
description: missing/stale lib/*/dist .d.ts causes TS6305 cascades in consumers; some libs have no build script
---

A missing or stale `lib/<pkg>/dist/*.d.ts` produces TS6305 ("Output file has not been built from
source") cascades in every consumer — it looks like consumer-side breakage but is not.

**Fix:** `pnpm exec tsc -b lib/<pkg> --force`.

**Trap:** some lib packages have NO build script, so `pnpm run --if-present build` (and `|| true`
fallbacks) silently no-op and leave dist stale. Check the package.json scripts before trusting a
"build succeeded" that printed nothing.
