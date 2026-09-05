import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Router, type IRouter, type Request } from "express";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { DownloadYoutubeVideoBody, DownloadYoutubeVideoResponse } from "@workspace/api-zod";
import youtubeDl, { create as createYoutubeDl } from "youtube-dl-exec";
import ffmpegPath from "ffmpeg-static";
import { authorizeLicenseSession } from "./licenses";

const router: IRouter = Router();
const mediaDir = path.resolve(process.cwd(), "attached_assets", "live-media");
const importedYoutubeCookiesPath = path.join(mediaDir, "youtube-cookies.txt");
const maxUploadBytes = 1.5 * 1024 * 1024 * 1024;
const youtubeDownloader = process.env.YT_DLP_BIN?.trim()
  ? createYoutubeDl(process.env.YT_DLP_BIN.trim())
  : youtubeDl;
let youtubeCookiesFilePromise: Promise<string | undefined> | undefined;
let importedYoutubeCookiesFile = existsSync(importedYoutubeCookiesPath) ? importedYoutubeCookiesPath : undefined;

async function resolveYoutubeCookiesFile(): Promise<string | undefined> {
  if (importedYoutubeCookiesFile) return importedYoutubeCookiesFile;
  const configuredFile = process.env.YOUTUBE_COOKIES_FILE?.trim();
  if (configuredFile) return configuredFile;

  const encodedCookies = process.env.YOUTUBE_COOKIES_B64?.trim();
  if (!encodedCookies) return undefined;

  if (!youtubeCookiesFilePromise) {
    youtubeCookiesFilePromise = (async () => {
      const cookiesFile = path.join(os.tmpdir(), "youtube-cookies.txt");
      await writeFile(cookiesFile, Buffer.from(encodedCookies, "base64"), { mode: 0o600 });
      return cookiesFile;
    })().catch((error) => {
      youtubeCookiesFilePromise = undefined;
      throw error;
    });
  }

  return youtubeCookiesFilePromise;
}

async function authorizeMediaSettings(req: Request): Promise<boolean> {
  return authorizeLicenseSession(req.header("x-license-key"), req.header("x-client-id"));
}

function normalizeYoutubeCookies(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("The cookie file is empty.");
  if (!trimmed.startsWith("[")) return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("The browser cookie JSON could not be parsed.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("The browser cookie JSON does not contain any cookies.");
  }

  const lines = parsed.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The browser cookie JSON contains an invalid cookie.");
    }
    const cookie = entry as Record<string, unknown>;
    const domain = typeof cookie.domain === "string" ? cookie.domain.trim() : "";
    const name = typeof cookie.name === "string" ? cookie.name : "";
    const value = typeof cookie.value === "string" ? cookie.value : "";
    const cookiePath = typeof cookie.path === "string" && cookie.path ? cookie.path : "/";
    const expirationDate = Number(cookie.expirationDate);
    if (!domain || !name || !Number.isFinite(expirationDate)) {
      throw new Error("The browser cookie JSON is missing required fields.");
    }
    if ([domain, name, value, cookiePath].some((part) => /[\r\n\t]/.test(part))) {
      throw new Error("The browser cookie JSON contains unsupported characters.");
    }
    return [
      domain,
      domain.startsWith(".") ? "TRUE" : "FALSE",
      cookiePath,
      cookie.secure ? "TRUE" : "FALSE",
      Math.max(0, Math.floor(expirationDate)),
      name,
      value,
    ].join("\t");
  });
  return `# Netscape HTTP Cookie File\n${lines.join("\n")}\n`;
}

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

function formatDuration(seconds: unknown): string {
  const totalSeconds = typeof seconds === "number" && Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function validateYoutubeUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Enter a complete YouTube video URL.");
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!["youtube.com", "m.youtube.com", "youtu.be", "youtube-nocookie.com"].includes(hostname)) {
    throw new Error("Only YouTube video links are supported.");
  }
  return parsed.toString();
}

async function downloadYoutubeVideo(url: string, fileId: string): Promise<{ path: string; title: string; duration: string }> {
  await mkdir(mediaDir, { recursive: true });
  const outputTemplate = path.join(mediaDir, `${fileId}.%(ext)s`);
  const cookiesFile = await resolveYoutubeCookiesFile();
  return new Promise((resolve, reject) => {
    const flags = ({
      noPlaylist: true,
      noWarnings: true,
      noProgress: true,
      socketTimeout: 30,
      extractorArgs: "youtube:player_client=android",
      format: "bestvideo*+bestaudio/best",
      mergeOutputFormat: "mp4",
      ffmpegLocation: ffmpegPath ?? undefined,
      cookies: cookiesFile,
      output: outputTemplate,
      printJson: true,
    } as unknown) as Parameters<typeof youtubeDownloader.exec>[1];
    const child = youtubeDownloader.exec(url, flags);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim().split("\n").filter(Boolean).at(-1) || "YouTube download failed."));
        return;
      }

      const info = stdout.split(/\r?\n/).map((line) => {
        try { return JSON.parse(line) as { title?: unknown; duration?: unknown }; } catch { return null; }
      }).find(Boolean);
      const files = await readdir(mediaDir).catch(() => []);
      const filename = files.find((entry) => entry.startsWith(`${fileId}.`) && !entry.endsWith(".part"));
      if (!filename) {
        reject(new Error("YouTube download finished without creating a video file."));
        return;
      }
      resolve({
        path: path.join(mediaDir, filename),
        title: typeof info?.title === "string" && info.title.trim() ? info.title.trim() : "Downloaded YouTube video",
        duration: formatDuration(info?.duration),
      });
    });
  });
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

router.get("/media/youtube-cookies", async (req, res): Promise<void> => {
  if (!(await authorizeMediaSettings(req))) {
    res.status(401).json({ error: "A valid licensed workspace is required." });
    return;
  }
  res.json({
    configured: Boolean(importedYoutubeCookiesFile || process.env.YOUTUBE_COOKIES_FILE?.trim() || process.env.YOUTUBE_COOKIES_B64?.trim()),
  });
});

router.post("/media/youtube-cookies", async (req, res): Promise<void> => {
  if (!(await authorizeMediaSettings(req))) {
    res.status(401).json({ error: "A valid licensed workspace is required." });
    return;
  }

  const contentType = req.header("content-type") || "";
  if (!contentType.startsWith("text/plain") && !contentType.startsWith("application/json")) {
    res.status(400).json({ error: "Upload a cookies.txt or browser JSON cookie export." });
    return;
  }

  await mkdir(mediaDir, { recursive: true });
  const tempPath = path.join(mediaDir, `.youtube-cookies-${randomUUID()}.tmp`);
  let received = 0;
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > 5 * 1024 * 1024) req.destroy(new Error("Cookie file is larger than 5 MB."));
  });

  try {
    await pipeline(req, createWriteStream(tempPath, { mode: 0o600 }));
    const normalizedCookies = normalizeYoutubeCookies(await readFile(tempPath, "utf8"));
    await writeFile(tempPath, normalizedCookies, { mode: 0o600 });
    await rename(tempPath, importedYoutubeCookiesPath);
    importedYoutubeCookiesFile = importedYoutubeCookiesPath;
    youtubeCookiesFilePromise = undefined;
    res.json({ configured: true });
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    const message = error instanceof Error ? error.message : "The YouTube cookie file could not be imported.";
    req.log.warn({ error: message }, "YouTube cookie import failed");
    res.status(400).json({ error: message });
  }
});

router.delete("/media/youtube-cookies", async (req, res): Promise<void> => {
  if (!(await authorizeMediaSettings(req))) {
    res.status(401).json({ error: "A valid licensed workspace is required." });
    return;
  }
  await unlink(importedYoutubeCookiesPath).catch(() => undefined);
  importedYoutubeCookiesFile = undefined;
  youtubeCookiesFilePromise = undefined;
  res.json({ configured: false });
});

router.post("/media/youtube-download", async (req, res): Promise<void> => {
  try {
    const parsed = DownloadYoutubeVideoBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const url = validateYoutubeUrl(parsed.data.url.trim());
    const fileId = randomUUID();
    const result = await downloadYoutubeVideo(url, fileId);
    res.status(201).json(DownloadYoutubeVideoResponse.parse({
      fileId,
      filename: path.basename(result.path),
      sourcePath: result.path,
      playbackUrl: `/api/media/files/${fileId}`,
      title: result.title,
      duration: result.duration,
    }));
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "The YouTube video could not be downloaded.";
    const errorCode = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    const missingDownloader = errorCode === "ENOENT" || rawMessage.includes("spawn yt-dlp ENOENT");
    const requiresYoutubeCookies = /sign in to confirm|not a bot|use --cookies|please sign in/i.test(rawMessage);
    const message = missingDownloader
      ? "The bundled YouTube downloader is unavailable. Redeploy the latest build and try again."
      : requiresYoutubeCookies
        ? "YouTube requires authentication for this server. Configure YOUTUBE_COOKIES_FILE or the YOUTUBE_COOKIES_B64 secret in Railway, then redeploy."
      : rawMessage;
    req.log.warn({ error: message }, "YouTube download failed");
    res.status(missingDownloader || requiresYoutubeCookies ? 503 : 400).json({ error: message });
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