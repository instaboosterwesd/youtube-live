import { Router, type IRouter } from "express";
import {
  GetStreamStatusParams,
  GetStreamStatusResponse,
  StartStreamBody,
  StartStreamResponse,
  StopStreamBody,
  StopStreamResponse,
} from "@workspace/api-zod";
import {
  getStreamStatus,
  startStream,
  stopStream,
} from "../lib/stream-runner";

const router: IRouter = Router();

router.post("/stream/start", (req, res): void => {
  const parsed = StartStreamBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid stream start request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const result = startStream({
      streamId: parsed.data.streamId,
      ingestUrl: parsed.data.ingestUrl,
      category: parsed.data.category,
      videoSource: parsed.data.videoSource,
      videoSources: parsed.data.videoSources,
      faceCategory: parsed.data.faceCategory,
      faceSource: parsed.data.faceSource,
      faceSources: parsed.data.faceSources,
      aspectRatio: parsed.data.aspectRatio,
      facePosition: parsed.data.facePosition,
      faceScale: parsed.data.faceScale,
      durationMinutes: parsed.data.durationMinutes,
      autoRestart: parsed.data.autoRestart,
    });
    res.status(202).json(StartStreamResponse.parse(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start stream.";
    const status = message.includes("already streaming") ? 409 : 400;
    req.log.warn({ streamId: parsed.data.streamId, status }, "Stream start rejected");
    res.status(status).json({ error: message });
  }
});

router.post("/stream/stop", (req, res): void => {
  const parsed = StopStreamBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid stream stop request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const result = stopStream(parsed.data.streamId);
  if (!result) {
    res.status(404).json({ error: "This channel is not currently streaming." });
    return;
  }
  res.json(StopStreamResponse.parse(result));
});

router.get("/stream/status/:streamId", (req, res): void => {
  const parsed = GetStreamStatusParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  res.json(GetStreamStatusResponse.parse(getStreamStatus(parsed.data.streamId)));
});

export default router;