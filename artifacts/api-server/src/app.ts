import path from "path";
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import rateLimit from "express-rate-limit";
import router from "./routes/index.js";

const app: Express = express();

const isProd = process.env.NODE_ENV === "production";

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
