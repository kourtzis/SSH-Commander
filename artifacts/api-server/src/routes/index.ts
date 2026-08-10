// Central route aggregator — mounts all API route modules under /api
import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import usersRouter from "./users.js";
import routersRouter from "./routers.js";
import groupsRouter from "./groups.js";
import snippetsRouter from "./snippets.js";
import jobAnalyticsRouter from "./job-analytics.js";
import jobsRouter from "./jobs.js";
import schedulesRouter from "./schedules.js";
import credentialsRouter from "./credentials.js";
import savedViewsRouter from "./saved_views.js";
import routerTerminalRouter from "./router-terminal.js";
import backupsRouter from "./backups.js";
import goldenRouter from "./golden.js";
import upgradesRouter from "./upgrades.js";
import alertsRouter from "./alerts.js";
import auditRouter from "./audit.js";
import tokensRouter from "./tokens.js";

const router: IRouter = Router();

router.use(healthRouter);     // GET /api/health
router.use(authRouter);       // POST /api/auth/login, /logout, /totp/*, GET /api/auth/me
router.use(usersRouter);      // CRUD /api/users (admin only) + reset-totp
router.use(routersRouter);    // CRUD /api/routers + import + reachability
router.use(groupsRouter);     // CRUD /api/groups + member management
router.use(snippetsRouter);   // CRUD /api/snippets (with tag filtering)
// jobAnalyticsRouter MUST mount before jobsRouter: /jobs/output-search would
// otherwise be captured by the /jobs/:id parameter route.
router.use(jobAnalyticsRouter); // GET /api/jobs/output-search + /api/jobs/:id/output-groups
router.use(jobsRouter);       // CRUD /api/jobs + execution + SSE live stream
router.use(schedulesRouter);  // CRUD /api/schedules + /schedules/calendar
router.use(credentialsRouter); // CRUD /api/credentials (admin writes)
router.use(savedViewsRouter);  // CRUD /api/saved-views (per-user)
router.use(routerTerminalRouter); // SSE /api/routers/:id/terminal
router.use(backupsRouter);    // /api/backups + run/diff/settings
router.use(goldenRouter);     // /api/golden-configs + drift checks
router.use(upgradesRouter);   // /api/upgrades + overview/cancel
router.use(alertsRouter);     // /api/alert-channels|rules|events
router.use(auditRouter);      // /api/audit (admin)
router.use(tokensRouter);     // /api/tokens

export default router;
