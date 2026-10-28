/**
 * Rumo (github.com/Nozeren/rumo), the BDD test management app: a saved recording is sent to a project's import, which
 * turns its step log into results (matching cases by their @C<id> tags) and attaches each case's clip, or the video.
 */
import { openAsBlob } from 'fs';
import path from 'path';
import type { SavedRecording } from './report';

export interface RumoConfig {
  /** As https://rumo.example.com */
  url: string;
  /** The project's short name in its address: /p/<project>. */
  project: string;
  /** A personal API token, made on the Rumo account page. */
  token: string;
}

export interface RumoOutcome {
  runUrl: string;
  recorded: number;
  unmatched: string[];
}

function base(config: RumoConfig): string {
  return config.url.trim().replace(/\/+$/, '');
}

function projectApi(config: RumoConfig): string {
  return `${base(config)}/api/projects/${encodeURIComponent(config.project.trim())}`;
}

async function call(url: string, config: RumoConfig, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(`Rumo: ${body?.error ?? `${response.status} ${response.statusText}`}`);
  }
  return response;
}

/** Checks the address, the token and that the project is there. */
export async function testConnection(config: RumoConfig): Promise<string> {
  const project = (await (await call(projectApi(config), config)).json()) as { name: string };
  return project.name;
}

/** The files to send: the step log first (Rumo reads it as the report), then every clip, then the video. */
export function recordingFiles(recording: SavedRecording): string[] {
  const folder = path.dirname(recording.video);
  return [recording.log, ...recording.clips.map((clip) => path.join(folder, clip.file)), recording.video];
}

/** Sends the recording as a new run named after its subject and config. */
export async function postRecording(config: RumoConfig, recording: SavedRecording): Promise<RumoOutcome> {
  const form = new FormData();
  for (const file of recordingFiles(recording)) form.append('file', await openAsBlob(file), path.basename(file));
  const name = `${recording.subject} · ${recording.config}`;
  const response = await call(`${projectApi(config)}/imports?format=rasto&name=${encodeURIComponent(name)}`, config, {
    method: 'POST',
    body: form,
  });
  const result = (await response.json()) as { runId: string; recorded: number; unmatched: { name: string }[] };
  return {
    runUrl: `${base(config)}/p/${encodeURIComponent(config.project.trim())}/runs/${result.runId}`,
    recorded: result.recorded,
    unmatched: result.unmatched.map((u) => u.name),
  };
}
