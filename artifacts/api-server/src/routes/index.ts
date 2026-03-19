import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import usersRouter from "./users.js";
import routersRouter from "./routers.js";
import groupsRouter from "./groups.js";
import snippetsRouter from "./snippets.js";
import jobsRouter from "./jobs.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(routersRouter);
router.use(groupsRouter);
router.use(snippetsRouter);
router.use(jobsRouter);

export default router;
