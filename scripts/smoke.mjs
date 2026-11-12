// npm run smoke [-- --only=<area>[,<area>…]]: the normal start and the demo, or only the demo for a partial run (#397).
// Without a shell: what is passed on stays one argument each, and scripts/start.mjs checks it.
// One run at a time (#529): the run holds %TEMP%\keevault-smoke.lock and stops with exit code 2 if another one does.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { smokePlan } from '../desktop/smoke-areas.js';
import { lockHeldMessage, takeSmokeLock } from './smoke-lock.mjs';

const lock = takeSmokeLock({ what: `npm run smoke ${process.argv.slice(2).join(' ')}`.trim() });
if (!lock.ok) {
  console.error(lockHeldMessage(lock.holder));
  process.exit(2);
}
process.on('exit', lock.release);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

const start = fileURLToPath(new URL('./start.mjs', import.meta.url));
for (const args of smokePlan(process.argv.slice(2))) {
  const { status } = spawnSync(process.execPath, [start, ...args], { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}
