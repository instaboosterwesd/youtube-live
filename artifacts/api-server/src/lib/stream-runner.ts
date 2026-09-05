import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { logger } from "./logger";

export type StreamRunnerStatus = "running" | "stopped" | "failed";

export type StreamRunnerInput = {
  streamId: string;
  ingestUrl: string;
  category: string;
  videoSource?: string;
  videoSources?: string[];
  faceCategory?: string;
  faceSource?: string;
  faceSources?: string[];
  playbackSpeed?: number;
  aspectRatio?: "shorts" | "full" | "square";
  facePosition?: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  faceScale?: number;
  durationMinutes?: number;
  autoRestart?: boolean;
};

export type StreamRunnerResult = {
  streamId: string;
  status: StreamRunnerStatus;
  message: string;
  pid: number | null;
};

type StreamProcess = {
  child: ChildProcess | null;
  startedAt: string;
  status: StreamRunnerStatus;
  input: StreamRunnerInput;
  stderrTail?: string;
  lastError?: string;
  durationTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  playlistPaths?: string[];
};

const assetNamesByCategory: Record<string, string> = {
  gta: "ytvid_-M47B7wsm7c_1080p60.mp4",
  "gtv 5 face": "WhatsApp Video 2026-09-04 at 11.30.43 PM.mp4",
  gtv5face: "WhatsApp Video 2026-09-04 at 11.30.43 PM.mp4",
};
const processes = new Map<string, StreamProcess>();

function findAsset(assetName: string): string | null {
  const candidates = [
    path.resolve(process.cwd(), "attached_assets", assetName),
    path.resolve(process.cwd(), "..", "..", "attached_assets", assetName),
    path.resolve(process.cwd(), "..", "attached_assets", assetName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}


function getVideoPath(category: string, explicitSource?: string): string {
  if (explicitSource && path.isAbsolute(explicitSource) && existsSync(explicitSource)) {
    return explicitSource;
  }

  const categoryKey = explicitSource?.startsWith("__asset:")
    ? explicitSource.slice("__asset:".length).trim().toLowerCase()
    : category.trim().toLowerCase();
  const assetName = assetNamesByCategory[categoryKey];
  if (!assetName) {
    throw new Error(
      `The ${category} category is saved in this browser but does not have a server-side video source yet.`,
    );
  }

  const videoPath = findAsset(assetName);
  if (!videoPath) {
    throw new Error(`The ${category} video file is not available on the server.`);
  }
  return videoPath;
}

function getVideoPaths(category: string, explicitSources?: string[], explicitSource?: string): string[] {
  const sources = explicitSources?.length ? explicitSources : explicitSource ? [explicitSource] : [];
  return sources.length
    ? sources.map((source) => getVideoPath(category, source))
    : [getVideoPath(category)];
}

function escapePlaylistPath(filePath: string): string {
  return filePath.replace(/'/g, "'\\''");
}

function prepareInput(paths: string[]): { path: string; playlistPath?: string } {
  if (paths.length === 1) return { path: paths[0] };
  const playlistPath = path.resolve(process.cwd(), `.signal-desk-playlist-${randomUUID()}.txt`);
  writeFileSync(playlistPath, `${paths.map((filePath) => `file '${escapePlaylistPath(filePath)}'`).join("\n")}\n`);
  return { path: playlistPath, playlistPath };
}

function cleanupPlaylists(process: StreamProcess): void {
  process.playlistPaths?.forEach((playlistPath) => unlinkSync(playlistPath));
  process.playlistPaths = undefined;
}

function validateIngestUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Enter a complete live ingest URL.");
  }

  if (!["http:", "https:", "rtmp:", "rtmps:"].includes(url.protocol)) {
    throw new Error("This ingest URL must use HTTP, HTTPS, RTMP, or RTMPS.");
  }
  return url;
}

function setFile(url: URL, filename: string): string {
  const copy = new URL(url.toString());
  const params = [...copy.searchParams.entries()]
    .filter(([key]) => key !== "file")
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  params.push(`file=${encodeURIComponent(filename).replaceAll("%25", "%")}`);
  copy.search = params.join("&");
  return copy.toString();
}

function sanitizeFfmpegError(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const message = lines.slice(-4).join(" ");
  return message
    .replace(/(?:https?|rtmps?):\/\/\S+/gi, "[private ingest URL]")
    .slice(-700);
}

function buildFfmpegArgs(
  input: StreamRunnerInput,
  videoInput: { path: string; playlistPath?: string },
  faceInput?: { path: string; playlistPath?: string },
): string[] {
  const ingestUrl = validateIngestUrl(input.ingestUrl);
  const aspectRatio = input.aspectRatio ?? "full";
  const dimensions = {
    shorts: [1080, 1920],
    full: [1920, 1080],
    square: [1080, 1080],
  }[aspectRatio];
  const [width, height] = dimensions;
  const facePath = faceInput?.path;
  const playbackSpeed = Math.min(2, Math.max(0.5, input.playbackSpeed ?? 1));
  const needsVideoFilter = aspectRatio !== "full" || Boolean(facePath) || playbackSpeed !== 1;

  const inputArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-re",
    "-stream_loop",
    "-1",
    ...(videoInput.playlistPath ? ["-f", "concat", "-safe", "0"] : []),
    "-i",
    videoInput.path,
  ];

  if (faceInput) {
    inputArgs.push(
      "-re",
      "-stream_loop",
      "-1",
      ...(faceInput.playlistPath ? ["-f", "concat", "-safe", "0"] : []),
      "-i",
      faceInput.path,
    );
  }

  const videoArgs = needsVideoFilter
    ? [
        "-filter_complex",
        [
          `[0:v]${playbackSpeed === 1 ? "" : `setpts=PTS/${playbackSpeed},`}scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[base]`,
          ...(facePath
            ? [
                `[1:v]${playbackSpeed === 1 ? "" : `setpts=PTS/${playbackSpeed},`}scale=iw*${Math.min(0.6, Math.max(0.1, input.faceScale ?? 0.25))}:-1[face]`,
                `[base][face]overlay=${
                  input.facePosition === "top-left" || input.facePosition === "bottom-left"
                    ? "24"
                    : input.facePosition === "center"
                      ? "(W-w)/2"
                      : "W-w-24"
                }:${
                  input.facePosition === "top-left" || input.facePosition === "top-right"
                    ? "24"
                    : input.facePosition === "center"
                      ? "(H-h)/2"
                      : "H-h-24"
                }[out]`,
              ]
            : []),
        ].join(";"),
        "-map",
        facePath ? "[out]" : "[base]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-tune",
        "zerolatency",
        "-b:v",
        "8M",
        "-minrate",
        "8M",
        "-maxrate",
        "8M",
        "-bufsize",
        "16M",
        "-profile:v",
        "high",
        "-level",
        "4.2",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "60",
        "-g",
        "120",
        "-keyint_min",
        "120",
        "-sc_threshold",
        "0",
        "-fps_mode",
        "cfr",
      ]
    : ["-map", "0:v:0", "-c:v", "copy"];

  const audioArgs = [
    "-map",
    "0:a:0?",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "44100",
    ...(playbackSpeed === 1 ? [] : ["-af", `atempo=${playbackSpeed}`]),
  ];

  if (ingestUrl.pathname.includes("http_upload_hls")) {
    const playlistUrl = setFile(ingestUrl, "signal_desk.m3u8");
    const segmentUrl = setFile(ingestUrl, "signal_desk_%05d.ts");
    return [
      ...inputArgs,
      ...videoArgs,
      ...audioArgs,
      "-f",
      "hls",
      "-method",
      "PUT",
      "-hls_time",
      "2",
      "-hls_list_size",
      "5",
      "-hls_playlist_type",
      "event",
      "-hls_segment_filename",
      segmentUrl,
      "-http_persistent",
      "1",
      playlistUrl,
    ];
  }

  if (ingestUrl.protocol === "rtmp:" || ingestUrl.protocol === "rtmps:") {
    return [...inputArgs, ...videoArgs, ...audioArgs, "-f", "flv", ingestUrl.toString()];
  }

  throw new Error("This URL is not a supported YouTube HLS or RTMP ingest URL.");
}

function resultFor(streamId: string, process: StreamProcess, message: string): StreamRunnerResult {
  return {
    streamId,
    status: process.status,
    message,
    pid: process.child?.pid ?? null,
  };
}

function launchProcess(process: StreamProcess): void {
  cleanupPlaylists(process);
  const videoPaths = getVideoPaths(process.input.category, process.input.videoSources, process.input.videoSource);
  const facePaths = process.input.faceCategory
    ? getVideoPaths(process.input.faceCategory, process.input.faceSources, process.input.faceSource)
    : [];
  const videoInput = prepareInput(videoPaths);
  const faceInput = facePaths.length ? prepareInput(facePaths) : undefined;
  process.playlistPaths = [videoInput.playlistPath, faceInput?.playlistPath].filter((playlistPath): playlistPath is string => Boolean(playlistPath));
  const child = spawn(ffmpegPath ?? "ffmpeg", buildFfmpegArgs(process.input, videoInput, faceInput), {
    stdio: ["ignore", "ignore", "pipe"],
  });

  process.child = child;
  process.startedAt = new Date().toISOString();
  if (process.input.durationMinutes) {
    process.durationTimer = setTimeout(() => {
      if (process.status === "running") process.child?.kill("SIGTERM");
    }, process.input.durationMinutes * 60 * 1000);
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    // Keep only a short, sanitized tail so status can explain a failed process
    // without exposing the private ingest URL.
    process.stderrTail = `${process.stderrTail ?? ""}${chunk.toString()}`.slice(-4000);
  });
  child.once("error", (error) => {
    process.status = "failed";
    process.lastError = error.message;
    logger.error({ streamId: process.input.streamId, error: error.message }, "FFmpeg process error");
  });
  child.once("exit", (code, signal) => {
    cleanupPlaylists(process);
    if (process.durationTimer) {
      clearTimeout(process.durationTimer);
      process.durationTimer = undefined;
    }
    if (process.status !== "running") return;

    if (process.input.autoRestart && process.input.durationMinutes) {
      logger.info({ streamId: process.input.streamId, code, signal }, "Stream duration reached; restarting FFmpeg");
      process.restartTimer = setTimeout(() => {
        process.restartTimer = undefined;
        try {
          launchProcess(process);
        } catch (error) {
          process.status = "failed";
          logger.error(
            { streamId: process.input.streamId, error: error instanceof Error ? error.message : "unknown error" },
            "FFmpeg restart rejected",
          );
        }
      }, 1500);
      return;
    }

    process.status = code === 0 ? "stopped" : "failed";
    if (process.status === "failed") {
      process.lastError = sanitizeFfmpegError(process.stderrTail ?? "") || `FFmpeg exited with code ${code ?? "unknown"}.`;
    }
    logger.info(
      { streamId: process.input.streamId, code, signal, status: process.status },
      "FFmpeg process exited",
    );
  });
}

export function startStream(input: StreamRunnerInput): StreamRunnerResult {
  const current = processes.get(input.streamId);
  if (current?.status === "running") {
    throw new Error("This channel is already streaming.");
  }

  getVideoPaths(input.category, input.videoSources, input.videoSource);
  if (input.faceCategory) getVideoPaths(input.faceCategory, input.faceSources, input.faceSource);

  const streamProcess: StreamProcess = {
    child: null,
    startedAt: new Date().toISOString(),
    status: "running",
    input,
  };
  processes.set(input.streamId, streamProcess);
  launchProcess(streamProcess);

  return resultFor(input.streamId, streamProcess, "FFmpeg stream process started.");
}

export function stopStream(streamId: string): StreamRunnerResult | null {
  const streamProcess = processes.get(streamId);
  if (!streamProcess) return null;

  streamProcess.status = "stopped";
  if (streamProcess.durationTimer) clearTimeout(streamProcess.durationTimer);
  if (streamProcess.restartTimer) clearTimeout(streamProcess.restartTimer);
  streamProcess.child?.kill("SIGTERM");
  setTimeout(() => {
    if (streamProcess.child && !streamProcess.child.killed) streamProcess.child.kill("SIGKILL");
  }, 5000).unref();
  return resultFor(streamId, streamProcess, "FFmpeg stream process stopped.");
}

export function getStreamStatus(streamId: string): StreamRunnerResult {
  const streamProcess = processes.get(streamId);
  if (!streamProcess) {
    return { streamId, status: "stopped", message: "No stream process is running.", pid: null };
  }
  return resultFor(
    streamId,
    streamProcess,
    streamProcess.status === "running"
      ? "FFmpeg stream process is running."
      : streamProcess.status === "failed"
        ? `FFmpeg failed: ${streamProcess.lastError ?? "The process exited unexpectedly."}`
        : "FFmpeg stream process is stopped.",
  );
}