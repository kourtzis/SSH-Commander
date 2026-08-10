---
name: TanStack v5 + orval hook gotchas
description: keepPreviousData removal and orval's explicit-queryKey requirement when passing query options
---

## TanStack Query v5
`keepPreviousData: true` was removed in v5. Equivalent behavior: `placeholderData: (prev) => prev`.

## orval-generated hooks
When passing a custom query-options object to a generated hook, you MUST also pass the generated
`queryKey` explicitly (import the matching `getGet...QueryKey(params)` helper).

**Why:** orval only injects the key automatically when you pass no options object; omitting it is a
type error, and hand-writing a key would silently break cache identity with the rest of the app.
