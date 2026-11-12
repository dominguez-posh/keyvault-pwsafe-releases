// Smoke check: "Infos" directly in the right-click menu of a Key Vault, not in a submenu. Part of the feature checks
// (desktop/smoke-features.js). #353: waits for the row and the drawn menu instead of a fixed pause.

import { until } from './smoke-wait.js';

export async function vaultMenuCheck({ js, fail, kvc }) {
  // #353: wait for the row and for the drawn menu (a fixed pause, or a row not drawn yet, made this check unsteady).
  const vaultRow = `[...document.querySelectorAll(".sidebar .nav-row")].find((r) => r.textContent.includes(${JSON.stringify(kvc.name)}))`;
  if (!(await until(() => js(`!!(${vaultRow})`), 8000))) return fail('vaultmenu', `no sidebar row for the vault "${kvc.name}"`);
  await js(`(() => { (${vaultRow}).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); })()`);
  if (!(await until(() => js('!!document.querySelector(".context-menu [data-action]")'), 8000))) return fail('vaultmenu', 'the right-click menu of the vault did not open');
  const r = JSON.parse(await js('JSON.stringify({ top: !!document.querySelector(".context-menu > [data-action=info], .context-menu > .context-group > [data-action=info]"), sub: !!document.querySelector(".context-sub [data-action=info]") })'));
  if (!r.top || r.sub) fail('vaultmenu', `"Infos" not at the top of the vault menu (${JSON.stringify(r)})`);
  await js('document.querySelector(".context-menu")?.remove()');
  return undefined;
}
