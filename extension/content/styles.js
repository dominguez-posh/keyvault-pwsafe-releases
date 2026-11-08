// Styles of the in-page UI (closed shadow root of kvpwsafe-ui): field menu, sign-in bars, passkey tag. Moved out of
// content.js, which is at its size limit; loaded before it (manifest.json).
globalThis.kvpwsafeCss = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
    .menu, .banner { position: fixed; background: #fff; color: #1b1b1f; border: 1px solid #d0d4dc; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); font-size: 13px; overflow: hidden; }
    .menu { z-index: 2147483647; min-width: 260px; max-width: min(380px, calc(100vw - 8px)); max-height: 320px; overflow-y: auto; padding: 4px; }
    .head { display: flex; align-items: center; gap: 6px; padding: 6px 8px 4px; font-size: 11px; color: #5b6170; text-transform: uppercase; letter-spacing: .04em; } .head.refused { display: block; text-transform: none; letter-spacing: 0; font-size: 12px; }
    .entry { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: none; padding: 8px; border-radius: 7px; cursor: pointer; text-align: left; color: inherit; font-size: 13px; }
    .entry:hover, .entry:focus { background: #eef3fb; outline: none; }
    .avatar { flex: none; width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center; color: #fff; font-weight: 600; background: #0f6cbd; }
    .avatar.pk { background: #5b4fc4; }
    .avatar.lock { background: #5b6170; }
    .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .s { color: #5b6170; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .txt { min-width: 0; }
    .banner { top: 16px; right: 16px; width: 340px; padding: 14px 16px; }
    .banner .title { font-weight: 600; margin-bottom: 4px; display: flex; gap: 8px; align-items: center; }
    .banner .user { color: #5b6170; margin: 2px 0 10px; word-break: break-all; }
    .banner select { width: 100%; margin-bottom: 10px; padding: 6px; border-radius: 6px; border: 1px solid #c4c9d4; font-size: 13px; }
    .banner input.q { width: 100%; margin: 6px 0 4px; padding: 6px 8px; border-radius: 6px; border: 1px solid #c4c9d4; font-size: 13px; background: #fff; color: inherit; outline: none; }
    .banner input.q:focus { border-color: #0f6cbd; box-shadow: 0 0 0 2px rgba(15,108,189,.18); }
    .ms-list { max-height: 264px; overflow-y: auto; margin: 0 -4px; padding: 0 4px; }
    .entry-row { display: flex; align-items: center; gap: 6px; }
    .entry-row .entry { flex: 1; min-width: 0; }
    .entry-row button.b { flex: none; padding: 4px 8px; font-size: 12px; }
    .ms-none { padding: 8px; }
    [hidden] { display: none !important; }
    .pc::after { content: attr(data-t); }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    button.b { border: 1px solid #c4c9d4; background: #fff; color: #1b1b1f; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    button.b.primary { background: #0f6cbd; border-color: #0f6cbd; color: #fff; }
    button.x { position: absolute; top: 8px; right: 8px; border: 0; background: none; font-size: 18px; cursor: pointer; color: #5b6170; }
    .logo { width: 18px; height: 18px; border-radius: 5px; background: #0f6cbd; display: inline-grid; place-items: center; color: #fff; font-size: 11px; }
    /* Keevault key tag (passkeys): hangs top center from the browser frame, drops in and swings out; symmetric layout. */
    .kvtag { --kv: #0f6cbd; --kv-soft: #e3effa; --ok: #1f9d55; --line: #dde2ec; --muted: #5d6779; --surface: #fff; --ink: #141a26;
      position: fixed; top: 12px; left: 0; right: 0; margin: 0 auto; z-index: 2147483647; width: 268px; box-sizing: border-box;
      display: grid; gap: 10px; justify-items: center; text-align: center; padding: 18px 16px 12px;
      background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 18px; font-size: 13px;
      box-shadow: 0 18px 40px rgba(15,108,189,.18), 0 2px 8px rgba(20,26,38,.10);
      transform-origin: 50% -12px; animation: kvt-drop .6s cubic-bezier(.3,1.4,.5,1) both, kvt-swing 1.5s ease-in-out .6s; }
    .kvtag::before { content: ""; position: absolute; top: -9px; left: calc(50% - 8px); width: 16px; height: 16px; background: var(--surface);
      border-left: 1px solid var(--line); border-top: 1px solid var(--line); transform: rotate(45deg); border-radius: 3px 0 0 0; }
    .kvtag.hide { animation: kvt-away .35s ease-in forwards; }
    .kvtag.shake { animation: kvt-shake .35s ease; }
    .kvtag .badge { position: relative; width: 56px; height: 56px; display: grid; place-items: center; filter: drop-shadow(0 6px 14px rgba(15,108,189,.28)); }
    .kvtag .logo { width: 56px; height: 56px; display: block; overflow: hidden; border-radius: 14px; }
    .kvtag .logo .sweep { transform: translateX(-30px); }
    .kvtag .lock { position: absolute; right: -6px; bottom: -6px; font-size: 15px; line-height: 1; filter: drop-shadow(0 1px 2px rgba(0,0,0,.25)); }
    .kvtag .shield { width: 30px; height: 30px; display: block; }
    .kvtag .shield .fill { fill: var(--kv); opacity: .14; }
    .kvtag .shield .outline { fill: none; stroke: var(--kv); stroke-width: 2; stroke-linejoin: round; }
    .kvtag .shield .lockbody { fill: var(--kv); }
    .kvtag .shield .lockarc { fill: none; stroke: var(--kv); stroke-width: 1.6; }
    .kvtag .stamp { position: absolute; left: calc(50% - 11px); bottom: -11px; width: 22px; height: 22px; border-radius: 50%; background: var(--ok); color: #fff;
      display: grid; place-items: center; font-size: 12px; font-weight: 800; border: 2px solid var(--surface); opacity: 0; }
    .kvtag .title { font-weight: 700; font-size: 14px; }
    .kvtag .head { display: grid; gap: 2px; }
    .kvtag .sub { color: var(--muted); font-size: 12px; }
    .kvtag .switch { width: 100%; display: grid; grid-template-columns: 14px 1fr 14px; align-items: center; gap: 8px; border: 1px solid var(--line); border-radius: 12px; padding: 8px 10px; background: var(--surface); color: var(--ink); cursor: pointer; text-align: center; font: inherit; }
    .kvtag .switch::before { content: ""; }
    .kvtag .switch:hover, .kvtag .switch.open { border-color: var(--kv); }
    .kvtag .who { flex: 1; min-width: 0; display: grid; }
    .kvtag .who .main, .kvtag .opt .main { font-weight: 700; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kvtag .who .sub, .kvtag .opt .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .kvtag .chev { color: var(--muted); font-size: 12px; }
    .kvtag [hidden] { display: none !important; }
    .kvtag .list { width: 100%; display: grid; gap: 2px; border: 1px solid var(--line); border-radius: 12px; padding: 4px; max-height: 220px; overflow: auto; }
    .kvtag .opt { display: grid; text-align: center; border: 0; border-radius: 8px; background: none; color: var(--ink); padding: 7px 9px; cursor: pointer; font: inherit; }
    .kvtag .opt:hover, .kvtag .opt.on { background: var(--kv-soft); }
    .kvtag .opt-window .main { font-weight: 600; color: var(--muted); }
    .kvtag .primary { width: 100%; border: 0; border-radius: 12px; background: var(--kv); color: #fff; font: inherit; font-weight: 700; font-size: 14px; padding: 10px; cursor: pointer; }
    .kvtag .primary:hover { background: color-mix(in srgb, var(--kv), #fff 10%); } /* no filter: with one IntersectionObserver v2 calls the button not visible (#373) */
    .kvtag .primary:disabled { opacity: .6; cursor: default; }
    .kvtag button:focus-visible { outline: none; box-shadow: 0 0 0 3px rgba(15,108,189,.28); }
    .kvtag .pinframe { display: block; width: 100%; height: 112px; border: 0; background: var(--surface); } /* #465: the PIN field, a frame of the extension */
    .kvtag .switch:disabled { cursor: default; }
    .kvtag .links { display: flex; gap: 16px; justify-content: center; }
    .kvtag .link { border: 0; background: none; color: var(--muted); font: inherit; font-size: 12px; padding: 2px 4px; cursor: pointer; }
    .kvtag .link:hover { color: var(--kv); }
    .kvtag .note { font-weight: 700; font-size: 13px; }
    .kvtag.anim { width: 220px; padding-bottom: 16px; }
    .kvtag.wait .logo .sh { animation: kvt-breathe 1.2s ease-in-out infinite; }
    .kvtag.wait .logo .sweep { animation: kvt-sweep 1.4s ease-in-out infinite; }
    .kvtag.ok .stamp { animation: kvt-stamp .4s cubic-bezier(.3,1.6,.5,1) forwards; }
    @keyframes kvt-drop { from { transform: translateY(-120%); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes kvt-swing { 0% { transform: rotate(0); } 25% { transform: rotate(2.5deg); } 55% { transform: rotate(-1.6deg); } 80% { transform: rotate(.8deg); } 100% { transform: rotate(0); } }
    @keyframes kvt-away { to { transform: translateY(-110%); opacity: 0; } }
    @keyframes kvt-shake { 0%, 100% { transform: none; } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
    @keyframes kvt-breathe { 50% { opacity: .55; } }
    @keyframes kvt-sweep { from { transform: translateX(-30px); } to { transform: translateX(70px); } }
    @keyframes kvt-draw { 0% { stroke-dashoffset: 80; } 60% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -80; } }
    @keyframes kvt-stamp { from { transform: scale(2.2) rotate(-20deg); opacity: 0; } to { transform: none; opacity: 1; } }
    @media (prefers-reduced-motion: reduce) { .kvtag, .kvtag * { animation-duration: .01s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; } }
    @media (prefers-color-scheme: dark) {
      .menu, .banner { background: #23252b; color: #eceef2; border-color: #3a3d46; }
      .kvtag { --kv: #5aa6ff; --kv-soft: #17304d; --ok: #4cc38a; --line: #2a3344; --muted: #9aa6ba; --surface: #171d28; --ink: #e8edf5; }
      .entry:hover, .entry:focus { background: #2f3440; }
      .head, .s, .banner .user, button.x { color: #a6abb8; }
      button.b { background: #2b2e36; color: #eceef2; border-color: #464a55; }
      .banner select, .banner input.q { background: #2b2e36; color: #eceef2; border-color: #464a55; }
    }`;
