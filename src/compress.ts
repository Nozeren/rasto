/**
 * Turns a raw WebM capture into a small, browser-playable MP4.
 *
 * Screen recordings compress extremely well: on a real 4.5 min 2560x1440@60fps capture, preset A gave 87.7 MB -> 3.2 MB.
 * If the result is still above the size limit, it is re-encoded once with the smaller preset B.
 */
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import ffmpegStatic from 'ffmpeg-static';

// In the packaged app the binary is unpacked next to app.asar (see "asarUnpack" in package.json); executables can't run
// from inside the archive.
export const ffmpegPath = ffmpegStatic ? ffmpegStatic.replace('app.asar', 'app.asar.unpacked') : null;

export interface Preset {
  name: string;
  maxWidth: number;
  fps: number;
  crf: number;
}

export const PRESET_A: Preset = { name: 'A', maxWidth: 1600, fps: 10, crf: 28 };
export const PRESET_B: Preset = { name: 'B', maxWidth: 1280, fps: 10, crf: 32 };

export interface CompressResult {
  path: string;
  bytes: number;
  preset: string;
}

/** Progress callback: fraction 0..1 (best effort) and the preset being applied. */
export type ProgressFn = (fraction: number, preset: string) => void;

/** Runs ffmpeg with `args`, reporting progress against `durationSec` (best effort) under `label`. */
export function runFfmpeg(args: string[], durationSec = 0, onProgress?: ProgressFn, label = ''): Promise<void> {
  if (!ffmpegPath) {
    return Promise.reject(new Error('ffmpeg binary not found (ffmpeg-static)'));
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, ['-nostdin', '-y', ...args]);
    let stderr = '';

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-4000);
      const match = /time=(\d+):(\d+):(\d+\.\d+)/.exec(text);
      if (match && durationSec > 0 && onProgress) {
        const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
        onProgress(Math.min(seconds / durationSec, 1), label);
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
      }
    });
  });
}

function encode(input: string, output: string, preset: Preset, durationSec: number, onProgress: ProgressFn): Promise<void> {
  // Width capped at maxWidth and kept even (required by yuv420p), height follows the aspect ratio.
  const filter = `fps=${preset.fps},scale='trunc(min(${preset.maxWidth},iw)/2)*2':-2`;
  return runFfmpeg([
    '-i', input,
    '-an',
    '-vf', filter,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(preset.crf),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ], durationSec, onProgress, preset.name);
}

/**
 * Compresses `input` into `output` with preset A, falling back to preset B when the file exceeds `maxBytes`.
 * The raw input is left in place; the caller deletes it once the result is saved.
 */
export async function compress(
  input: string,
  output: string,
  durationSec: number,
  maxBytes: number,
  onProgress: ProgressFn,
): Promise<CompressResult> {
  await encode(input, output, PRESET_A, durationSec, onProgress);
  let { size } = await fs.stat(output);

  if (size <= maxBytes) {
    return { path: output, bytes: size, preset: PRESET_A.name };
  }

  await encode(input, output, PRESET_B, durationSec, onProgress);
  ({ size } = await fs.stat(output));
  return { path: output, bytes: size, preset: PRESET_B.name };
}
