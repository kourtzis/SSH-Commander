---
name: release version markers
description: All the places a SSH Commander version number must be bumped for a release
---

A release bumps FIVE version markers that must stay in sync, plus changelog:

1. root `package.json` "version"
2. `artifacts/api-server/package.json` "version"
3. `artifacts/mikro-manager/package.json` "version"
4. `VERSION` file (root) — easy to forget; it has gone stale before
5. `artifacts/mikro-manager/src/lib/version.ts` — both `APP_VERSION` AND
   `APP_VERSION_DATE`, plus a new entry prepended to the `CHANGELOG` array
6. `CHANGELOG.md` — new `## [x.y.z] - DATE` section at the top

`lib/*/package.json` stay at 0.0.0 (internal workspace pkgs, not versioned).

**Semver scheme** (documented at top of CHANGELOG.md): MAJOR = big features/
breaking, MINOR = substantial fixes + minor features, PATCH = small fixes.

**Why:** the in-app About/changelog page reads `version.ts`; Docker image
tags and the README reference `VERSION`. A missed marker ships an app that
reports the wrong version to operators.
