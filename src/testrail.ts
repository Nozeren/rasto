/**
 * Minimal TestRail client for loading cases to record. Credentials come from the environment
 * (TESTRAIL_URL, TESTRAIL_USERNAME or TESTRAIL_EMAIL, TESTRAIL_API_KEY), so start the app from a terminal that has them.
 */
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

async function get<T>(endpoint: string): Promise<T> {
  const { base, auth } = config();
  const response = await fetch(base + endpoint, { headers: { Authorization: auth, 'Content-Type': 'application/json' } });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TestRail ${endpoint} answered ${response.status}: ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
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
