// Smoke check of the sharing hint in the members view of a file vault (#446): shared file vaults protect against outsiders,
// not against a member with write access to the share; for teams with separate rights Key Vault is recommended. The hint
// is a calm info notice (no warning colour), permanently in the members view. Part of the feature checks
// (desktop/smoke-features.js), which have reached their size limit.

import { until } from './smoke-wait.js';

export async function shareHintCheck(ctx) {
  try {
    await check(ctx);
  } finally {
    // Close the members dialog and go back to the demo vault: new entries of the next areas land in the selected vault.
    await ctx.js("document.querySelector('dialog[open]')?.close(); true");
    await new Promise((r) => setTimeout(r, 200));
    if (ctx.home) await ctx.js(`[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes(${JSON.stringify(ctx.home)}))?.click(); true`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function check(ctx) {
  const { js, fail } = ctx;
  await js('[...document.querySelectorAll(".sidebar .nav")].find((n) => n.textContent.includes("Team-Datei"))?.click(); true');
  await until(() => js('!!document.querySelector(".sidebar .nav-row.active")'), 3000);
  await js('document.querySelector(".sidebar .nav-row.active")?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 120, clientY: 300 })); true');
  await until(() => js('!!document.querySelector(".context-menu [data-action=members]")'), 3000);
  await js('document.querySelector(".context-menu [data-action=members]")?.click(); true');
  if (!(await until(() => js('!!document.querySelector("dialog[open] .members")'), 4000))) {
    fail('members view of the file vault did not open');
    return;
  }
  const hint = await js('(() => { const n = document.querySelector("dialog[open] .members .share-hint"); return n ? { text: n.textContent, info: n.classList.contains("info"), warn: n.classList.contains("error") } : null; })()');
  if (!hint) fail('members view of a file vault has no sharing hint');
  else if (!/Key Vault/.test(hint.text) || !hint.info || hint.warn) fail(`sharing hint is wrong or not calm: ${JSON.stringify(hint)}`);
}
