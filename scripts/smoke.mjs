// npm run smoke [-- --only=<area>[,<area>…]]: the normal start and the demo, or only the demo for a partial run (#397).
// Without a shell: what is passed on stays one argument each, and scripts/start.mjs checks it.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { smokePlan } from '../desktop/smoke-areas.js';

const start = fileURLToPath(new URL('./start.mjs', import.meta.url));
for (const args of smokePlan(process.argv.slice(2))) {
  const { status } = spawnSync(process.execPath, [start, ...args], { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}
