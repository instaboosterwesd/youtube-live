import { Router, type IRouter } from "express";
import healthRouter from "./health";
import streamingRouter from "./streaming";

const router: IRouter = Router();

router.use(healthRouter);
router.use(streamingRouter);

export default router;
