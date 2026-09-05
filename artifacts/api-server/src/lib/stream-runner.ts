import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

export type StreamRunnerStatus = "running" | "stopped" | "failed";

export type StreamRunnerInput = {
  streamId: string;
  ingestUrl: string;
  category: string;
  videoSource?: string;
  faceCategory?: string;
  faceSource?: string;
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
  durationTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
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

  const categoryKey = category.trim().toLowerCase();
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
  copy.searchParams.set("file", filename);
  return copy.toString();
}

function buildFfmpegArgs(input: StreamRunnerInput, videoPath: string, facePath?: string): string[] {
  const ingestUrl = validateIngestUrl(input.ingestUrl);
  const aspectRatio = input.aspectRatio ?? "full";
  const dimensions = {
    shorts: [720, 1280],
    full: [1280, 720],
    square: [1080, 1080],
  }[aspectRatio];
  const [width, height] = dimensions;
  const needsVideoFilter = aspectRatio !== "full" || Boolean(facePath);

  const inputArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-re",
    "-stream_loop",
    "-1",
    "-i",
    videoPath,
  ];

  if (facePath) {
    inputArgs.push("-re", "-stream_loop", "-1", "-i", facePath);
  }

  const videoArgs = needsVideoFilter
    ? [
        "-filter_complex",
        [
          `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[base]`,
          ...(facePath
            ? [
                `[1:v]scale=iw*${Math.min(0.6, Math.max(0.1, input.faceScale ?? 0.25))}:-1[face]`,
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
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-g",
        "60",
      ]
    : ["-map", "0:v:0", "-c:v", "copy"];

  const audioArgs = ["-map", "0:a:0?", "-c:a", "aac", "-b:a", "128k", "-ar", "44100"];

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
  const videoPath = getVideoPath(process.input.category, process.input.videoSource);
  const facePath = process.input.faceCategory
    ? getVideoPath(process.input.faceCategory, process.input.faceSource)
    : undefined;
  const child = spawn("ffmpeg", buildFfmpegArgs(process.input, videoPath, facePath), {
    stdio: ["ignore", "ignore", "pipe"],
  });

  process.child = child;
  process.startedAt = new Date().toISOString();
  if (process.input.durationMinutes) {
    process.durationTimer = setTimeout(() => {
      if (process.status === "running") process.child?.kill("SIGTERM");
    }, process.input.durationMinutes * 60 * 1000);
  }

  child.stderr?.on("data", () => {
    // FFmpeg output can contain the private ingest URL. Keep it out of logs.
  });
  child.once("error", (error) => {
    process.status = "failed";
    logger.error({ streamId: process.input.streamId, error: error.message }, "FFmpeg process error");
  });
  child.once("exit", (code, signal) => {
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

  getVideoPath(input.category, input.videoSource);
  if (input.faceCategory) getVideoPath(input.faceCategory, input.faceSource);

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
    streamProcess.status === "running" ? "FFmpeg stream process is running." : "FFmpeg stream process is no longer running.",
  );
}