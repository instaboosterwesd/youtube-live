import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Router, type IRouter } from "express";
import { randomUUID } from "node:crypto";

const router: IRouter = Router();
const mediaDir = path.resolve(process.cwd(), "attached_assets", "live-media");
const maxUploadBytes = 1.5 * 1024 * 1024 * 1024;

function getMediaName(rawName: string): string {
  const base = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, "-");
  const extension = path.extname(base).toLowerCase() || ".mp4";
  return `${randomUUID()}${extension}`;
}

async function findMediaFile(fileId: string): Promise<string | null> {
  if (!/^[a-f0-9-]+$/i.test(fileId)) return null;
  const files = await readdir(mediaDir).catch(() => []);
  const filename = files.find((entry) => entry.startsWith(`${fileId}.`));
  return filename ? path.join(mediaDir, filename) : null;
}

router.post("/media/upload", async (req, res): Promise<void> => {
  const rawName = req.header("x-file-name");
  const contentType = req.header("content-type") || "";
  if (!rawName || (!contentType.startsWith("video/") && contentType !== "application/octet-stream")) {
    res.status(400).json({ error: "Send a video file with an X-File-Name header." });
    return;
  }

  await mkdir(mediaDir, { recursive: true });
  const filename = getMediaName(rawName);
  const destination = path.join(mediaDir, filename);
  let received = 0;
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > maxUploadBytes) req.destroy(new Error("Video upload is larger than 1.5 GB."));
  });

  try {
    await pipeline(req, createWriteStream(destination));
    const fileId = path.parse(filename).name;
    res.status(201).json({
      fileId,
      filename: rawName,
      sourcePath: destination,
      playbackUrl: `/api/media/files/${fileId}`,
    });
  } catch (error) {
    await unlink(destination).catch(() => undefined);
    req.log.warn({ error: error instanceof Error ? error.message : "unknown error" }, "Media upload failed");
    res.status(400).json({ error: "The video upload could not be completed." });
  }
});

router.get("/media/files/:fileId", async (req, res): Promise<void> => {
  const filename = await findMediaFile(req.params.fileId);
  if (!filename) {
    res.status(404).json({ error: "Media file not found." });
    return;
  }

  const fileStats = await stat(filename);
  res.setHeader("Content-Length", fileStats.size);
  res.setHeader("Content-Type", "video/mp4");
  res.sendFile(filename);
});

export default router;