/**
 * Guides: how-to recordings written as Markdown, instead of test cases. The first "# " heading is the title, each
 * "## " heading starts a part, and each numbered line ("1. …" or "1) …") at the start of a line is a step. Anything
 * else after a step (indented sub-steps, bullets, text, code blocks) is shown with that step in the step list. A guide
 * becomes a Feature with one scenario and kind 'guide', so it goes through the same queue and recording as a case.
 *
 *   # Export a report as CSV
 *
 *   ## Check that the columns exist
 *   1. Open Site contents, then Site settings, then Site columns
 *
 *   ## Show the columns in the library
 *   2. Click "+ Add column", then "Show or hide columns"
 */
import { Feature, hasGherkinStructure, Step } from './gherkin';

const TITLE_RE = /^#\s+(.+)$/;
const PART_RE = /^##\s+(.+)$/;
const STEP_RE = /^\d+[.)]\s+(.+)$/;
const FENCE_RE = /^\s*(```|~~~)/;

/** The guide in the text, or null when it isn't one: it needs a "# " title and a numbered step, and no Gherkin. */
export function parseGuide(source: string): Feature | null {
  if (hasGherkinStructure(source)) return null;

  let title = '';
  let part: string | undefined;
  let inFence = false;
  const steps: Step[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const current = steps[steps.length - 1];

    if (FENCE_RE.test(rawLine)) {
      inFence = !inFence;
      current?.extra.push(rawLine.trimEnd());
      continue;
    }
    if (inFence) {
      current?.extra.push(rawLine.trimEnd());
      continue;
    }

    const indented = /^\s/.test(rawLine);
    const stepMatch = indented ? null : STEP_RE.exec(line);
    const titleMatch = TITLE_RE.exec(line);
    const partMatch = indented ? null : PART_RE.exec(line);

    if (partMatch && title) {
      part = partMatch[1].trim();
    } else if (stepMatch) {
      steps.push({ keyword: '', text: stepMatch[1].trim(), extra: [], ...(part ? { part } : {}) });
    } else if (titleMatch && !title && !current) {
      title = titleMatch[1].trim();
    } else if (line && current) {
      current.extra.push(line);
    }
  }

  if (!title || !steps.length) return null;
  return { kind: 'guide', name: title, background: [], scenarios: [{ name: title, tags: [], caseId: null, steps, examples: null }] };
}
