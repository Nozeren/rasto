#!/usr/bin/env node
/**
 * Command line for Rasto's remote control. Prints Rasto's JSON answer; exits with 1 when it says ok: false.
 *
 *   rasto-remote status
 *   rasto-remote windows
 *   rasto-remote tabs
 *   rasto-remote record <file.feature | guide.md> (--window <title> | --tab <title or URL>) [--subject <name>] [--config <name>] [--run <R100>]
 *   rasto-remote next | previous | pause | pass | fail | blocked | done | stop     (done ends a guide)
 */
const rasto = require('./remote-client');

const USAGE = `Usage:
  rasto-remote status
  rasto-remote windows
  rasto-remote tabs                (tabs of the browser on the debugging port, recordable headless)
  rasto-remote record <file.feature | guide.md> (--window <title> | --tab <title or URL>) [--subject <name>] [--config <name>] [--run <R100>]
                                   (--run: post the results, clips and logs to that TestRail run once saved)
  rasto-remote next | previous | pause | pass | fail | blocked | done | stop     (done ends a guide)
  rasto-remote note <text>         (a note on the step on screen: in the video, step log, report and TestRail)`;

const ACTIONS = ['next', 'previous', 'pause', 'pass', 'fail', 'blocked', 'done', 'stop'];

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function run(args) {
  const [command, ...rest] = args;
  if (command === 'status') return rasto.status();
  if (command === 'windows') return rasto.windows();
  if (command === 'tabs') return rasto.tabs();
  if (ACTIONS.includes(command)) return rasto.control(command);
  if (command === 'note' && rest.length) return rasto.note(rest.join(' '));
  if (command === 'record' && rest[0] && (option(rest, 'window') || option(rest, 'tab'))) {
    return rasto.record({ feature: rest[0], window: option(rest, 'window'), tab: option(rest, 'tab'), subject: option(rest, 'subject'), config: option(rest, 'config'), run: option(rest, 'run') });
  }
  return null;
}

const pending = run(process.argv.slice(2));
if (!pending) {
  console.error(USAGE);
  process.exit(2);
}
pending
  .then((answer) => {
    console.log(JSON.stringify(answer, null, 2));
    process.exit(answer.ok === false ? 1 : 0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
