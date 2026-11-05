// The interface of the desktop app (sandboxed renderer). It only talks to the main process through
// window.pwsafe (preload bridge) – see app/ipc.js.
//
// This file is only the start: it loads the modules in app/ (one per subject, see docs/ARCHITEKTUR.md,
// "Code-Struktur") and draws the window for the first time.

import { h } from '../../extension/core/dom.js';
import { setClipboardWriter } from '../../extension/core/ui-protect.js';
import { call } from './app/ipc.js';
import { root } from './app/layout.js';
import { notice } from './app/helpers.js';
import { render } from './app/shell.js';

// Loaded for what they register (events from the main process, keyboard shortcuts) – nothing here calls them by name.
import './app/events.js';
import './app/keyboard.js';

// Codes in dialogs (recovery key, invitation code) go through the app's clipboard like everything else.
setClipboardWriter((text) => call('copy', text));

// Unexpected errors go to the diagnostics log (Einstellungen → Protokoll), without any secret values.
window.addEventListener('error', (e) => call('log', { level: 'error', message: e.message, detail: `${e.filename}:${e.lineno}` }).catch(() => {}));
window.addEventListener('unhandledrejection', (e) => call('log', { level: 'error', message: e.reason?.message || String(e.reason), detail: (e.reason?.stack || '').split(/\r?\n/).slice(0, 3).join(' / ') }).catch(() => {}));

render().catch((e) => {
  document.body.dataset.ready = '1';
  root.replaceChildren(h('div', { class: 'splash' }, notice(e.message)));
});
