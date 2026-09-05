import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router, type IRouter, type Request } from "express";
import { createHmac, randomUUID } from "node:crypto";
import os from "node:os";
import { DownloadYoutubeVideoBody, DownloadYoutubeVideoResponse } from "@workspace/api-zod";
import youtubeDl, { create as createYoutubeDl } from "youtube-dl-exec";
import ffmpegPath from "ffmpeg-static";
import { authorizeLicenseSession } from "./licenses";

const router: IRouter = Router();
const mediaDir = path.resolve(process.cwd(), "attached_assets", "live-media");
const importedYoutubeCookiesPath = path.join(mediaDir, "youtube-cookies.txt");
const maxUploadBytes = 1.5 * 1024 * 1024 * 1024;
const maxYoutubeDownloadBytes = 1.5 * 1024 * 1024 * 1024;
const ytSaveBaseUrl = "https://ytsave.to";
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

function getCookieHeader(response: Response): string {
  const header = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = header.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  const sessionCookie = setCookies
    .flatMap((value) => value.split(/,(?=[A-Za-z0-9_]+=)/))
    .map((value) => value.trim().split(";")[0])
    .find((value) => value.startsWith("PHPSESSID="));

  if (!sessionCookie) {
    throw new Error("The YouTube download provider did not create a session.");
  }
  return sessionCookie;
}

function getYtSaveSizeInBytes(rawSize: unknown): number | undefined {
  if (typeof rawSize !== "string") return undefined;
  const match = rawSize.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  }[unit];
  return Number.isFinite(value) && multiplier ? value * multiplier : undefined;
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

type YtSaveMediaItem = {
  type?: unknown;
  mediaUrl?: unknown;
  mediaFileSize?: unknown;
  mediaDuration?: unknown;
  mediaExtension?: unknown;
};

type YtSaveResponse = {
  api?: {
    status?: unknown;
    message?: unknown;
    title?: unknown;
    mediaItems?: unknown;
  } | null;
  message?: unknown;
};

async function downloadWithYtSave(url: string, fileId: string): Promise<{ path: string; title: string; duration: string }> {
  const requestHeaders = {
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36",
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
  };
  const pageResponse = await fetch(`${ytSaveBaseUrl}/en2/`, {
    headers: requestHeaders,
    signal: AbortSignal.timeout(45_000),
  });
  if (!pageResponse.ok) throw new Error(`YTSave setup failed with HTTP ${pageResponse.status}.`);

  const pageHtml = await pageResponse.text();
  const cookie = getCookieHeader(pageResponse);
  const challenge = pageHtml.match(/data-ch=["']([^"']+)["']/i)?.[1];
  if (!challenge) throw new Error("YTSave did not provide a session challenge.");

  const answer = createHmac("sha256", "bf735103af6bb295633270b05a7b0a42")
    .update(challenge)
    .digest("hex")
    .slice(0, 32);
  const providerHeaders = {
    ...requestHeaders,
    cookie,
    referer: `${ytSaveBaseUrl}/en2/`,
    origin: ytSaveBaseUrl,
    "x-requested-with": "XMLHttpRequest",
    "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
  };
  const mintResponse = await fetch(`${ytSaveBaseUrl}/mint.php`, {
    method: "POST",
    headers: providerHeaders,
    body: new URLSearchParams({ ch: challenge, answer }),
    signal: AbortSignal.timeout(30_000),
  });
  const mintBody = await mintResponse.text();
  let mintData: { dt?: unknown; message?: unknown; needTurnstile?: unknown } = {};
  try {
    mintData = JSON.parse(mintBody) as typeof mintData;
  } catch {
    throw new Error("YTSave returned an invalid session response.");
  }
  if (!mintResponse.ok || typeof mintData.dt !== "string" || !mintData.dt) {
    throw new Error(
      mintData.needTurnstile
        ? "YTSave requires browser verification for this request."
        : typeof mintData.message === "string"
          ? mintData.message
          : `YTSave session setup failed with HTTP ${mintResponse.status}.`,
    );
  }

  const detailsResponse = await fetch(`${ytSaveBaseUrl}/proxy.php`, {
    method: "POST",
    headers: {
      ...providerHeaders,
      accept: "application/json, text/javascript, */*; q=0.01",
    },
    body: new URLSearchParams({ url, dt: mintData.dt }),
    signal: AbortSignal.timeout(90_000),
  });
  let details: YtSaveResponse;
  try {
    details = JSON.parse(await detailsResponse.text()) as YtSaveResponse;
  } catch {
    throw new Error("YTSave returned an invalid video response.");
  }
  const api = details.api;
  if (!detailsResponse.ok || api?.status !== "ok") {
    throw new Error(
      typeof api?.message === "string"
        ? api.message
        : typeof details.message === "string"
          ? details.message
          : `YTSave could not process the video (HTTP ${detailsResponse.status}).`,
    );
  }

  const videos = Array.isArray(api.mediaItems)
    ? api.mediaItems.filter((item): item is YtSaveMediaItem => (
      Boolean(item) &&
      typeof item === "object" &&
      (item as YtSaveMediaItem).type === "Video" &&
      typeof (item as YtSaveMediaItem).mediaUrl === "string"
    ))
    : [];
  if (videos.length === 0) throw new Error("YTSave did not return an MP4 video.");

  const selected = videos.find((item) => {
    const size = getYtSaveSizeInBytes(item.mediaFileSize);
    return size === undefined || size <= maxYoutubeDownloadBytes;
  }) ?? videos.at(-1);
  if (!selected || typeof selected.mediaUrl !== "string") {
    throw new Error("YTSave did not return a usable video link.");
  }
  const selectedSize = getYtSaveSizeInBytes(selected.mediaFileSize);
  if (selectedSize && selectedSize > maxYoutubeDownloadBytes) {
    throw new Error("The best YTSave video is larger than the server storage limit.");
  }

  await mkdir(mediaDir, { recursive: true });
  const outputPath = path.join(mediaDir, `${fileId}.mp4`);
  const tempPath = `${outputPath}.part`;
  await unlink(tempPath).catch(() => undefined);
  try {
    const videoResponse = await fetch(selected.mediaUrl, {
      headers: { "user-agent": requestHeaders["user-agent"], referer: `${ytSaveBaseUrl}/en2/` },
      signal: AbortSignal.timeout(20 * 60_000),
    });
    if (!videoResponse.ok || !videoResponse.body) {
      throw new Error(`YTSave video fetch failed with HTTP ${videoResponse.status}.`);
    }
    const contentLength = Number(videoResponse.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxYoutubeDownloadBytes) {
      throw new Error("The YTSave video is larger than the server storage limit.");
    }
    await pipeline(
      Readable.fromWeb(videoResponse.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(tempPath, { mode: 0o600 }),
    );
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  return {
    path: outputPath,
    title: typeof api.title === "string" && api.title.trim() ? api.title.trim() : "Downloaded YouTube video",
    duration: typeof selected.mediaDuration === "string" && selected.mediaDuration.trim()
      ? selected.mediaDuration.trim()
      : "00:00",
  };
}

async function downloadWithYtDlp(url: string, fileId: string): Promise<{ path: string; title: string; duration: string }> {
  await mkdir(mediaDir, { recursive: true });
  const outputTemplate = path.join(mediaDir, `${fileId}.%(ext)s`);
  const cookiesFile = await resolveYoutubeCookiesFile();
  const downloadWithFormat = (format: string) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const flags = ({
      noPlaylist: true,
      noWarnings: true,
      noProgress: true,
      socketTimeout: 30,
      extractorArgs: "youtube:player_client=android",
      format,
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
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

  let attempt = await downloadWithFormat("bestvideo*+bestaudio/best");
  if (attempt.code !== 0 && /Requested format is not available/i.test(attempt.stderr)) {
    attempt = await downloadWithFormat("18/best[ext=mp4]/best");
  }
  if (attempt.code !== 0) {
    throw new Error(attempt.stderr.trim().split("\n").filter(Boolean).at(-1) || "YouTube download failed.");
  }

  const info = attempt.stdout.split(/\r?\n/).map((line) => {
    try { return JSON.parse(line) as { title?: unknown; duration?: unknown }; } catch { return null; }
  }).find(Boolean);
  const files = await readdir(mediaDir).catch(() => []);
  const filename = files.find((entry) => entry.startsWith(`${fileId}.`) && !entry.endsWith(".part"));
  if (!filename) throw new Error("YouTube download finished without creating a video file.");
  return {
    path: path.join(mediaDir, filename),
    title: typeof info?.title === "string" && info.title.trim() ? info.title.trim() : "Downloaded YouTube video",
    duration: formatDuration(info?.duration),
  };
}

async function downloadYoutubeVideo(url: string, fileId: string): Promise<{ path: string; title: string; duration: string }> {
  try {
    return await downloadWithYtSave(url, fileId);
  } catch (ytSaveError) {
    await Promise.all(
      (await readdir(mediaDir).catch(() => []))
        .filter((entry) => entry.startsWith(`${fileId}.`))
        .map((entry) => unlink(path.join(mediaDir, entry)).catch(() => undefined)),
    );

    try {
      return await downloadWithYtDlp(url, fileId);
    } catch (ytDlpError) {
      const ytSaveMessage = ytSaveError instanceof Error ? ytSaveError.message : "YTSave failed.";
      const ytDlpMessage = ytDlpError instanceof Error ? ytDlpError.message : "yt-dlp failed.";
      throw new Error(`YTSave: ${ytSaveMessage} | fallback: ${ytDlpMessage}`);
    }
  }
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