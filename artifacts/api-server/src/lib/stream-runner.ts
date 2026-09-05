import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

export type StreamRunnerStatus = "running" | "stopped" | "failed";

export type StreamRunnerInput = {
  streamId: string;
  ingestUrl: string;
  category: string;
};

export type StreamRunnerResult = {
  streamId: string;
  status: StreamRunnerStatus;
  message: string;
  pid: number | null;
};

type StreamProcess = {
  child: ChildProcess;
  startedAt: string;
  status: StreamRunnerStatus;
};

const assetName = "ytvid_-M47B7wsm7c_1080p60.mp4";
const processes = new Map<string, StreamProcess>();

function findAsset(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "attached_assets", assetName),
    path.resolve(process.cwd(), "..", "..", "attached_assets", assetName),
    path.resolve(process.cwd(), "..", "attached_assets", assetName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function getVideoPath(category: string): string {
  if (category.trim().toLowerCase() !== "gta") {
    throw new Error("Only the GTA category has a server-side video source right now.");
  }

  const videoPath = findAsset();
  if (!videoPath) {
    throw new Error("The GTA video file is not available on the server.");
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

function buildFfmpegArgs(input: StreamRunnerInput, videoPath: string): string[] {
  const ingestUrl = validateIngestUrl(input.ingestUrl);
  const baseArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-re",
    "-stream_loop",
    "-1",
    "-i",
    videoPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
  ];

  if (ingestUrl.pathname.includes("http_upload_hls")) {
    const playlistUrl = setFile(ingestUrl, "signal_desk.m3u8");
    const segmentUrl = setFile(ingestUrl, "signal_desk_%05d.ts");
    return [
      ...baseArgs,
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
    return [...baseArgs, "-f", "flv", ingestUrl.toString()];
  }

  throw new Error("This URL is not a supported YouTube HLS or RTMP ingest URL.");
}

function resultFor(streamId: string, process: StreamProcess, message: string): StreamRunnerResult {
  return {
    streamId,
    status: process.status,
    message,
    pid: process.child.pid ?? null,
  };
}

export function startStream(input: StreamRunnerInput): StreamRunnerResult {
  const current = processes.get(input.streamId);
  if (current?.status === "running") {
    throw new Error("This channel is already streaming.");
  }

  const videoPath = getVideoPath(input.category);
  const child = spawn("ffmpeg", buildFfmpegArgs(input, videoPath), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const streamProcess: StreamProcess = {
    child,
    startedAt: new Date().toISOString(),
    status: "running",
  };
  processes.set(input.streamId, streamProcess);

  child.stderr?.on("data", () => {
    // FFmpeg output can contain the private ingest URL. Keep it out of logs.
  });
  child.once("error", (error) => {
    streamProcess.status = "failed";
    logger.error({ streamId: input.streamId, error: error.message }, "FFmpeg process error");
  });
  child.once("exit", (code, signal) => {
    if (streamProcess.status === "running") {
      streamProcess.status = code === 0 ? "stopped" : "failed";
    }
    logger.info(
      { streamId: input.streamId, code, signal, status: streamProcess.status },
      "FFmpeg process exited",
    );
  });

  return resultFor(input.streamId, streamProcess, "FFmpeg stream process started.");
}

export function stopStream(streamId: string): StreamRunnerResult | null {
  const streamProcess = processes.get(streamId);
  if (!streamProcess) return null;

  streamProcess.status = "stopped";
  streamProcess.child.kill("SIGTERM");
  setTimeout(() => {
    if (!streamProcess.child.killed) {
      streamProcess.child.kill("SIGKILL");
    }
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