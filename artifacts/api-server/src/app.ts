import path from "path";
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import rateLimit from "express-rate-limit";
import { pool as dbPool } from "@workspace/db";
import router from "./routes/index.js";

const app: Express = express();

const isProd = process.env.NODE_ENV === "production";

// ─── Trust proxy ────────────────────────────────────────────────────
// Whether to trust the X-Forwarded-For header from upstream proxies, and
// how many hops to honor. This is deployment-topology-specific:
//
//   * In Replit dev and Replit Deployments we sit behind exactly one
//     proxy hop (the Replit edge), so we trust 1 hop.
//   * Operators who deploy with a reverse proxy in front (nginx, Caddy,
//     Traefik, Cloudflare, k8s ingress) should set TRUST_PROXY_HOPS to
//     the number of trusted hops.
//   * Operators who expose the container's port directly to the public
//     internet (e.g. `docker run -p 3000:3000` with no proxy) MUST leave
//     TRUST_PROXY_HOPS at 0, otherwise a hostile client can spoof their
//     source IP via a forged X-Forwarded-For header and slip past the
//     login rate limiter.
//
// Default: 1 hop everywhere. The overwhelmingly common deployment is
// behind a single HTTPS reverse proxy (Replit edge, nginx, Caddy,
// Traefik, Cloudflare, k8s ingress). Defaulting to 0 in production
// silently breaks login: when `cookie.secure` is true (HTTPS-only
// cookies, the default below in prod), express-session refuses to
// emit a Set-Cookie header unless `req.secure === true`. With trust
// proxy at 0 behind an HTTPS proxy, `req.protocol` is "http" and
// `req.secure` is false, so the session cookie never reaches the
// browser even though the login response is 200. Trust proxy = 1
// fixes this. Operators who genuinely expose the container's port
// directly to the internet without any proxy in front MUST set
// TRUST_PROXY_HOPS=0 to avoid IP-spoofing of the rate limiter via
// forged X-Forwarded-For. That is the rare case; opt out, don't opt in.
const trustProxyEnv = process.env.TRUST_PROXY_HOPS;
const trustProxyHops = trustProxyEnv !== undefined
  ? Math.max(0, parseInt(trustProxyEnv, 10) || 0)
  : 1;
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
  console.log(`[app] Trusting ${trustProxyHops} proxy hop(s) for X-Forwarded-* headers`);
} else {
  // Operator explicitly opted out (TRUST_PROXY_HOPS=0). Warn once so
  // it's obvious in logs why client IPs all look like the loopback or
  // proxy address.
  console.log("[app] trust proxy disabled (TRUST_PROXY_HOPS=0). Only correct if the container is exposed directly without a reverse proxy.");
}

// ─── Middleware Stack ───────────────────────────────────────────────
// CORS: in production we restrict to the configured origin(s) so that a
// logged-in user visiting another site can't issue authenticated requests
// against the API. In development we allow same-origin browsers (no Origin
// header on same-origin fetch, so cors() is effectively a no-op).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (isProd && allowedOrigins.length > 0) {
  app.use(
    cors({
      origin: (origin, cb) => {
        // Same-origin requests (no Origin header) and listed origins are allowed.
        if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
        cb(new Error("Not allowed by CORS"));
      },
      credentials: true,
    }),
  );
} else if (isProd) {
  // In production with no allow-list, refuse cross-origin browser requests
  // outright — same-origin (no Origin header) still works because cors() is
  // a no-op for same-origin fetch.
  app.use(cors({ origin: false, credentials: true }));
} else {
  // Dev: keep the previous permissive behavior so the Replit preview proxy works.
  app.use(cors({ origin: true, credentials: true }));
}

// JSON: tightened from 10mb. Excel imports go through dedicated endpoints
// that override this on the route itself.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// ─── Session Configuration ──────────────────────────────────────────
// In production the SESSION_SECRET MUST be provided. We refuse to start with
// the placeholder fallback because anyone who knows it could forge sessions.
const SESSION_SECRET = process.env.SESSION_SECRET;
// 1.14.0 M-13: refuse the well-known placeholder strings outright, even if
// they're long enough to pass the length check. Operators copy-pasting an
// example .env into prod would otherwise ship a forgable session signer.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "change-this-to-a-long-random-string",
  "ssh-commander-dev-only-secret-change-in-prod",
  "your-secret-here",
  "changeme",
]);
if (isProd && (!SESSION_SECRET || SESSION_SECRET.length < 16 || KNOWN_PLACEHOLDER_SECRETS.has(SESSION_SECRET))) {
  throw new Error(
    "SESSION_SECRET environment variable is required in production (min 16 chars, must not be a placeholder). " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}
// 1.14.0 M-13 follow-up: in dev (or any non-prod environment) where
// SESSION_SECRET is unset OR matches a known placeholder, generate a
// random ephemeral secret per process start instead of falling back to
// a hardcoded literal that an attacker on the same machine could guess.
// The trade-off is that all sessions are invalidated on every dev
// server restart — which is the right behaviour for dev anyway.
const EFFECTIVE_SESSION_SECRET: string = (() => {
  if (SESSION_SECRET && SESSION_SECRET.length >= 16 && !KNOWN_PLACEHOLDER_SECRETS.has(SESSION_SECRET)) {
    return SESSION_SECRET;
  }
  // Any non-prod path that gets here: generate fresh, warn loudly. We
  // can't reach this branch in prod (the throw above already fired).
  const ephemeral = require("crypto").randomBytes(32).toString("hex");
  console.warn(
    "[app] SESSION_SECRET is unset or a known placeholder — using an EPHEMERAL random secret for this process. " +
    "Sessions will not survive a server restart. Set SESSION_SECRET in your environment to silence this warning.",
  );
  return ephemeral;
})();

// Whether the session cookie should carry the `Secure` flag. The `Secure`
// flag tells the browser to send the cookie only over HTTPS, AND tells
// express-session to refuse to issue the Set-Cookie header at all unless
// it believes the request itself was secure (`req.secure === true`).
//
// That second behavior is the trap: if the operator runs SSH Commander
// behind a reverse proxy that terminates TLS but does NOT forward the
// `X-Forwarded-Proto: https` header (or sits in front of the container
// over plain HTTP), `req.secure` is false and the session cookie is
// silently dropped. The user logs in successfully, the server creates
// the session, but the browser never receives the cookie, so the next
// request looks unauthenticated and the login dialog reappears.
//
// Resolution order:
//   1. If COOKIE_SECURE is explicitly set to "true" or "false", honor it.
//   2. Otherwise, default to true in production and false in development.
// The explicit env override is the escape hatch for HTTPS-terminating
// proxies that don't set X-Forwarded-Proto, and for plain-HTTP intranet
// deployments. Set COOKIE_SECURE=false in those cases.
const cookieSecureEnv = process.env.COOKIE_SECURE?.toLowerCase();
const cookieSecure = cookieSecureEnv === "true" ? true
  : cookieSecureEnv === "false" ? false
  : isProd;
if (isProd && !cookieSecure) {
  console.log("[app] Session cookie 'Secure' flag DISABLED (COOKIE_SECURE=false). Only safe behind a trusted reverse proxy on a private network.");
}

const sessionConfig: session.SessionOptions = {
  secret: EFFECTIVE_SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // `rolling: true` extends the cookie's `Max-Age` on every response, so an
  // active operator's 7-day window keeps sliding forward as long as they're
  // making requests. Without this, the cookie expiry is fixed at login time
  // and the user is kicked out exactly 7 days later regardless of activity.
  rolling: true,
  // express-session relies on `req.secure` to decide whether to emit a
  // Secure cookie. With `trust proxy` set above, `req.secure` correctly
  // reflects the upstream proxy's `X-Forwarded-Proto` header.
  proxy: true,
  cookie: {
    secure: cookieSecure, // overridable via COOKIE_SECURE env var (see comment above)
    httpOnly: true,    // Prevent client-side JS from reading the session cookie
    sameSite: "lax",   // CSRF protection while allowing normal navigation; "strict" can break login flows from external links
    // 12-hour session lifetime, refreshed on every request via `rolling` above.
    // Tightened from 7 days in 1.13.0: an idle session that long was a long
    // window for credential abuse from a stolen device. With rolling renewal
    // an active operator never notices — the cookie keeps sliding forward
    // for as long as they're using the app — but a forgotten tab on a
    // shared workstation logs itself out by morning.
    maxAge: 12 * 60 * 60 * 1000,
  },
};

// Use the PostgreSQL-backed session store whenever a DATABASE_URL is
// available — including in development. The previous behaviour was to fall
// through to express-session's default in-process MemoryStore in dev, which
// meant every API server restart (version bump, hot-reload of backend code,
// schema push) destroyed every session and kicked the operator out
// mid-action. Persisting sessions to Postgres in dev keeps you logged in
// across restarts, exactly like prod.
if (process.env.DATABASE_URL) {
  try {
    const PgStore = connectPgSimple(session);
    // Reuse the shared Drizzle pg pool instead of letting connect-pg-simple
    // open its own internal Pool from `conString`. Two separate pools meant
    // session reads/writes had only the default 10 connections to themselves
    // and could be starved on bursts of long-running SSH requests — the
    // store would silently fail, express-session would treat the session as
    // empty, and the operator would see "HTTP 401 Unauthorized" mid-action
    // even though their cookie was still valid. With a single shared pool
    // (max 20, see lib/db) all DB ops compete for the same connections and
    // the explicit `connectionTimeoutMillis` ensures failures are loud
    // instead of silent.
    sessionConfig.store = new PgStore({
      pool: dbPool,
      createTableIfMissing: true,
      // Surface session-store query failures. Without this, a failed
      // SELECT during get() is silently swallowed by express-session
      // (which falls back to generating a fresh empty session) — the
      // user is then "logged out" without a single line in the logs.
      errorLog: (...args: unknown[]) => console.warn("[session-store]", ...args),
    } as any);
    console.log("Using PostgreSQL session store (shared pool)");
  } catch (err) {
    console.warn("Failed to initialize PostgreSQL session store, using memory store:", err);
  }
} else if (isProd) {
  // In production a missing DATABASE_URL would silently fall through to
  // express-session's MemoryStore, which is single-process and wiped on
  // every restart. That breaks login for multi-replica deployments and
  // for any container that ever restarts. Refuse to start instead.
  throw new Error(
    "DATABASE_URL is required in production (memory session store is unsafe — sessions would be wiped on every restart and would not be shared across replicas).",
  );
} else {
  console.warn("[app] No DATABASE_URL — falling back to in-memory session store. Sessions will be wiped on server restart.");
}

app.use(session(sessionConfig));

// ─── Rate limiting on auth routes ───────────────────────────────────
// 10 login attempts per 15 minutes per IP. Slows down credential stuffing /
// brute-force without locking out legitimate users.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts, please try again later." },
});
app.use("/api/auth/login", authLimiter);

// ─── CSRF protection ────────────────────────────────────────────────
// We use the "custom request header" pattern: any state-changing request
// (POST/PUT/PATCH/DELETE) under /api must carry an `X-Requested-With`
// header. Browsers refuse to send this header on a simple cross-site
// form submission without a preflight, and our CORS config rejects
// unknown origins on preflight — so an attacker site cannot fire
// authenticated state-changing requests at this API.
//
// Health checks and login itself are exempt: health for liveness
// probes, login because it's the bootstrap step that establishes the
// session in the first place (the rate-limiter and password check
// already protect login).
//
// The middleware is mounted under `/api` rather than at the root so
// that static-asset traffic in production never even runs the check —
// the prior global mount paid `req.path.startsWith("/api/")` on every
// JS/CSS/image request. With the mount under /api, `req.path` is the
// portion *after* /api, so the exempt-set entries also drop the prefix.
const CSRF_EXEMPT_PATHS = new Set(["/healthz", "/auth/login"]);
app.use("/api", (req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next();
  if (req.get("X-Requested-With") !== "XMLHttpRequest") {
    res.status(403).json({ error: "Missing X-Requested-With header (CSRF protection)" });
    return;
  }
  next();
});

// ─── API Routes ─────────────────────────────────────────────────────
app.use("/api", router);

// ─── Production Static File Serving ─────────────────────────────────
if (isProd) {
  const publicDir = process.env.PUBLIC_DIR || path.resolve(process.cwd(), "public");
  app.use(express.static(publicDir));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

// ─── Global Error Handler ───────────────────────────────────────────
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status ?? 500;
  // Diagnostic: log every 401/500 with session context so we can see why
  // an apparently-authenticated user is being rejected. The "kicked out
  // by one fingerprint" report is opaque without this — we need to know
  // whether req.session was actually empty at the moment the 401 fired,
  // and which route fired it.
  if (status === 401 || status >= 500) {
    const sid = (req as any).sessionID;
    const hasSession = !!(req as any).session;
    const hasUserId = !!((req as any).session?.userId);
    const cookieHeader = req.headers.cookie ? "yes" : "no";
    console.warn(
      `[error] ${status} ${req.method} ${req.originalUrl} ` +
      `sid=${sid?.slice(0, 8) ?? "none"} hasSession=${hasSession} hasUserId=${hasUserId} cookieSent=${cookieHeader} ` +
      `msg=${err.message ?? "unknown"}`
    );
    if (status >= 500 && err.stack) console.warn(err.stack);
  }
  res.status(status).json({ error: err.message ?? "Internal server error" });
});

export default app;
