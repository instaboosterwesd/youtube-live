import { Router, type IRouter } from "express";
import healthRouter from "./health";
import streamingRouter from "./streaming";
import mediaRouter from "./media";

const router: IRouter = Router();

router.use(healthRouter);
router.use(streamingRouter);
router.use(mediaRouter);

export default router;
