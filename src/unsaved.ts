/**
 * Recordings in progress live on disk, not in memory: the capture is appended to <userData>/unsaved/<id>.webm as it
 * comes (a chunk a second), next to <id>.json with the latest step log and where it is to be saved. A long recording
 * then costs no memory, and if Rasto crashes or is killed the capture survives: on the next start it is offered for
 * saving (Cases screen) or discarding. Saving deletes both files.
 */
import { app } from 'electron';
import { createWriteStream, promises as fs, WriteStream } from 'fs';
import path from 'path';
import type { RecordingMeta } from './output';
import type { OutputSettings } from './settings';

export interface UnsavedInfo {
  id: string;
  /** The capture so far. */
  webm: string;
  bytes: number;
  meta: RecordingMeta;
  output: OutputSettings;
}

interface Snapshot {
  meta: RecordingMeta;
  output: OutputSettings;
}

let current: { id: string; stream: WriteStream; writes: Promise<void>; output: OutputSettings } | null = null;

export function unsavedFolder(): string {
  return path.join(app.getPath('userData'), 'unsaved');
}

const webmPath = (id: string) => path.join(unsavedFolder(), `${id}.webm`);
const snapshotPath = (id: string) => path.join(unsavedFolder(), `${id}.json`);

/** Starts a new capture file; `output` is where the video goes once saved (kept for a recovery). */
export async function beginCapture(output: OutputSettings): Promise<string> {
  await endCapture();
  await fs.mkdir(unsavedFolder(), { recursive: true });
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  current = { id, stream: createWriteStream(webmPath(id)), writes: Promise.resolve(), output: { ...output } };
  return id;
}

/** Appends a chunk; chunks are written in the order they arrive. */
export function appendChunk(data: ArrayBuffer): void {
  const capture = current;
  if (!capture) return;
  const buffer = Buffer.from(data);
  capture.writes = capture.writes.then(
    () => new Promise<void>((resolve, reject) => capture.stream.write(buffer, (error) => (error ? reject(error) : resolve()))),
  ).catch((error: Error) => console.error(`[unsaved] ${error.message}`));
}

/** Keeps the latest step log next to the capture (written to a temporary file, then renamed, so it's never half-written). */
export async function writeSnapshot(meta: RecordingMeta): Promise<void> {
  if (!current) return;
  const file = snapshotPath(current.id);
  const snapshot: Snapshot = { meta, output: current.output };
  await fs.writeFile(`${file}.tmp`, JSON.stringify(snapshot));
  await fs.rename(`${file}.tmp`, file);
}

/** Flushes and closes the capture; returns its file (null when nothing was being captured). */
export async function endCapture(): Promise<{ id: string; webm: string } | null> {
  const capture = current;
  current = null;
  if (!capture) return null;
  await capture.writes;
  await new Promise<void>((resolve) => capture.stream.end(() => resolve()));
  return { id: capture.id, webm: webmPath(capture.id) };
}

/** Captures left by a crash (not the one in progress), newest first. One without a step log has nothing to save from. */
export async function listUnsaved(): Promise<UnsavedInfo[]> {
  const names = await fs.readdir(unsavedFolder()).catch(() => [] as string[]);
  // A step log whose capture is gone (saved, or never started) is litter.
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const id = name.replace(/\.json$/, '');
    if (id !== current?.id && !names.includes(`${id}.webm`)) await fs.rm(snapshotPath(id), { force: true });
  }
  const found: UnsavedInfo[] = [];
  for (const name of names.filter((n) => n.endsWith('.webm'))) {
    const id = name.replace(/\.webm$/, '');
    if (id === current?.id) continue;
    try {
      const snapshot = JSON.parse(await fs.readFile(snapshotPath(id), 'utf-8')) as Snapshot;
      const { size } = await fs.stat(webmPath(id));
      if (size > 0) found.push({ id, webm: webmPath(id), bytes: size, meta: snapshot.meta, output: snapshot.output });
    } catch {
      // No step log yet (it crashed in the first seconds) or unreadable: nothing worth offering.
    }
  }
  return found.sort((a, b) => b.id.localeCompare(a.id));
}

export async function discardUnsaved(id: string): Promise<void> {
  if (!/^[\w-]+$/.test(id)) return;
  await Promise.all([webmPath(id), snapshotPath(id), `${snapshotPath(id)}.tmp`].map((f) => fs.rm(f, { force: true })));
}
