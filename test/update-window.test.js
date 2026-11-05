import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The visible update window stays in front until the new version starts (#335); a silent update stays invisible.
const read = (p) => readFileSync(fileURLToPath(new URL(`../windows/Setup/${p}`, import.meta.url)), 'utf8');

test('update window: in front and on top while a visible update runs, never for a silent one', () => {
  const program = read('Program.cs');
  assert.match(program, /if \(args\.Has\("update"\) && !args\.Has\("silent"\)\)\s*\{[^\n]*\n[^\n]*KeepInFront\.Bring\(this\)[^\n]*\n\s*KeepInFront\.Hold\(this\);/);
  assert.match(program, /if \(!args\.Has\("silent"\)\) KeepInFront\.Bring\(this\);/, 'again once the old app has ended');
  const front = read('KeepInFront.cs');
  // On top without taking the focus every second; the foreground only through Bring (appearing, old app gone).
  assert.match(front, /SWP_NOACTIVATE/);
  assert.match(front, /window\.Closed \+= \(s, e\) => timer\.Stop\(\)/);
});
