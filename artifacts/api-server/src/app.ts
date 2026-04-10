import path from "path";
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import router from "./routes/index.js";

const app: Express = express();

// ─── Middleware Stack ───────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));    // Allow all origins with credentials (cookie-based auth)
app.use(express.json({ limit: "10mb" }));               // Parse JSON bodies (large limit for Excel data uploads)
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ─── Session Configuration ──────────────────────────────────────────
// Sessions store the authenticated userId. In development, sessions are kept
// in memory. In production, they're persisted to PostgreSQL via connect-pg-simple
// so sessions survive server restarts.
const sessionConfig: session.SessionOptions = {
  secret: process.env.SESSION_SECRET ?? "ssh-commander-secret-key-change-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,      // Replit proxy handles HTTPS termination
    httpOnly: true,     // Prevent client-side JS from reading the session cookie
    sameSite: "lax",    // CSRF protection while allowing normal navigation
    maxAge: 7 * 24 * 60 * 60 * 1000,  // 7-day session lifetime
  },
};

// In production, use PostgreSQL-backed session store for persistence
if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
  try {
    const connectPgSimple = require("connect-pg-simple");
    const PgStore = connectPgSimple(session);
    sessionConfig.store = new PgStore({
      conString: process.env.DATABASE_URL,
      createTableIfMissing: true,  // Auto-creates the "session" table on first run
    });
    console.log("Using PostgreSQL session store");
  } catch (err) {
    console.warn("Failed to initialize PostgreSQL session store, using memory store:", err);
  }
}

app.use(session(sessionConfig));

// ─── API Routes ─────────────────────────────────────────────────────
app.use("/api", router);

// ─── Production Static File Serving ─────────────────────────────────
// In production (Docker), serve the built Vite frontend from the public directory.
// The catch-all route sends index.html for client-side routing (SPA).
if (process.env.NODE_ENV === "production") {
  const publicDir = process.env.PUBLIC_DIR || path.resolve(process.cwd(), "public");
  app.use(express.static(publicDir));
  app.get("/{*splat}", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

// ─── Global Error Handler ───────────────────────────────────────────
// Catches errors thrown by requireAuth/requireAdmin and other route handlers
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message ?? "Internal server error" });
});

export default app;
