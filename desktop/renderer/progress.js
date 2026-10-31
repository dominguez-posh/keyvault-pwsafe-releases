// Small progress card bottom right for actions that take a moment: a label and a bar – real progress when the
// main process reports done/total for the task, otherwise a running bar. It appears only after a short delay, so
// quick actions never flicker, fills up green when the task ends and fades out.
import { h } from '../../extension/core/dom.js';
import { t } from '../../extension/core/i18n.js';

const SHOW_AFTER = 250; // ms – anything faster stays invisible
const LINGER = 600; // ms – the finished bar stays visible this long
const tasks = new Map(); // id → { label, detail, done, total, percent, started }
let order = []; // ids in start order; the newest one is shown
let el = null;
let showTimer = null;
let hideTimer = null;
let hovered = false; // a finished card stays open while the mouse is on it

function element() {
  if (!el) {
    el = h('div', { class: 'progress-toast', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'progress-label' }, h('span', { class: 'progress-text' }), h('span', { class: 'progress-count' })),
      h('div', { class: 'progress-track' }, h('div', { class: 'progress-fill' })),
      h('div', { class: 'progress-detail' }, h('span', { class: 'progress-step' }), h('span', { class: 'progress-time' })),
      // Hover: the card grows and lists every step with its duration (and a hint, e.g. why a listing is slow).
      h('ol', { class: 'progress-steps' }),
      h('div', { class: 'progress-hint' }));
    el.addEventListener('mouseenter', () => { hovered = true; });
    el.addEventListener('mouseleave', () => {
      hovered = false;
      if (!tasks.size && el.classList.contains('show')) hideTimer = setTimeout(() => el.classList.remove('show'), LINGER);
    });
    document.body.append(el);
  }
  return el;
}

function render() {
  const task = tasks.get(order[order.length - 1]);
  if (!task) return;
  const node = element();
  const determinate = task.total > 0;
  const fraction = determinate ? Math.min(task.done / task.total, 1) : 0;
  node.classList.remove('done');
  node.classList.toggle('indeterminate', !determinate);
  node.querySelector('.progress-text').textContent = order.length > 1 ? `${task.label} (+${order.length - 1})` : task.label;
  node.querySelector('.progress-count').textContent = !determinate ? '' : task.percent ? `${Math.round(fraction * 100)} %` : `${Math.min(task.done, task.total)}/${task.total}`;
  node.querySelector('.progress-fill').style.width = determinate ? `${Math.round(fraction * 100)}%` : '';
  // Second line: what is running right now (step, page, count) and how long the task has been running.
  node.querySelector('.progress-step').textContent = task.detail || '';
  const seconds = Math.floor((Date.now() - task.started) / 1000);
  node.querySelector('.progress-time').textContent = seconds >= 2 ? t('{n} s', { n: seconds }) : '';
  node.querySelector('.progress-detail').hidden = !task.detail && seconds < 2;
  renderSteps(node, task);
}

const secondsText = (ms) => (ms < 1000 ? t('< 1 s') : t('{n} s', { n: Math.round(ms / 1000) }));

function renderSteps(node, task) {
  const list = node.querySelector('.progress-steps');
  list.replaceChildren(...(task.steps || []).map((s) => h('li', { class: s.end ? 'step-done' : 'step-running' },
    h('span', { class: 'step-mark' }, s.end ? '✓' : ''),
    h('span', { class: 'step-text' }, s.text),
    h('span', { class: 'step-time' }, secondsText((s.end || Date.now()) - s.start)))));
  list.hidden = !(task.steps || []).length;
  const hint = node.querySelector('.progress-hint');
  hint.textContent = task.hint || '';
  hint.hidden = !task.hint;
}

// The running time ticks while a task is shown.
let clock = null;
function tickClock() {
  if (tasks.size && el?.classList.contains('show')) render();
  if (!tasks.size) {
    clearInterval(clock);
    clock = null;
  }
}

/** Starts (or relabels) a task; returns a function that ends it. */
export function begin(id, label) {
  const task = tasks.get(id) || { done: 0, total: 0, percent: false, detail: '', started: Date.now() };
  clock ||= setInterval(tickClock, 1000);
  task.label = label;
  tasks.set(id, task);
  if (!order.includes(id)) order.push(id);
  clearTimeout(hideTimer);
  hideTimer = null;
  if (element().classList.contains('show')) render();
  else if (!showTimer) {
    showTimer = setTimeout(() => {
      showTimer = null;
      if (!tasks.size) return;
      render();
      element().classList.add('show');
    }, SHOW_AFTER);
  }
  return () => end(id);
}

/** Known progress: done of total (percent: show "n %" instead of "done/total"). */
export function set(id, done, total, { percent = false } = {}) {
  const task = tasks.get(id);
  if (!task) return;
  Object.assign(task, { done, total, percent });
  if (element().classList.contains('show')) render();
}

export function end(id) {
  if (!tasks.delete(id)) return;
  order = order.filter((x) => x !== id);
  if (tasks.size) {
    render();
    return;
  }
  clearTimeout(showTimer);
  showTimer = null;
  const node = element();
  if (!node.classList.contains('show')) return;
  node.classList.add('done');
  node.classList.remove('indeterminate');
  node.querySelector('.progress-fill').style.width = '100%';
  node.querySelector('.progress-count').textContent = '';
  if (hovered) return; // closes on mouseleave
  hideTimer = setTimeout(() => {
    hideTimer = null;
    node.classList.remove('show');
  }, LINGER);
}

/**
 * Progress events from the main process: { id, label? } starts or relabels, { id, done, total } reports, { id, detail }
 * names the step running right now,
 * { id, end: true } finishes. Events without an id belong to dialogs with their own inline progress.
 */
export function onEvent(ev) {
  if (!ev?.id) return;
  if (ev.end) {
    end(ev.id);
    return;
  }
  if (!tasks.has(ev.id)) {
    if (!ev.label) return; // progress for a task nobody started here (e.g. a call from another window)
    begin(ev.id, ev.label);
  } else if (ev.label) begin(ev.id, ev.label);
  if ('detail' in ev || ev.step) {
    const task = tasks.get(ev.id);
    if ('detail' in ev) task.detail = ev.detail || '';
    if ('hint' in ev) task.hint = ev.hint || '';
    if (ev.step) {
      // A new step closes the previous one; the same step only updates its text (e.g. the page counter).
      task.steps ||= [];
      const last = task.steps[task.steps.length - 1];
      const now = Date.now();
      if (last?.key === ev.step) last.text = ev.detail || last.text;
      else {
        if (last && !last.end) last.end = now;
        task.steps.push({ key: ev.step, text: ev.detail || '', start: now, end: ev.step === 'done' ? now : 0 });
      }
    }
    if (element().classList.contains('show')) render();
  }
  // total 0 switches back to a running bar (count in the label), e.g. when a listing outgrows the expected size.
  if ('total' in ev) set(ev.id, ev.done || 0, ev.total || 0);
}

/** Updater state → download progress in percent. */
export function fromUpdate(state) {
  if (state?.status === 'downloading') {
    if (!tasks.has('update')) begin('update', t('Update wird geladen …'));
    set('update', Math.round(state.progress || 0), 100, { percent: true });
  } else end('update');
}
