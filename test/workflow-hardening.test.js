// #379: what every workflow promises. Runs in the public export too, where the private workflows are simply not there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const dir = new URL('../.github/workflows/', import.meta.url);
const flows = readdirSync(dir).filter((f) => f.endsWith('.yml')).map((name) => ({ name, flow: yaml.load(readFileSync(new URL(name, dir), 'utf8')) }));
const steps = flows.flatMap(({ name, flow }) => Object.values(flow.jobs).flatMap((job) => (job.steps || []).map((step) => ({ name, step }))));

test('there are workflows and steps to check', () => {
  assert.ok(flows.length >= 2);
  assert.ok(steps.length > 5);
});

test('every action is pinned to a commit', () => {
  for (const { name, step } of steps) {
    if (step.uses) assert.match(step.uses, /^[\w./-]+@[0-9a-f]{40}$/, `${name}: ${step.uses}`);
  }
});

test('nothing from outside reaches a script directly, only through the environment', () => {
  for (const { name, step } of steps) {
    assert.doesNotMatch(step.run || '', /\$\{\{\s*(inputs\.|github\.event|github\.head_ref)/, `${name}: ${step.name || step.run}`);
  }
});

test('next to the signing keys only the install script of keytar runs', { skip: !existsSync(new URL('early-access.yml', dir)) && 'private workflow' }, () => {
  const release = flows.find((f) => f.name === 'early-access.yml').flow.jobs.release.steps;
  const runs = release.map((s) => s.run);
  assert.equal(runs.filter((r) => /\bnpm (ci|install|i)\b/.test(r || '')).length, 1);
  const install = runs.indexOf('npm ci --ignore-scripts');
  assert.ok(install >= 0, 'dependencies without install scripts');
  assert.equal(runs[install + 1], 'npm rebuild keytar', 'keytar right after, as a step of its own');
  const keys = release.findIndex((s) => Object.values(s.env || {}).some((v) => /secrets\./.test(String(v))));
  assert.ok(install < keys, 'installed before any key is in the run');
});
