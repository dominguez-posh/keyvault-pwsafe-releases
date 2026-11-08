// Smoke check of the section headings in the sidebar (#471): "Tresore" and the other .nav-section headers are labels and
// can't be marked (user-select: none); the vault search field in the header still takes input. Part of the feature checks
// (desktop/smoke-features.js), which have reached their size limit.

import { until } from './smoke-wait.js';

export async function headingCheck(ctx) {
  const { js, fail } = ctx;
  const sections = await js('[...document.querySelectorAll(".sidebar .nav-section")].map((n) => getComputedStyle(n).userSelect)');
  if (!sections?.length) {
    fail('sidebar has no section heading');
    return;
  }
  if (sections.some((s) => s !== 'none')) fail(`section heading can be marked: ${JSON.stringify(sections)}`);
  if (!(await js('!!document.querySelector(".nav-section .vault-find .icon-btn")'))) {
    fail('magnifier in the vault header missing');
    return;
  }
  try {
    await js('document.querySelector(".nav-section .vault-find .icon-btn").click(); true');
    if (!(await until(() => js('!!document.querySelector(".nav-section .vault-find input")?.offsetParent'), 3000))) {
      fail('vault search field did not open');
      return;
    }
    const field = await js(`(() => {
      const q = document.querySelector(".nav-section .vault-find input");
      q.focus(); q.value = "Team"; q.dispatchEvent(new Event("input"));
      q.setSelectionRange(0, q.value.length);
      return { select: getComputedStyle(q).userSelect, value: q.value, marked: q.selectionEnd - q.selectionStart, focused: document.activeElement === q };
    })()`);
    if (field.select === 'none' || field.value !== 'Team' || field.marked !== 4 || !field.focused) fail(`vault search field in the heading not usable: ${JSON.stringify(field)}`);
  } finally {
    await js('document.querySelector(".vault-find input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true');
    await new Promise((r) => setTimeout(r, 300));
  }
}
