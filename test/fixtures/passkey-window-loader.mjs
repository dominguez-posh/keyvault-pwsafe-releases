// Module hook for test/passkey-window-536.test.js: 'electron' and passkey-window.js's boot/state/diag imports resolve to
// test/fixtures/passkey-window-fakes.mjs.
const FAKES = new URL('./passkey-window-fakes.mjs', import.meta.url).href;
const MAPPED = ['/desktop/main/boot.js', '/desktop/main/state.js', '/desktop/main/diag.js'];

export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: FAKES, shortCircuit: true };
  const r = await next(specifier, context);
  if (MAPPED.some((m) => r.url.endsWith(m))) return { url: FAKES, shortCircuit: true };
  return r;
}
