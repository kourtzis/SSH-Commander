import path from "path";
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import rateLimit from "express-rate-limit";
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
// Default: 1 hop in development (we know we're behind the Replit proxy),
// 0 hops in production (operator must opt in by setting the env var) so
// a missing or incorrect deployment config fails closed rather than
// silently allowing IP spoofing.
const trustProxyEnv = process.env.TRUST_PROXY_HOPS;
const trustProxyHops = trustProxyEnv !== undefined
  ? Math.max(0, parseInt(trustProxyEnv, 10) || 0)
  : (isProd ? 0 : 1);
if (trustProxyHops > 0) {
  app.set("trust proxy", trustProxyHops);
  console.log(`[app] Trusting ${trustProxyHops} proxy hop(s) for X-Forwarded-* headers`);
} else if (isProd) {
  // Helpful nudge: most production deployments sit behind a proxy and
  // will hit the express-rate-limit `X-Forwarded-For` validation error
  // until TRUST_PROXY_HOPS is set. Print this once at startup so the
  // operator knows what to do.
  console.log("[app] trust proxy disabled (set TRUST_PROXY_HOPS=1 if behind a single reverse proxy)");
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
if (isProd && (!SESSION_SECRET || SESSION_SECRET.length < 16)) {
  throw new Error(
    "SESSION_SECRET environment variable is required in production (min 16 chars). " +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  );
}

const sessionConfig: session.SessionOptions = {
  secret: SESSION_SECRET ?? "ssh-commander-dev-only-secret-change-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,    // HTTPS-only cookies in production (set to false if you terminate TLS in front of the app and need HTTP)
    httpOnly: true,    // Prevent client-side JS from reading the session cookie
    sameSite: "lax",   // CSRF protection while allowing normal navigation; "strict" can break login flows from external links
    maxAge: 7 * 24 * 60 * 60 * 1000,  // 7-day session lifetime
  },
};

// In production, use PostgreSQL-backed session store for persistence
if (isProd && process.env.DATABASE_URL) {
  try {
    const connectPgSimple = require("connect-pg-simple");
    const PgStore = connectPgSimple(session);
    sessionConfig.store = new PgStore({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,
    });
    console.log("Using PostgreSQL session store");
  } catch (err) {
    console.warn("Failed to initialize PostgreSQL session store, using memory store:", err);
  }
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
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message ?? "Internal server error" });
});

export default app;
