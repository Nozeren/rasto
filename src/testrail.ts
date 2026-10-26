/**
 * Minimal TestRail client: loads cases to record, and posts results (with the clips and logs attached) to a run.
 * Credentials come from ⚙ Settings, or from the environment (TESTRAIL_URL, TESTRAIL_USERNAME or TESTRAIL_EMAIL,
 * TESTRAIL_API_KEY).
 */
import { openAsBlob, promises as fs } from 'fs';
import path from 'path';
import { Feature, parseGherkin, Step } from './gherkin';

interface TestRailCase {
  id: number;
  title: string;
  custom_preconds?: string | null;
  custom_steps_separated?: { content?: string; expected?: string }[] | null;
  custom_steps?: string | null;
}

interface TestRailTest {
  id: number;
  case_id: number;
  title: string;
  status_id: number;
}

export interface RunTest {
  testId: number;
  caseId: string;
  title: string;
  status: string;
}

export interface LoadedRun {
  id: number;
  name: string;
  tests: RunTest[];
}

export interface TestRailCredentials {
  url: string;
  user: string;
  apiKey: string;
}

/** Credentials saved in Settings; when absent, the TESTRAIL_* environment variables are used. */
let saved: TestRailCredentials | null = null;

export function setCredentials(credentials: TestRailCredentials | null): void {
  saved = credentials && credentials.url && credentials.user && credentials.apiKey ? credentials : null;
}

export function credentialSource(): 'settings' | 'environment' | 'none' {
  if (saved) return 'settings';
  const user = process.env.TESTRAIL_USERNAME || process.env.TESTRAIL_EMAIL;
  return process.env.TESTRAIL_URL && user && process.env.TESTRAIL_API_KEY ? 'environment' : 'none';
}

function config(): { base: string; auth: string } {
  const url = saved?.url ?? process.env.TESTRAIL_URL;
  const user = saved?.user ?? (process.env.TESTRAIL_USERNAME || process.env.TESTRAIL_EMAIL);
  const key = saved?.apiKey ?? process.env.TESTRAIL_API_KEY;
  if (!url || !user || !key) {
    throw new Error('TestRail is not set up: add the URL, user and API key in ⚙ Settings.');
  }
  const base = `${url.replace(/\/+$/, '').replace(/\/index\.php.*$/, '')}/index.php?/api/v2/`;
  return { base, auth: `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}` };
}

/** fetch, with a network failure ("fetch failed") turned into which TestRail could not be reached, and why. */
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(`TestRail is not reachable at ${new URL(url).origin}: ${cause?.code ?? cause?.message ?? (error as Error).message}`);
  }
}

async function get<T>(endpoint: string): Promise<T> {
  const { base, auth } = config();
  const response = await request(base + endpoint, { headers: { Authorization: auth, 'Content-Type': 'application/json' } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TestRail ${endpoint} answered ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

async function send<T>(endpoint: string, body: BodyInit, json: boolean): Promise<T> {
  const { base, auth } = config();
  const response = await request(base + endpoint, {
    method: 'POST',
    headers: { Authorization: auth, ...(json ? { 'Content-Type': 'application/json' } : {}) },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text.slice(0, 200);
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {
      // not JSON: keep the text
    }
    throw new Error(`TestRail ${endpoint.split('/')[0]} answered ${response.status}: ${message}`);
  }
  return (await response.json()) as T;
}

/** TestRail's system statuses. */
export const STATUS_ID = { pass: 1, blocked: 2, fail: 5 } as const;

/** Accepts "R100", "r100", "run 100" or "100". */
export function parseRunId(input: string): number | null {
  const match = /^\s*(?:r|run)?\s*(\d+)\s*$/i.exec(input);
  return match ? Number(match[1]) : null;
}

export async function addResultForCase(
  runId: number,
  caseId: number,
  result: { status_id: number; comment: string; elapsed?: string },
): Promise<{ id: number }> {
  return send(`add_result_for_case/${runId}/${caseId}`, JSON.stringify(result), true);
}

/** TestRail refuses attachments over 256 MB. */
export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;

export async function addAttachmentToResult(resultId: number, file: string): Promise<void> {
  const { size } = await fs.stat(file);
  if (size > MAX_ATTACHMENT_BYTES) throw new Error(`${path.basename(file)} is over TestRail's 256 MB limit`);
  const form = new FormData();
  form.append('attachment', await openAsBlob(file), path.basename(file));
  await send(`add_attachment_to_result/${resultId}`, form, false);
}

/** TestRail stores the Gherkin as HTML (<pre><code>…, &nbsp;, <br>). Back to plain text. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Accepts "C1234", "c1234", "1234" or "C1234R". */
export function parseCaseId(input: string): number | null {
  const match = /^\s*[Cc]?(\d+)[Rr]?\s*$/.exec(input);
  return match ? Number(match[1]) : null;
}

/**
 * Loads a case as a Feature with a single scenario. Gherkin in the steps is parsed (including Scenario Outline +
 * Examples); plain-text steps (older cases) become one step each, with the expected result appended.
 */
export async function loadCase(caseId: number): Promise<Feature> {
  const tc = await get<TestRailCase>(`get_case/${caseId}`);
  const preconds = htmlToText(tc.custom_preconds);
  const separated = tc.custom_steps_separated ?? [];
  const stepsText = separated.length ? separated.map((s) => htmlToText(s.content)).join('\n') : htmlToText(tc.custom_steps);

  const parsed = parseGherkin(`${preconds}\n${stepsText}`);
  const id = `C${tc.id}`;

  if (parsed.scenarios.length) {
    const scenario = parsed.scenarios[0];
    return {
      name: tc.title,
      background: parsed.background,
      scenarios: [{ ...scenario, name: scenario.name || tc.title, caseId: id }],
    };
  }

  // Not Gherkin: one step per TestRail step, "content → expected".
  const steps: Step[] = separated
    .map((s) => {
      const content = htmlToText(s.content).trim().replace(/\s+/g, ' ');
      const expected = htmlToText(s.expected).trim().replace(/\s+/g, ' ');
      return { keyword: '', text: expected ? `${content} → ${expected}` : content, extra: [] };
    })
    .filter((s) => s.text);

  return {
    name: tc.title,
    background: parsed.background,
    scenarios: [{ name: tc.title, tags: [], caseId: id, steps, examples: null }],
  };
}

/** Lists the tests of a run with their current status, to pick one to record. */
export async function loadRun(runId: number): Promise<LoadedRun> {
  const [run, statuses, testsPage] = await Promise.all([
    get<{ id: number; name: string }>(`get_run/${runId}`),
    get<{ id: number; label: string }[]>('get_statuses'),
    get<{ tests: TestRailTest[] } | TestRailTest[]>(`get_tests/${runId}`),
  ]);
  const labels = new Map(statuses.map((s) => [s.id, s.label]));
  const tests = Array.isArray(testsPage) ? testsPage : testsPage.tests;

  return {
    id: run.id,
    name: run.name,
    tests: tests.map((t) => ({
      testId: t.id,
      caseId: `C${t.case_id}`,
      title: t.title,
      status: labels.get(t.status_id) ?? 'Untested',
    })),
  };
}

/** Cheap authenticated call to check the URL and credentials. */
export async function testConnection(): Promise<void> {
  await get<unknown>('get_statuses');
}
