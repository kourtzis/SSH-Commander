// Central route aggregator — mounts all API route modules under /api
import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import usersRouter from "./users.js";
import routersRouter from "./routers.js";
import groupsRouter from "./groups.js";
import snippetsRouter from "./snippets.js";
import jobsRouter from "./jobs.js";
import schedulesRouter from "./schedules.js";
import credentialsRouter from "./credentials.js";
import savedViewsRouter from "./saved_views.js";
import routerTerminalRouter from "./router-terminal.js";

const router: IRouter = Router();

router.use(healthRouter);     // GET /api/health
router.use(authRouter);       // POST /api/auth/login, /logout, GET /api/auth/me
router.use(usersRouter);      // CRUD /api/users (admin only)
router.use(routersRouter);    // CRUD /api/routers + import + reachability
router.use(groupsRouter);     // CRUD /api/groups + member management
router.use(snippetsRouter);   // CRUD /api/snippets (with tag filtering)
router.use(jobsRouter);       // CRUD /api/jobs + execution + SSE live stream
router.use(schedulesRouter);  // CRUD /api/schedules + /schedules/calendar
router.use(credentialsRouter); // CRUD /api/credentials (admin writes)
router.use(savedViewsRouter);  // CRUD /api/saved-views (per-user)
router.use(routerTerminalRouter); // SSE /api/routers/:id/terminal

export default router;
