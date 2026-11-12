// #534: the PIN view with the first paint. A classic script without imports, run while popup.html is parsed – long before
// popup.js and its modules are loaded. When the last fresh state was "app running, locked, PIN set" (popup/locked.js,
// rememberState, chrome.storage.session), it puts the same lock view as renderLocked over the loading state, with the
// field focused. Nothing leaves this page here: a PIN sent now is only held (data-held); popup.js takes the field over
// (renderLocked with pending) and sends it only after the app confirmed the connection. Texts come translated with the
// stored state; the two symbols are the ones of core/dom.js (test/popup-pin-534.test.js keeps them equal).

(() => {
  // The lock and unlock symbols of core/dom.js (PATHS.lock, PATHS.unlock).
  const BODY = ['rect', { x: 3, y: 11, width: 18, height: 11, rx: 2 }];
  const LOCK = [BODY, ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }]];
  const UNLOCK = [BODY, ['path', { d: 'M7 11V7a5 5 0 0 1 9.9-1' }]];
  const SVG = 'http://www.w3.org/2000/svg';

  function symbol(name, shapes, size) {
    const span = document.createElement('span');
    span.className = `icon icon-${name}`;
    span.setAttribute('aria-hidden', 'true');
    const svg = document.createElementNS(SVG, 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
      svg.append(shape);
    }
    span.append(svg);
    return span;
  }

  const el = (tag, attrs = {}, ...children) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    e.append(...children);
    return e;
  };

  function draw(texts) {
    const view = document.getElementById('view');
    // Only over the loading state of popup.html: whatever popup.js drew already stays.
    if (!view?.querySelector(':scope > .loading-state') || window.kvPinAdopted) return;
    let pin = el('input', { type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: texts.pin, 'aria-label': texts.pin, class: 'pin-early' });
    let button = el('button', { class: 'btn primary', 'aria-live': 'polite' }, symbol('unlock', UNLOCK, 16), texts.button);
    const hold = () => {
      if (!pin) return undefined;
      if (window.kvPinAdopted || !pin.value || pin.dataset.held) return pin.focus();
      pin.dataset.held = '1';
      pin.readOnly = true;
      button.disabled = true;
      const spin = el('span', { class: 'spinner', 'aria-hidden': 'true' });
      button.replaceChildren(spin, texts.connecting);
      return undefined;
    };
    // Konrad (#534): once popup.js has taken the field over, nothing here keeps it – listeners off, references gone.
    const listeners = new AbortController();
    button.addEventListener('click', hold, { signal: listeners.signal });
    pin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !window.kvPinAdopted) hold();
    }, { signal: listeners.signal });
    window.kvEarlyRelease = () => {
      listeners.abort();
      pin = null;
      button = null;
      delete window.kvEarlyRelease;
    };
    view.className = 'view';
    view.replaceChildren(el('div', { class: 'center' }, symbol('lock', LOCK, 40), el('h2', {}, texts.title), el('p', { class: 'muted' }, texts.hint), pin, button));
    document.documentElement.lang = texts.lang;
    const field = pin;
    field.focus();
    if (document.activeElement === field) window.kvPinAt = Math.round(performance.now());
  }

  chrome.storage.session.get('popupLast').then(({ popupLast: l }) => {
    if (l && !l.demo && l.connected && !l.open && l.pinSet && l.texts) draw(l.texts);
  }, () => {});
})();
