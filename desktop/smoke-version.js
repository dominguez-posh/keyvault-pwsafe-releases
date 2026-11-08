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

export async function versionChannelCheck({ js, sleep, fail, config, changed }) {
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
    await js('document.querySelectorAll("dialog[open] .modal-head .icon-btn").forEach((b) => b.click())');
    const back = await read('stable');
    if (back.channel !== 'Stable' || back.early) fail('versionchannel', `switching back without a restart did not show Stable (${JSON.stringify(back)})`);
  } finally {
    overrideBuildKindForSmoke(null);
    config.update({ updateChannel: before });
    changed();
    await sleep(400);
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
