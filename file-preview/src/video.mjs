import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function probeVideo(file) {
  const result = spawnSync("ffprobe", [
    "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "v:0",
    "-show_entries", "stream=width,height,sample_aspect_ratio,avg_frame_rate,codec_name,duration:stream_side_data=rotation:format=duration,format_name",
    "-of", "json", file,
  ], { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 });
  if (result.error?.code === "ENOENT") throw new Error("MP4 preview requires ffmpeg and ffprobe on the viewer host");
  if (result.error || result.status !== 0) throw new Error(`Could not inspect MP4: ${result.error?.message || result.stderr.trim()}`);
  const { streams, format } = JSON.parse(result.stdout);
  const stream = streams?.[0];
  if (!format?.format_name?.split(",").includes("mp4") || !stream) throw new Error("MP4 must contain a playable video stream");
  const duration = Number(stream.duration || format.duration);
  const [numerator, denominator] = (stream.avg_frame_rate || "0/1").split("/").map(Number);
  const fps = numerator / denominator;
  const [sarNumerator, sarDenominator] = (stream.sample_aspect_ratio && stream.sample_aspect_ratio !== "N/A" ? stream.sample_aspect_ratio : "1:1").split(":").map(Number);
  const displayWidth = Math.round(stream.width * sarNumerator / sarDenominator);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0 || fps > 1000 ||
      !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width <= 0 || stream.height <= 0 ||
      stream.width > 8192 || stream.height > 8192 || stream.width * stream.height > 20_000_000 ||
      !Number.isFinite(displayWidth) || displayWidth < 1 || displayWidth > 8192 || displayWidth * stream.height > 20_000_000) {
    throw new Error("MP4 has unsupported duration, frame rate, or dimensions (maximum 8192 per side and 20 million pixels)");
  }
  const rotated = Math.abs(Number(stream.side_data_list?.find((item) => item.rotation !== undefined)?.rotation) || 0) % 180 === 90;
  return { width: rotated ? stream.height : displayWidth, height: rotated ? displayWidth : stream.height, duration, fps, codec: stream.codec_name };
}

// FFmpeg's image2pipe has no outer framing. Parse complete PNG chunks, never
// scan compressed pixels for an IEND marker. Retain at most one bounded frame.
export async function* pngFrames(chunks) {
  let buffer = Buffer.alloc(0);
  let offset = 8;
  for await (const chunk of chunks) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("Invalid PNG from video decoder");
      if (buffer.length < offset + 8) break;
      const length = buffer.readUInt32BE(offset);
      const end = offset + length + 12;
      if (end > MAX_FRAME_BYTES) throw new Error("Decoded video frame is too large");
      if (buffer.length < end) break;
      const last = buffer.toString("ascii", offset + 4, offset + 8) === "IEND";
      offset = end;
      if (last) {
        yield Buffer.from(buffer.subarray(0, end));
        buffer = buffer.subarray(end);
        offset = 8;
      }
    }
    if (buffer.length > MAX_FRAME_BYTES) throw new Error("Decoded video frame is too large");
  }
  if (buffer.length) throw new Error("Truncated video frame");
}

// Decoder owns its process and only the latest frame. Rendering can be slower
// than decoding without building an unbounded queue of frames.
export class VideoDecoder {
  constructor(file, video) {
    this.file = file;
    this.video = video;
    this.position = 0;
    this.playing = false;
    this.revision = 0;
  }

  async stop() {
    const child = this.child;
    this.child = undefined;
    this.playing = false;
    if (child) {
      this.abort.abort();
      child.kill("SIGKILL");
      await this.finished;
    }
  }

  async start(position, playing, bounds) {
    await this.stop();
    this.error = "";
    const end = Math.max(0, this.video.duration - 1 / this.video.fps);
    // Keep the logical end position for replay even when decoding its last
    // still frame after a resize or a trip through the gallery.
    this.position = Math.max(0, Math.min(this.video.duration, position));
    this.playing = playing;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const fps = Math.min(15, this.video.fps);
    const width = Math.max(1, Math.min(1280, Math.floor(bounds.width)));
    const height = Math.max(1, Math.min(720, Math.floor(bounds.height)));
    const child = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
      "-protocol_whitelist", "file,pipe", "-ss", String(Math.min(end, this.position)),
      "-i", this.file, "-map", "0:v:0", "-an", "-sn", "-dn",
      "-vf", `scale=w='max(1,trunc(min(${width},${height}*dar)))':h='max(1,trunc(min(${height},${width}/dar)))',setsar=1${playing ? `,fps=${fps}` : ""}`,
      ...(!playing ? ["-frames:v", "1"] : []),
      "-threads", "1", "-c:v", "png", "-pix_fmt", "rgb24", "-f", "image2pipe", "pipe:1",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const start = this.position;
    let stderr = "";
    const watchdog = setTimeout(() => {
      stderr = "Video decoder timed out waiting for a frame";
      this.abort.abort();
      child.kill("SIGKILL");
    }, 10_000);
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const exited = new Promise((resolve) => {
      child.once("error", (error) => { stderr = error.code === "ENOENT" ? "MP4 preview requires ffmpeg on the viewer host" : error.message; });
      child.once("close", (code) => resolve(code));
    });
    this.finished = (async () => {
      let count = 0;
      let clock;
      try {
        for await (const data of pngFrames(child.stdout)) {
          if (this.child !== child) break;
          watchdog.refresh();
          clock ??= performance.now();
          if (playing) {
            const wait = clock + count * 1000 / fps - performance.now();
            if (wait > 0) await delay(wait, undefined, { signal });
          }
          this.frame = data;
          this.position = playing ? Math.min(end, start + count / fps) : start;
          count++;
          this.revision++;
        }
        if (playing && count) {
          const wait = clock + Math.min(count / fps, this.video.duration - start) * 1000 - performance.now();
          if (wait > 0) await delay(wait, undefined, { signal });
        }
      } catch (error) {
        stderr ||= error.message;
        child.kill("SIGKILL");
      }
      const code = await exited;
      clearTimeout(watchdog);
      if (this.child !== child) return;
      this.child = undefined;
      this.playing = false;
      if (code !== 0 || !count) this.error = stderr || "MP4 produced no video frames";
      else if (playing) this.position = this.video.duration;
      this.revision++;
    })();
    // Still frames finish before returning; continuous playback stays live.
    if (!playing) await this.finished;
  }
}

export function videoTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
