// Smoke check of the version label at the bottom right (#389): "Keevault <version> · Stable" or "· Early Access",
// taken from the effective update channel; a change shows without a restart; the label stays on one line inside the
// window. Part of the feature checks (desktop/smoke-features.js), which have reached their size limit.

import { MIN_EXTENSION_VERSION } from './versions.js';
import { overrideBuildKindForSmoke } from './build-kind.js';

const LABEL = `(() => {
  const v = document.getElementById("app-version");
  if (!v) return JSON.stringify({ missing: true });
  const r = v.getBoundingClientRect(), ch = v.querySelector(".ver-channel");
  return JSON.stringify({
    text: v.textContent, channel: ch?.textContent || "", early: v.classList.contains("early-access"),
    accent: ch ? getComputedStyle(ch).color !== getComputedStyle(v).color : false,
    inside: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
    oneLine: r.height < 30, noOverflow: v.scrollWidth <= v.clientWidth + 1,
  });
})()`;

export async function versionChannelCheck({ js, sleep, fail, config, changed, hello }) {
  const before = config.get().updateChannel || 'stable';
  // The smoke runs a Developer build, whose label hides the channel (#445, checked in "buildkind"): for this check the build counts as a release.
  overrideBuildKindForSmoke({ developer: false, commit: '' });
  const read = async (channel) => {
    config.update({ updateChannel: channel });
    changed();
    let r = {};
    for (let i = 0; i < 12; i++) {
      await sleep(250);
      r = JSON.parse(await js(LABEL));
      if (r.channel === (channel === 'beta' ? 'Early Access' : 'Stable')) break;
    }
    return r;
  };
  try {
    const stable = await read('stable');
    if (!/^Keevault \d+\.\d+\.\d+\S* · Stable$/.test(stable.text || '') || stable.early || stable.accent) fail('versionchannel', `Stable label wrong (${JSON.stringify(stable)})`);
    const beta = await read('beta');
    if (!/^Keevault \d+\.\d+\.\d+\S* · Early Access$/.test(beta.text || '') || !beta.early || !beta.accent) fail('versionchannel', `Early Access label wrong or not highlighted (${JSON.stringify(beta)})`);
    for (const [name, r] of [['Stable', stable], ['Early Access', beta]]) {
      if (!r.inside || !r.oneLine || !r.noOverflow) fail('versionchannel', `${name} label overflows the layout (${JSON.stringify(r)})`);
    }
    // The real way: Settings → Update channel → Save (renders again; an error here is a product error).
    config.update({ updateChannel: 'stable' });
    changed();
    await sleep(800);
    await js('document.querySelector(".menu-btn")?.click()');
    await sleep(300);
    await js('document.querySelector(".main-menu [data-action=settings]")?.click()');
    await sleep(600);
    await js('(() => { const s = document.querySelector("dialog[open] select[name=updateChannel]"); if (s) { s.value = "beta"; s.dispatchEvent(new Event("change", { bubbles: true })); } })()');
    await js('document.querySelector("dialog[open] .modal-footer .btn.primary")?.click()');
    let viaSettings = {};
    for (let i = 0; i < 12 && viaSettings.channel !== 'Early Access'; i++) {
      await sleep(300);
      viaSettings = JSON.parse(await js(LABEL));
    }
    if (viaSettings.channel !== 'Early Access' || !viaSettings.early) fail('versionchannel', `saving Early Access in the settings did not change the label (${JSON.stringify(viaSettings)}, saved=${config.get().updateChannel})`);
    await earlyAccessThanksCheck({ js, sleep, fail });
    if (hello && (await hello({})).stage !== 'beta') fail('versionchannel', 'hello does not tell the extension the stage "beta" in Early Access (#420)');
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click())');
    const back = await read('stable');
    if (back.channel !== 'Stable' || back.early) fail('versionchannel', `switching back without a restart did not show Stable (${JSON.stringify(back)})`);
    if (hello && (await hello({})).stage !== 'stable') fail('versionchannel', 'hello does not tell the extension the stage "stable" (#420)');
    await devStageCheck({ js, sleep, fail, config, changed, hello });
  } finally {
    overrideBuildKindForSmoke(null);
    config.update({ updateChannel: before });
    changed();
    await sleep(400);
  }
}

const openSettings = async (js, sleep) => {
  await js('document.querySelector(".menu-btn")?.click()');
  await sleep(300);
  await js('document.querySelector(".main-menu [data-action=settings]")?.click()');
  for (let i = 0; i < 12 && !(await js('!!document.querySelector("dialog[open].settings-modal")')); i++) await sleep(250);
};
const closeDialogs = (js) => js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click())');

/** #420: saving the switch to Early Access thanks the user and names the way to report a bug; "Verstanden" closes it. */
async function earlyAccessThanksCheck({ js, sleep, fail }) {
  let r = {};
  for (let i = 0; i < 12 && !r.open; i++) {
    await sleep(250);
    r = JSON.parse(await js(`(() => { const d = document.querySelector("dialog[open].ea-thanks-modal");
      return JSON.stringify({ open: !!d, text: d?.textContent || "", buttons: d ? [...d.querySelectorAll(".modal-footer .btn")].map((b) => b.textContent) : [] }); })()`));
  }
  if (!r.open) return fail('versionchannel', 'switching to Early Access in the settings showed no thank-you popup (#420)');
  if (!/Bug melden|Report a bug/.test(r.buttons.join('|')) || !/Hilfe|Help/.test(r.text)) fail('versionchannel', `the Early Access popup does not say how to report a bug (${JSON.stringify(r)})`);
  await js('[...document.querySelectorAll("dialog[open].ea-thanks-modal .modal-footer .btn")].pop()?.click()');
  await sleep(300);
  if (await js('!!document.querySelector("dialog[open].ea-thanks-modal")')) fail('versionchannel', 'the Early Access popup does not close with its button');
}

/**
 * #420: a Dev build (kvBuild.kind "dev") shows "Dev Version", offers no channel choice, ignores the setting (also a value
 * that came from a policy or another device) and tells the extension the stage "dev".
 */
async function devStageCheck({ js, sleep, fail, config, changed, hello }) {
  overrideBuildKindForSmoke({ developer: false, dev: true, commit: '' });
  try {
    config.update({ updateChannel: 'beta' });
    changed();
    let r = {};
    for (let i = 0; i < 12 && r.channel !== 'Dev Version'; i++) {
      await sleep(250);
      r = JSON.parse(await js(LABEL));
    }
    if (!/^Keevault \d+\.\d+\.\d+\S* · Dev Version$/.test(r.text || '') || r.early || !r.accent) fail('versionchannel', `Dev label wrong (${JSON.stringify(r)})`);
    if (!r.inside || !r.oneLine || !r.noOverflow) fail('versionchannel', `Dev label overflows the layout (${JSON.stringify(r)})`);
    if (hello && (await hello({})).stage !== 'dev') fail('versionchannel', 'a Dev build does not tell the extension the stage "dev"');
    await openSettings(js, sleep);
    const s = JSON.parse(await js(`JSON.stringify({ open: !!document.querySelector("dialog[open].settings-modal"),
      select: !!document.querySelector("dialog[open] select[name=updateChannel]"), note: !!document.querySelector("dialog[open] #dev-stage-note") })`));
    if (!s.open) fail('versionchannel', 'settings did not open in the Dev build');
    else if (s.select || !s.note) fail('versionchannel', `a Dev build offers the update channel choice (${JSON.stringify(s)})`);
    // Saving the settings must leave the stored channel alone (the Dev build sends none, and the app ignores one).
    config.update({ updateChannel: 'stable' });
    await js('document.querySelector("dialog[open].settings-modal .modal-footer .btn.primary")?.click()');
    await sleep(800);
    if (await js('!!document.querySelector("dialog[open].ea-thanks-modal")')) fail('versionchannel', 'a Dev build showed the Early Access popup');
    if (config.get().updateChannel !== 'stable') fail('versionchannel', 'saving the settings in a Dev build changed the update channel');
  } finally {
    await closeDialogs(js);
    overrideBuildKindForSmoke(null);
  }
}

/** Part of the "devices" area of the feature checks. */
export async function versionMixCheck(ctx, fail, clipboardHas) {
  // Version mix (#347): the app names its capabilities; an extension without a usable version claim gets the hint, one
  // with a current claim does not (the claim steers the hint only, never the copy above).
  const helloNew = { extVersion: MIN_EXTENSION_VERSION };
  const helloOld = {};
  const helloOdd = { extVersion: '0.9.x' };
  if (!(await ctx.browserHello(helloNew)).caps?.includes('copy')) fail('devices', 'hello without the copy capability');
  if (helloNew.hinted) fail('devices', 'extension with a current version got the outdated hint');
  await ctx.browserHello(helloOld);
  if (!helloOld.hinted) fail('devices', 'extension without a version got no outdated hint');
  if (!ctx.noteExtension({ extVersion: '0.9.26' }) || ctx.noteExtension({ extVersion: '0.9.100' }) || !ctx.noteExtension(helloOdd)) fail('devices', 'extension version comparison wrong (numeric, odd claims count as outdated)');
  if (!(await ctx.browserCopy('kv-smoke-ext-copy2')) || !(await clipboardHas('kv-smoke-ext-copy2'))) fail('devices', 'a version claim changed how the app copies');
}
