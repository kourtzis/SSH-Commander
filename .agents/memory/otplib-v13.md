---
name: otplib v13 API
description: otplib v13 removed the v12 `authenticator` facade — new function names, and epochTolerance is in seconds
---

## v12 → v13 breaking changes (hit 2026-08)
The `authenticator.generateSecret/keyuri/verify` facade from v12 no longer exists in v13.
Replacements: `generateSecret()`, `generateURI({ issuer, label, secret })`,
`verifySync({ secret, token, epochTolerance }).valid`.

**Gotcha:** `epochTolerance` is in SECONDS (30 ≈ ±1 TOTP step), not window steps like v12's `window` option.

**How to apply:** all TOTP logic in this repo goes through the wrapper in the api-server's `lib/totp.ts` — extend that wrapper rather than importing otplib elsewhere.
