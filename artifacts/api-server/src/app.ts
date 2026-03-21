import path from "path";
import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import router from "./routes/index.js";

const app: Express = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const sessionConfig: session.SessionOptions = {
  secret: process.env.SESSION_SECRET ?? "mikro-manager-secret-key-change-in-prod",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
};

if (process.env.NODE_ENV === "production" && process.env.DATABASE_URL) {
  const PgStore = connectPgSimple(session);
  sessionConfig.store = new PgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: true,
  });
}

app.use(session(sessionConfig));

app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  const publicDir = process.env.PUBLIC_DIR || path.resolve(process.cwd(), "public");
  app.use(express.static(publicDir));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message ?? "Internal server error" });
});

export default app;
