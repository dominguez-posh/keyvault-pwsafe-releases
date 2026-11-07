// Smoke check of the multi-selection (#330): "Clear selection" in the detail pane and in the context menu really clears
// the rows. It used to call a function that does not exist there, so the marks stayed until the next redraw. Part of
// the feature checks (desktop/smoke-features.js), which have reached their size limit.

const SELECTED = 'document.querySelectorAll(".list li.row-item.multi").length';
const NO_SELECTION = `${SELECTED} === 0 && !document.querySelector(".multi-selection")`;

export async function multiClearCheck({ js, sleep, fail, vaultName }) {
  await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => /Alle Einträge|All entries|All items/.test(n.textContent))?.click()');
  await sleep(400);
  const select = async () => {
    await js('document.querySelectorAll(".list li.row-item[data-key]")[0]?.click()');
    await sleep(200);
    await js('document.querySelectorAll(".list li.row-item[data-key]")[2]?.dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true }))');
    await sleep(300);
    return js(SELECTED);
  };

  let count = await select();
  if (count !== 3) fail('multiclear', `expected 3 selected rows before the detail pane's button, got ${count}`);
  await js('[...document.querySelectorAll(".multi-selection .actions button")].pop()?.click()');
  await sleep(300);
  if (!(await js(NO_SELECTION))) fail('multiclear', `"Clear selection" in the detail pane did not clear (${await js(SELECTED)} rows still marked)`);

  count = await select();
  if (count !== 3) fail('multiclear', `expected 3 selected rows before the context menu, got ${count}`);
  await js('document.querySelector(".list li.row-item.multi")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }))');
  await sleep(200);
  if (!(await js('!!document.querySelector(".context-menu [data-action=multi-clear]")'))) fail('multiclear', 'context menu without "Clear selection"');
  await js('document.querySelector(".context-menu [data-action=multi-clear]")?.click()');
  await sleep(300);
  if (!(await js(NO_SELECTION))) fail('multiclear', `"Clear selection" in the context menu did not clear (${await js(SELECTED)} rows still marked)`);
  // Back to the vault: the following feature checks start from its list.
  await js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(vaultName)}))?.click()`);
  await sleep(400);
}
