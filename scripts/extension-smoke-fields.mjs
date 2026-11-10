// Extension smoke, part (#502): the field menu only in real sign-in fields. One page with a search box, a login form, a
// contact form (name, e-mail, a field named "account", a textarea) and a newsletter box; the site has a saved login, so
// a wrongly counted field would show the menu with it. Real clicks through CDP (trusted), each field on its own.

export const fieldsPage = `<!doctype html><meta charset="utf-8"><title>Felder</title>
<style>input,textarea{display:block;margin:12px 0;width:260px;height:28px}textarea{height:60px}</style>
<form role="search" onsubmit="return false"><input type="search" name="q" id="search" placeholder="Suchen"></form>
<form id="login" onsubmit="return false"><input type="email" name="email" id="user" autocomplete="email" placeholder="E-Mail">
<input type="password" name="password" id="pw" autocomplete="current-password" placeholder="Kennwort"><button>Anmelden</button></form>
<form id="contact" onsubmit="return false"><input name="name" id="cname" placeholder="Name"><input type="email" name="email" id="cmail" placeholder="E-Mail">
<input name="account" id="caccount" placeholder="Kundenkonto (optional)"><textarea name="message" id="cmsg" placeholder="Nachricht"></textarea><button>Senden</button></form>
<form id="news" onsubmit="return false"><input type="email" name="newsletter" id="news" placeholder="Newsletter: Ihre E-Mail"><button>Abonnieren</button></form>`;

const POSITIVE = ['user', 'pw'];
const NEGATIVE = ['search', 'cname', 'cmail', 'caccount', 'cmsg', 'news'];

export async function checkFieldKinds({ send, open, sw, waitFor, check, sleep, shadowNode, sessionId, personal, port }) {
  const saved = await sw(sessionId, 'save', { containerId: personal.id, item: { type: 'login', title: 'Smoke 502', username: 'f502',
    password: 'F502-Smoke-1', urls: [`http://router-smoke.example:${port}/`] } });
  const tab = await open(`http://router-smoke.example:${port}/fields`);
  const s = tab.sessionId;
  try {
    await send('Page.bringToFront', {}, s);
    await send('Emulation.setFocusEmulationEnabled', { enabled: true }, s);
    await sleep(1500);
    const inPage = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true }, s)).result.value;
    const menu = () => shadowNode(s, 'kvpwsafe-ui', '.menu');
    const press = async (id) => {
      await inPage('document.activeElement?.blur(), true');
      await waitFor(async () => !(await menu()), 2000);
      await inPage(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({ block: 'center' }), true`);
      const box = await inPage(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 }, s);
    };
    for (const id of POSITIVE) {
      await press(id);
      check(!!(await waitFor(menu, 4000)), `#502 Feldmenü: kein Vorschlag im Anmeldefeld ${id}`);
    }
    for (const id of NEGATIVE) {
      await press(id);
      await sleep(1200);
      check(!(await menu()), `#502 Feldmenü: Vorschlag im Feld ${id}, das keine Anmeldung ist`);
    }
  } finally {
    await send('Target.closeTarget', { targetId: tab.targetId }).catch(() => {});
    await sw(sessionId, 'delete', { containerId: personal.id, id: saved?.id }).catch(() => {});
  }
}
