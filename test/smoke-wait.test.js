// #397: until() replaces fixed pauses in the smoke checks. What it may not do: end early with a good answer it did not get.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nextFrame, questionsGone, until } from '../desktop/smoke-wait.js';

// A page as in a never shown window: the dialog is gone at once, its close event only comes with the next frame.
function pageWithLateCloseEvent() {
  const page = { dialogs: 1, closeEvents: 0, pending: 1, asked: [] };
  page.js = async (code) => {
    page.asked.push(code);
    if (code.includes('requestAnimationFrame')) {
      page.closeEvents += page.pending;
      page.pending = 0;
      return true;
    }
    return page.dialogs === 0;
  };
  return page;
}

test('questionsGone: the close event has come when it returns, not only the dialog gone', async () => {
  const page = pageWithLateCloseEvent();
  page.dialogs = 0;
  await questionsGone(page.js);
  assert.equal(page.closeEvents, 1);
});

test('questionsGone: waits for the frame after the dialog has left, not before', async () => {
  const page = pageWithLateCloseEvent();
  page.pending = 0;
  setTimeout(() => { page.dialogs = 0; page.pending = 1; }, 40);
  await questionsGone(page.js, 1000);
  assert.equal(page.closeEvents, 1);
  assert.match(page.asked.at(-1), /requestAnimationFrame/);
});

test('nextFrame ends without a frame too: the check after it decides, the run does not hang', () => {
  let code = '';
  nextFrame(async (c) => { code = c; }, 1234);
  assert.match(code, /setTimeout\(\(\) => done\(false\), 1234\)/);
});

// #397: the Microsoft choice opens right after the passkey question closed; it has to wait for that close event.
test('the Microsoft choice follows the full wait, and a delay that does not end is reported', () => {
  const features = readFileSync(new URL('../desktop/smoke-features.js', import.meta.url), 'utf8');
  assert.match(features, /await questionsGone\(js\);\n\s+await microsoftChoiceCheck\(/);
  const code = readFileSync(new URL('../desktop/smoke-agent-questions.js', import.meta.url), 'utf8');
  assert.match(code, /Microsoft choice: the delay of "Sign in" did not end/);
  assert.match(code, /the delay of "Allow" did not end/);
});

// The limits where a time is the check stay.
test('agentfront keeps its limits of 200 ms and 600 ms', () => {
  const features = readFileSync(new URL('../desktop/smoke-features.js', import.meta.url), 'utf8');
  assert.match(features, /until\(\(\) => !win\.isAlwaysOnTop\(\), 200\)/);
  assert.match(features, /until\(\(\) => front\(\)\.visible && front\(\)\.top, 600\)/);
});

test('returns as soon as the answer is there', async () => {
  let asked = 0;
  const started = Date.now();
  assert.equal(await until(() => ++asked === 3 && 'yes', 5000, 1), 'yes');
  assert.equal(asked, 3);
  assert.ok(Date.now() - started < 1000);
});

test('takes promises, and a false answer stays false after the limit', async () => {
  let asked = 0;
  const started = Date.now();
  assert.equal(await until(async () => { asked++; return false; }, 60, 5), false);
  assert.ok(Date.now() - started >= 55);
  assert.ok(asked >= 2, 'asks again');
});

test('with no time left it still asks once', async () => {
  assert.equal(await until(() => 'late', 0), 'late');
  assert.equal(await until(() => '', 0), '');
});

test('a rejected check is not swallowed', async () => {
  await assert.rejects(until(async () => { throw new Error('boom'); }, 10), /boom/);
});

// The counter-checks of agententer: where something must not happen, the time window stays as it was.
test('agententer keeps its windows for what must not happen, and its limit for the delay', () => {
  const code = readFileSync(new URL('../desktop/smoke-agent-questions.js', import.meta.url), 'utf8');
  assert.match(code, /const CONFIRM_WAIT = 1500;/);
  assert.match(code, /const after = \(request, ms = 300\) => Promise\.race\(\[request, sleep\(ms\)\.then\(\(\) => 'open'\)\]\);/);
  const check = code.slice(code.indexOf('export async function deliberateAnswerCheck'));
  assert.equal(check.match(/await after\(\w+\)\) !== 'open'/g).length, 10);
  assert.match(check, /await after\(write, 100\)\) !== 'open'/);
  assert.match(check, /await nextFrame\(js\); \/\/ the dialog's close event comes after the answer.*\n\s+if \(!\(await waiting\('\.agent-write'\)\)\) fail\(area, 'two questions/);
  assert.match(code, /const delayOver = .*getAttribute\("aria-disabled"\) === "false".*CONFIRM_WAIT\)/);
  // The state of "Allow" is asked after the wait, as before.
  assert.match(code, /await delayOver\('\.agent-write'\);\n\s+if \(await waiting\('\.agent-write'\)\) fail\(area, 'write request: "Allow" still disabled after the delay'\);/);
});
