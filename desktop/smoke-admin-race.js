// Smoke check of #535 (part of the adminpin area; desktop/smoke-features.js is at its size limit): the window reloads
// (as after a sync) while admin mode is being switched. Before, `st.settings = await …` put the answer on the state
// object the reload had just replaced: the main process had admin mode on, the switch next to Help showed it off – and
// the full smoke run found no way to switch it off again. The switch must show what the main process has.

const AREA = 'adminpin';

export async function adminRaceCheck({ js, sleep, config, changed, ensurePin, pinGuard, fail }) {
  const pin = await ensurePin();
  if (!config.get().adminOffered) { config.update({ adminOffered: true }); changed(); }
  const shown = () => js('document.querySelector(".sidebar-foot .admin-switch")?.getAttribute("aria-checked") || ""');
  // One reload started together with the click: its state comes back while the PIN is still checked. No reload after
  // the answer – a later one fetched fresh settings and hid the error.
  for (const on of [true, false]) {
    let switched = false;
    for (let i = 0; i < 20 && !switched; i++) {
      switched = await js(`!!document.querySelector(".sidebar-foot [data-action=${on ? 'admin-on' : 'admin-off'}]")`);
      if (!switched) await sleep(250);
    }
    if (!switched) return fail(AREA, `#535: no switch to turn admin mode ${on ? 'on' : 'off'} (shown: ${await shown()}, main: ${config.get().adminTools})`);
    await js('document.querySelector(".main-menu, .context-menu")?.remove(); true');
    if (on) {
      await js('document.querySelector(".sidebar-foot [data-action=admin-on]")?.click(); true');
      for (let i = 0; i < 10 && !(await js('!!document.querySelector("dialog[open] .admin-pin")')); i++) await sleep(150);
      await js(`(() => { document.querySelector("dialog[open] .admin-pin").value = ${JSON.stringify(pin)}; window.dispatchEvent(new Event("kvpwsafe-refresh")); document.querySelector("dialog[open] .modal-footer .btn.primary").click(); return true; })()`);
    } else {
      await js(`(() => { window.dispatchEvent(new Event("kvpwsafe-refresh")); document.querySelector(".sidebar-foot [data-action=admin-off]").click(); return true; })()`);
    }
    for (let i = 0; i < 20 && config.get().adminTools !== on; i++) await sleep(150);
    if (on && pinGuard.consume()) fail(AREA, '#535: the PIN left an unlock token behind'); // 0.9.33 review
    if (config.get().adminTools !== on) return fail(AREA, `#535: admin mode not switched ${on ? 'on' : 'off'} in the main process`);
    // The reload and the answer are both in by now.
    await sleep(1500);
    const now = await shown();
    if (now !== String(on)) return fail(AREA, `#535: after a reload during the switch the window shows admin mode ${now === 'true' ? 'on' : 'off'}, the main process has it ${on ? 'on' : 'off'}`);
  }
  return undefined;
}
