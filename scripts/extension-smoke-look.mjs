// Extension smoke, part (#509): the popup has the look of the app imitated with tokens (gradient and grain on the ground,
// translucent blurred surfaces), stays readable in light and dark, and goes flat when less transparency is asked for.

// Runs in the page: composite the surface colour of the list over the ground colour and measure text against it.
export const MEASURE = `(() => {
  const cx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  cx.canvas.width = cx.canvas.height = 1;
  // canvas turns every notation (also color-mix results) into plain channels
  const parse = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a) });
  const list = document.querySelector('.view .list');
  const ground = parse(getComputedStyle(document.body).backgroundColor);
  // worst case under the glass: the strongest gradient tint (the brand blue at 16 %) on the ground colour
  const probe = document.createElement('i');
  probe.style.background = 'var(--accent)';
  document.body.append(probe);
  const accent = parse(getComputedStyle(probe).backgroundColor);
  probe.remove();
  const behind = over({ ...accent, a: .16 }, { ...ground, a: 1 });
  const glass = over(parse(getComputedStyle(list).backgroundColor), behind);
  const title = parse(getComputedStyle(document.querySelector('.row-title') || list).color);
  const sub = parse(getComputedStyle(document.querySelector('.row-sub') || list).color);
  const cs = getComputedStyle(list);
  return JSON.stringify({ title: ratio(title, glass), sub: ratio(sub, glass), blur: cs.backdropFilter, bg: getComputedStyle(document.body).backgroundImage.includes('gradient'),
    grain: getComputedStyle(document.body, '::before').backgroundImage.includes('grain.svg'), grainDisplay: getComputedStyle(document.body, '::before').display, alpha: parse(cs.backgroundColor).a });
})()`;

export async function checkLook({ send, evaluate, waitFor, check, popup }) {
  const s = popup.sessionId;
  const ev = async () => JSON.parse(await evaluate(s, MEASURE));
  const media = (features) => send('Emulation.setEmulatedMedia', { features }, s);
  try {
    for (const scheme of ['light', 'dark']) {
      await media([{ name: 'prefers-color-scheme', value: scheme }]);
      await waitFor(() => evaluate(s, '!!document.querySelector(".row-item")'));
      const m = await ev();
      check(m.bg && m.grain, `Popup (${scheme}): Verlauf oder Körnung fehlt`);
      check(m.blur && m.blur !== 'none' && m.alpha > 0.5 && m.alpha < 1, `Popup (${scheme}): Liste ist nicht halbtransparent mit Unschärfe (${m.blur}, ${m.alpha})`);
      check(m.title >= 4.5 && m.sub >= 4.5, `Popup (${scheme}): Text auf dem Milchglas zu kontrastarm (Titel ${m.title.toFixed(2)}, Nebentext ${m.sub.toFixed(2)})`);
    }
    // Less transparency asked for (where the browser knows the setting): flat surfaces, no blur, no grain.
    await media([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-transparency', value: 'reduce' }]);
    if (await evaluate(s, 'matchMedia("(prefers-reduced-transparency: reduce)").matches')) {
      const m = await ev();
      check(m.alpha === 1 && (!m.blur || m.blur === 'none') && m.grainDisplay === 'none',
        `Popup: mit weniger Transparenz bleibt Glas oder Körnung (${m.alpha}, ${m.blur}, ${m.grainDisplay})`);
    }
  } finally {
    await send('Emulation.setEmulatedMedia', { features: [] }, s);
  }
}
