// Extension smoke, part (#463): Microsoft's password page with the name already entered. Like the real page it keeps
// the name as an invisible copy for password managers (class moveOffScreen: opacity 0, but with a size, before the
// password field). The login chosen in the field menu under the password field must fill the password, send it and
// type the one-time code on the next page – never the invisible copy, and without waiting for a page change.

const USER = 'mspw@smoke.example';

export const msPasswordPage = `<!doctype html><meta charset="utf-8"><title>Kennwort eingeben</title>
<style>.moveOffScreen{position:fixed;bottom:0;right:0;height:0 !important;width:0 !important;overflow:hidden;opacity:0}
input[type=text],input[type=password],input[type=tel]{padding:4px 8px;border:2px solid #888;height:32px}</style>
<form onsubmit="return false"><div id="displayName">${USER}</div>
<input type="text" name="loginfmt" class="moveOffScreen" tabindex="-1" aria-hidden="true" value="${USER}">
<div id="pwView"><div role="heading" id="loginHeader">Kennwort eingeben</div><input name="passwd" type="password" id="i0118" autocomplete="current-password" placeholder="Kennwort"></div>
<div id="otcView" style="display:none"><input name="otc" type="tel" id="idTxtBx_SAOTCC_OTC" autocomplete="one-time-code" placeholder="Code"></div>
<input type="submit" id="idSIButton9" value="Anmelden"></form>
<script>
window.signedIn = {};
document.querySelector('[name=loginfmt]').addEventListener('input', () => { signedIn.hiddenName = true; });
document.getElementById('idSIButton9').addEventListener('click', () => {
  const pw = document.querySelector('[name=passwd]');
  if (document.getElementById('otcView').style.display === 'none') {
    signedIn.password = pw.value;
    if (!pw.value) return;
    document.getElementById('pwView').style.display = 'none';
    document.getElementById('otcView').style.display = '';
  } else signedIn.otc = document.querySelector('[name=otc]').value;
});
</script>`;

export async function checkMsPasswordPage({ send, evaluate, open, waitFor, check, sleep, sw, port, sessionId, personal }) {
  const saved = await sw(sessionId, 'save', { containerId: personal.id, item: { type: 'login', title: 'Smoke MS Kennwort', username: USER,
    password: 'MsPw-Smoke-1', totp: 'JBSWY3DPEHPK3PXP', urls: ['https://login.microsoftonline.com/'] } });
  // No remembered account may sign in by itself on this page: only the menu's choice counts here.
  await evaluate(sessionId, 'chrome.storage.local.set({ msDefault: null }).then(() => true)');
  const page = await open(`http://login.microsoftonline.com:${port}/mspw`);
  const s = page.sessionId;
  try {
    await send('Page.bringToFront', {}, s);
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
    await sleep(1500);
    const findAll = (n, ok, acc = []) => { if (ok(n)) acc.push(n); for (const c of (n.children || []).concat(n.shadowRoots || [])) findAll(c, ok, acc); return acc; };
    const attrsOf = (n) => Object.fromEntries((n.attributes || []).reduce((acc, v, i, a) => (i % 2 ? acc : [...acc, [v, a[i + 1]]]), []));
    const click = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, s); };
    let result = null;
    let state = null;
    for (let attempt = 0; attempt < 3 && !result; attempt++) {
      const field = await evaluate(s, '(() => { const r = document.querySelector("[name=passwd]").getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()');
      await click(field.x, field.y);
      await sleep(1200);
      const tree = await send('DOM.getDocument', { depth: -1, pierce: true }, s);
      const menu = findAll(tree.root, (n) => n.nodeName === 'DIV' && attrsOf(n).class === 'menu')[0];
      // The entry's texts are drawn by CSS from data-t (#383).
      const entry = menu && findAll(menu, (n) => n.nodeName === 'BUTTON' && attrsOf(n).class === 'entry')
        .find((b) => findAll(b, (n) => (attrsOf(n)['data-t'] || '').includes(USER)).length);
      state = { menu: !!menu, entry: !!entry, focused: await evaluate(s, 'document.activeElement?.name || document.activeElement?.tagName') };
      if (!entry) continue;
      const { model } = await send('DOM.getBoxModel', { nodeId: entry.nodeId }, s);
      await click((model.border[0] + model.border[4]) / 2, (model.border[1] + model.border[5]) / 2);
      result = await waitFor(async () => { const r = await evaluate(s, 'signedIn'); return r.otc && r; }, 8000);
      if (!result) state.signedIn = await evaluate(s, 'signedIn');
    }
    check(result?.password === 'MsPw-Smoke-1', `#463 Microsoft-Kennwortseite: Passwort aus dem Feldmenü nicht eingetragen (${JSON.stringify(state)})`);
    check(/^\d{6}$/.test(result?.otc || ''), '#463 Microsoft-Kennwortseite: Einmalcode nach dem Passwort nicht eingetragen');
    check(!result?.hiddenName, '#463 Microsoft-Kennwortseite: unsichtbare Namenskopie gefüllt');
  } finally {
    await send('Target.closeTarget', { targetId: page.targetId }).catch(() => {});
    await sw(sessionId, 'delete', { containerId: personal.id, id: saved?.id }).catch(() => {});
  }
}
