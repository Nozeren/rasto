/**
 * A small Gherkin parser: enough for manual runs (Feature, Background, Scenario / Scenario Outline, tags, steps with
 * data tables and doc strings, Examples). It is forgiving on purpose, because TestRail text is often not a full
 * feature file (no "Feature:" line, HTML leftovers, odd indentation).
 */

export interface Step {
  keyword: string;
  text: string;
  /** Data table rows or doc string lines under the step, shown in the step list but not in the banner. */
  extra: string[];
  /** A guide's part (its "## " heading) the step belongs to; guides without parts and test cases leave it out. */
  part?: string;
}

export interface Examples {
  headers: string[];
  rows: string[][];
}

export interface Scenario {
  name: string;
  tags: string[];
  /** TestRail case id taken from a @C<id> tag, e.g. "C103"; null when the scenario has none. */
  caseId: string | null;
  steps: Step[];
  examples: Examples | null;
}

export interface Feature {
  /** 'guide' for a Markdown guide (guide.ts); test cases leave it out. */
  kind?: 'guide';
  name: string;
  background: Step[];
  scenarios: Scenario[];
}

const STEP_KEYWORDS = ['Given', 'When', 'Then', 'And', 'But', '*'];
const SCENARIO_RE = /^(Scenario Outline|Scenario Template|Scenario|Example):\s*(.*)$/;
const EXAMPLES_RE = /^(Examples|Scenarios):/;
const CASE_TAG_RE = /^@?(C\d+R?)$/;
const STRUCTURE_RE = /^\s*(Feature|Rule|Background|Scenario Outline|Scenario Template|Scenario|Example|Examples|Scenarios):/m;

/** Whether the text has Gherkin structure (Feature, Scenario, Background, Examples…), not just steps. */
export function hasGherkinStructure(source: string): boolean {
  return STRUCTURE_RE.test(source);
}

function splitRow(line: string): string[] {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function stepFrom(line: string): Step | null {
  for (const keyword of STEP_KEYWORDS) {
    if (line === keyword || line.startsWith(`${keyword} `)) {
      return { keyword, text: line.slice(keyword.length).trim(), extra: [] };
    }
  }
  return null;
}

export function parseGherkin(source: string): Feature {
  const feature: Feature = { name: '', background: [], scenarios: [] };
  let tags: string[] = [];
  let section: 'none' | 'background' | 'scenario' | 'examples' = 'none';
  let scenario: Scenario | null = null;
  let lastStep: Step | null = null;
  let inDocString = false;
  let examplesHeaders: string[] | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith('"""') || line.startsWith('```')) {
      inDocString = !inDocString;
      continue;
    }
    if (inDocString) {
      lastStep?.extra.push(rawLine.replace(/\s+$/, ''));
      continue;
    }
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('@')) {
      tags.push(...line.split(/\s+/).filter((t) => t.startsWith('@')));
      continue;
    }
    if (line.startsWith('Feature:')) {
      feature.name = line.slice('Feature:'.length).trim();
      tags = [];
      continue;
    }
    if (line.startsWith('Rule:')) continue;

    if (line.startsWith('Background:')) {
      section = 'background';
      lastStep = null;
      tags = [];
      continue;
    }

    const scenarioMatch = SCENARIO_RE.exec(line);
    if (scenarioMatch) {
      const caseTag = tags.map((t) => CASE_TAG_RE.exec(t)).find(Boolean);
      scenario = {
        name: scenarioMatch[2].trim(),
        tags,
        caseId: caseTag ? caseTag[1] : null,
        steps: [],
        examples: null,
      };
      feature.scenarios.push(scenario);
      section = 'scenario';
      lastStep = null;
      examplesHeaders = null;
      tags = [];
      continue;
    }

    if (EXAMPLES_RE.test(line) && scenario) {
      section = 'examples';
      examplesHeaders = null;
      tags = [];
      continue;
    }

    if (line.startsWith('|')) {
      if (section === 'examples' && scenario) {
        const cells = splitRow(line);
        if (!examplesHeaders) {
          examplesHeaders = cells;
          if (!scenario.examples) scenario.examples = { headers: cells, rows: [] };
        } else {
          scenario.examples?.rows.push(cells);
        }
      } else {
        lastStep?.extra.push(line);
      }
      continue;
    }

    const step = stepFrom(line);
    if (step) {
      if (section === 'background') feature.background.push(step);
      else if (scenario && section === 'scenario') scenario.steps.push(step);
      lastStep = step;
    }
  }

  return feature;
}
