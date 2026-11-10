// Smoke check of the drop targets (#491): while an entry is dragged over another vault in the sidebar, that row lights
// up ("drop" with the label "Hierher verschieben") and takes the drop; the personal vault refuses entries from a shared
// vault and says why ("drop-blocked" with the reason as tooltip); the entry's own vault stays quiet. The same in the
// folder tree. Leaving the row removes the mark, a drop removes it and pulses ("drop-done") – the move itself and its
// confirmation stay as they were (the vault drop is cancelled in the confirmation here, the folder drop moves).
// prefers-reduced-motion has its own rules. Part of the feature checks (desktop/smoke-features.js).

import { writeFile } from 'node:fs/promises';
import { until } from './smoke-wait.js';
import { secondVault } from './smoke-second-vault.js';

const AREA = 'droptarget';
const ENTRY = 'Smoke Drop Eintrag';
const FOLDER = 'Smoke Drop Ordner';
const MOVE_HERE = /^(Hierher verschieben|Move here)$/;
const PERSONAL_REASON = /persönlichen Tresor|personal vault|gesperrt|locked/;

export async function dropTargetCheck({ js, sleep, fail, save, vault, api, kvc, win }) {
  const second = await secondVault({ vault, api, kvc });
  try {
    return await dropTargets({ js, sleep, fail, save, vault, kvc, win, target: second.target });
  } finally {
    await second.done();
  }
}

async function dropTargets({ js, sleep, fail, save, vault, kvc, win, target }) {
  if (!target) return fail(AREA, 'no second vault with write access in the demo');
  const personal = (await vault.containers()).find((c) => c.personal);
  const entry = await save({ type: 'login', title: ENTRY, username: 'drop', password: 'Drop-1' });
  await save({ type: 'login', title: 'Smoke Drop im Ordner', username: 'drop2', password: 'Drop-2', folder: FOLDER });
  const navRow = (id) => `document.querySelector(${JSON.stringify(`.sidebar .nav-row[data-vault="${id}"]`)})`;
  const entryRow = `[...document.querySelectorAll(".list li.row-item[data-key]")].find((r) => r.querySelector(".row-title")?.firstChild?.textContent.trim() === ${JSON.stringify(ENTRY)})`;
  const folderRow = `[...document.querySelectorAll(".list .folder-row")].find((r) => r.querySelector(".row-title")?.textContent === ${JSON.stringify(FOLDER)})`;
  // The vault's root with the entry and the folder on screen.
  await js(`${navRow(kvc.id)}?.querySelector(".nav")?.click()`);
  await sleep(400);
  await js('document.querySelector(".folder-crumb .icon-btn")?.click()');
  if (!(await until(() => js(`!!${entryRow} && !!${folderRow}`), 6000))) return fail(AREA, 'entry or folder of the check not in the list');

  // One drag for all targets: the DataTransfer stays on the page between the calls.
  await js(`(() => { window.__dropDt = new DataTransfer(); ${entryRow}.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__dropDt })); return true; })()`);
  const over = (el) => js(`(() => {
    const el = ${el};
    if (!el) return { missing: true };
    const e = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: window.__dropDt });
    el.dispatchEvent(e);
    const s = getComputedStyle(el);
    return { taken: e.defaultPrevented, drop: el.classList.contains("drop"), blocked: el.classList.contains("drop-blocked"), label: el.dataset.dropLabel || "", title: el.title || "",
      // Radius and outline, not the background: a hidden window does not run the background's transition.
      painted: s.borderRadius !== "0px" && s.outlineStyle !== "none" };
  })()`);
  const leave = (el) => js(`(() => { const el = ${el}; el?.dispatchEvent(new DragEvent("dragleave", { bubbles: true, dataTransfer: window.__dropDt })); return !!el && !el.classList.contains("drop") && !el.classList.contains("drop-blocked") && !el.dataset.dropLabel; })()`);

  // Another vault: lights up with "Hierher verschieben" and takes the drop.
  let r = await over(navRow(target.id));
  if (r.missing) fail(AREA, `sidebar row of "${target.name}" missing`);
  else if (!r.taken || !r.drop || !MOVE_HERE.test(r.label)) fail(AREA, `other vault not marked as target: ${JSON.stringify(r)}`);
  // The class alone is not enough: until #491 a broken rule above swallowed the sidebar's drop style (class set, nothing shown).
  else if (!r.painted) fail(AREA, `other vault marked but its drop style does not apply: ${JSON.stringify(r)}`);
  // KVPWSAFE_DROP_SHOT=<png>: a picture of the lit-up target for the design review.
  if (process.env.KVPWSAFE_DROP_SHOT && win) {
    // A hidden window runs no transitions or animations: the picture shows their end state.
    const still = await win.webContents.insertCSS('*, *::after { transition: none !important; animation: none !important; }');
    win.webContents.invalidate(); // a hidden window paints only on request
    await sleep(600);
    await writeFile(process.env.KVPWSAFE_DROP_SHOT, (await win.webContents.capturePage()).toPNG());
    await win.webContents.removeInsertedCSS(still);
  }
  if (!(await leave(navRow(target.id)))) fail(AREA, 'mark of the other vault stayed after dragleave');

  // The entry's own vault: no target, no mark.
  r = await over(navRow(kvc.id));
  if (r.taken || r.drop || r.blocked) fail(AREA, `own vault reacted to its own entry: ${JSON.stringify(r)}`);

  // The personal vault refuses entries of a shared vault, with the reason.
  if (!personal) fail(AREA, 'no personal vault in the demo (the area needs "personal")');
  else {
    r = await over(navRow(personal.id));
    if (r.taken || !r.blocked || !r.painted || !PERSONAL_REASON.test(r.title) || r.label !== r.title) fail(AREA, `personal vault not shown as forbidden with a reason: ${JSON.stringify(r)}`);
    if (!(await leave(navRow(personal.id)))) fail(AREA, 'blocked mark of the personal vault stayed after dragleave');
  }

  // Drop onto the other vault: mark gone, pulse, the confirmation as before (cancelled here: the entry stays).
  await over(navRow(target.id));
  r = await js(`(() => { const el = ${navRow(target.id)}; el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__dropDt })); return { drop: el.classList.contains("drop"), done: el.classList.contains("drop-done") }; })()`);
  if (r.drop || !r.done) fail(AREA, `drop on the vault: mark not replaced by the pulse: ${JSON.stringify(r)}`);
  if (!(await until(() => js('!!document.querySelector("dialog[open]")'), 3000))) fail(AREA, 'no confirmation after the drop on the vault');
  await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click()); true');
  await sleep(900);
  if ((await vault.summaries()).find((x) => x.id === entry.id)?.containerId !== kvc.id) fail(AREA, 'entry left its vault although the confirmation was cancelled');
  if (await js('!!document.querySelector(".drop, .drop-blocked, .drop-done")')) fail(AREA, 'a drop mark or the pulse stayed after the drop');

  // Folder tree: the folder row lights up and takes the entry; after the drop the pulse, then the entry is in it.
  await js(`(() => { window.__dropDt = new DataTransfer(); ${entryRow}?.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: window.__dropDt })); return true; })()`);
  r = await over(folderRow);
  if (r.missing || !r.taken || !r.drop || !r.painted || !MOVE_HERE.test(r.label)) fail(AREA, `folder row not marked as target: ${JSON.stringify(r)}`);
  if (!(await leave(folderRow))) fail(AREA, 'mark of the folder row stayed after dragleave');
  await over(folderRow);
  r = await js(`(() => { const el = ${folderRow}; el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: window.__dropDt })); return { drop: el.classList.contains("drop"), done: el.classList.contains("drop-done") }; })()`);
  if (r.drop || !r.done) fail(AREA, `drop on the folder: mark not replaced by the pulse: ${JSON.stringify(r)}`);
  if (!(await until(async () => (await vault.summaries()).find((x) => x.id === entry.id)?.folder === FOLDER, 4000))) fail(AREA, 'entry did not move into the folder');

  // A drag that ends anywhere leaves no mark behind.
  await js(`(() => { const dt = new DataTransfer(); const row = document.querySelector(".list li.row-item[data-key]"); row?.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt })); ${navRow(target.id)}?.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt })); row?.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt })); return true; })()`);
  if (await js('!!document.querySelector(".drop, .drop-blocked")')) fail(AREA, 'a mark stayed after dragend');

  // prefers-reduced-motion: no lift and no moving pulse.
  const still = await js(`[...document.styleSheets].flatMap((s) => { try { return [...s.cssRules]; } catch { return []; } })
    .filter((x) => x.media && /prefers-reduced-motion/.test(x.media.mediaText)).map((x) => x.cssText).join(" ")`);
  if (!/\.drop-done/.test(still) || !/\.nav-row\.drop/.test(still)) fail(AREA, 'no prefers-reduced-motion rules for the drop targets');
  await js('delete window.__dropDt; true');
  return undefined;
}
