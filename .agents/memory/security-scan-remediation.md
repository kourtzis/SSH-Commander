---
name: security-scan remediation
description: How to fix dependency CVEs in this pnpm monorepo and handle scanner false positives
---

# Security-scan remediation

**Rule:** Fix transitive npm CVEs with `pnpm.overrides` in the ROOT package.json, not per-workspace edits. Selector syntax handles per-major pins (e.g. `"brace-expansion@1": ">=1.1.18 <2"`, `"brace-expansion@2": ">=2.1.4 <3"`).

**Why:** Bumping a direct dependency's range does NOT fix peer-resolved duplicates — vitest kept its own `vite@old` peer instance in the lockfile even after both workspaces moved to the patched range. Only a root override (`"vite": ">=x <y"`) forces every instance, peers included. Verify with `grep <pkg>@<oldver> pnpm-lock.yaml` after `pnpm install`, then re-run the audit.

**How to apply:** After any dependency-audit finding: add/extend root `pnpm.overrides` → `pnpm install` → grep lockfile for the old versions → restart affected workflows (dev servers hold old modules in memory).

**Scanner false positives:** The platform SAST runner IGNORES `nosemgrep` comments in every placement (inline, line-above, scoped or bare) — suppression comments are not a viable path here. Either restructure so the pattern no longer matches (prefer restructures that are better code anyway, e.g. a known-weak-password denylist loaded from a JSON data file instead of literals in code), or accept + document the finding. Never delete a deliberate security detector just to silence a scan.

**Read the column numbers before chasing a literal:** the bcrypt "hardcoded string" rule flags ANY string literal in the expression chain feeding bcrypt — its first hit here was the `"base64"`/`"hex"` ENCODING argument in `crypto.randomBytes(n).toString(enc)` assigned to the password, not the obvious-looking password literal elsewhere. Its const-propagation even folds `"admin" + "123"` and literal arrays into loop variables. `crypto.randomUUID()` is the literal-free generator that passes.

**Compose hardening pattern:** prod compose must fail fast via `${VAR:?message}` for DB password, session secret, and the credential-encryption key — no `:-changeme` style defaults. Remember upgrade path: operators whose postgres volume was initialized under an old default must set that value first, then rotate inside postgres.
