---
name: mikro-manager fetch() BASE_URL slash gotcha
description: Recurring class of bug where fetch URLs in the web app break depending on whether baseUrl keeps or strips its trailing slash.
---

# BASE_URL slash gotcha in mikro-manager fetch calls

`import.meta.env.BASE_URL` always ends in a slash (`/` in dev, `/<slug>/` in prod). The codebase
uses TWO inconsistent local conventions, sometimes in the same file/scope:

- `const baseUrl = import.meta.env.BASE_URL || "/";` (slash kept) → must write `` `${baseUrl}api/...` ``
- `const baseUrl = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");` (slash stripped) → must
  write `` `${baseUrl}/api/...` ``

Mixing them silently breaks requests:
- stripped baseUrl + `api/...` → dev produces a **relative** URL (`api/...`, resolved against the
  current page path) and prod produces `/<slug>api/...` (missing slash). Both 404.
- slash-kept baseUrl + `/api/...` → `//api/...` (protocol-relative) in dev.

**Why:** `pages/jobs/detail.tsx` defines the stripped form at component scope but some inner
handlers re-declare the slash-kept form locally — easy to grab the wrong one. The parked-task
bulk buttons (`respond-all`, `abort-all`) were broken this way while per-device + interactive
respond happened to be correct.

**How to apply:** prefer a single shared helper (e.g. `apiUrl(path)`), and when editing fetch
calls in mikro-manager, check which `baseUrl` variant is actually in scope before adding/removing
the leading slash. Grep `${baseUrl}api/` vs `${baseUrl}/api/` to spot mismatches.
