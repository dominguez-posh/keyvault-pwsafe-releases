// A smoke run always ends with a verdict and an exit code (#377). Before this, a rejected await outside the feature checks
// (a screenshot path that can't be written) left Electron's main process running with only a warning: no verdict, no end.
// Three ways lead to the verdict: the run's body is finished or throws, a promise nobody handles is rejected, or the
// deadline passes while something never answers. Nothing here runs on import, and only boot.js starts it for --smoke-test.
//
// KVPWSAFE_SMOKE_DEADLINE_MS replaces the deadline. It counts per process, and the demo process does nearly all the work.
// Measured for #397: 40 CI runs of both processes together 117 to 200 s, local 185 to 195 s. The slowest step on record
// (clipboard 41 s instead of 3.7 s) on top of the local maximum gives SLOWEST_RUN_ON_RECORD_MS.
// 8 Nov 2026: the feature steps alone took 231 s locally and one full run hit the 300 s under load; 480 s since then.
// Each area keeps its own limit of 45 s (desktop/smoke-features.js).
// 11 Nov 2026 (#526): 0.9.33 has 80 areas, and both full runs of the release check hit the 480 s before their end. The
// deadline now grows with the areas a run is due to check: 4 min plus 10 s per area (full run 80 areas: 1040 s). A hanging
// run still ends with a verdict. Never below the former 480 s: a partial run of a few flows needs that much.
//
// A partial run (--only, #397) never says "SMOKE OK": it did not check what a full run checks.

import { SMOKE_AREAS, onlyAreas } from '../smoke-areas.js';

export const DEADLINE_BASE_MS = 4 * 60_000;
export const DEADLINE_PER_AREA_MS = 10_000;

export const MIN_DEADLINE_MS = 8 * 60_000;

/** The deadline of a run with these arguments: base plus a share per area it is due to check, at least MIN_DEADLINE_MS. */
export const deadlineFor = (argv = []) => Math.max(MIN_DEADLINE_MS, DEADLINE_BASE_MS + DEADLINE_PER_AREA_MS * (onlyAreas(argv) || SMOKE_AREAS).length);

/** The deadline of a full run. */
export const SMOKE_DEADLINE_MS = deadlineFor([]);
export const SLOWEST_RUN_ON_RECORD_MS = 232_000;

export function startSmokeGuard({ exit, log = console.log, env = process.env, on = (name, fn) => process.on(name, fn), argv = process.argv }) {
  const fromEnv = Number(env.KVPWSAFE_SMOKE_DEADLINE_MS);
  const deadlineMs = fromEnv > 0 ? fromEnv : deadlineFor(argv);
  const partial = onlyAreas(argv);
  let collected = () => [];
  let stage = 'start';
  let ended = false;
  const finish = (extra = []) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    const problems = [...collected(), ...extra];
    if (problems.length) log(`SMOKE FAIL\n${problems.join('\n')}${partial ? `\npartial run, not a full run: only ${partial.join(', ')}` : ''}`);
    else log(partial ? `SMOKE PARTIAL OK: only ${partial.join(', ')}. Not a full run, the full run stays due before the merge.` : 'SMOKE OK');
    exit(problems.length ? 1 : 0);
  };
  const timer = setTimeout(() => finish([`run did not finish within ${deadlineMs / 1000} s, last stage: ${stage}`]), deadlineMs);
  on('unhandledRejection', (e) => finish([`unhandled rejection, last stage ${stage}: ${e?.stack || e}`]));
  return {
    /** What the run has found so far: part of every verdict, also when the run is cut short. */
    collect: (problems) => { collected = problems; },
    /** Names the current part of the run for the verdict of a run that stopped there. */
    note: (name) => { stage = name; },
    /** The current part of the run (#526: names where a session lock hit the run). */
    stage: () => stage,
    /** Runs the body, then gives the verdict. A throw in the body is a failure, never the end of the verdict. */
    run: (body) => Promise.resolve().then(body).then(() => finish(), (e) => finish([`run stopped at ${stage}: ${e?.stack || e}`])),
  };
}
