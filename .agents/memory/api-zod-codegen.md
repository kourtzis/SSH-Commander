---
name: api-zod is orval-generated
description: Where @workspace/api-zod schemas come from and how to add request-body validation
---

`@workspace/api-zod` is NOT hand-written — it is orval-generated from the OpenAPI
spec in `lib/api-spec` (`pnpm --filter @workspace/api-spec run codegen`). Schemas
like `CreateGroupBody`/`AddGroupMemberBody` come from `./generated/api`.

**Rule:** to add request-body validation for a route, either (a) extend the
OpenAPI spec in `lib/api-spec` and regenerate, or (b) for surgical/local cases,
define an inline zod schema in the route file. zod is the catalog version
(3.25.x) and the codebase imports the v4 API via `import { z } from "zod/v4"`
(matches `lib/db` schema files).

**Why:** hand-adding a name to `@workspace/api-zod` gets blown away on the next
codegen run. T7 (validating POST/PUT /credentials and PUT /groups/:id/move) used
inline zod schemas to avoid touching the codegen pipeline.

**How to apply:** any package that imports `pg` types (e.g. `PoolClient`) needs
`@types/pg` in its OWN devDependencies — it is not inherited from `lib/db`. Also
note `Awaited<ReturnType<typeof pool.connect>>` resolves to `void` because pg's
`connect` is overloaded (the callback overload wins); import `PoolClient` from
`pg` instead.
