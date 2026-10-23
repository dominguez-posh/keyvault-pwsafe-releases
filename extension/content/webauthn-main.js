// Runs in the page's MAIN world at document_start: routes navigator.credentials.create/get for
// public-key credentials to Keevault. Anything the extension does not handle (other credential
// types, cross-origin frames, security keys, user choice, extension unavailable) goes to the browser.
(() => {
  'use strict';
  const CHANNEL = 'kvpwsafe-webauthn-v1';
  const creds = navigator.credentials;
  if (!creds || typeof window.PublicKeyCredential !== 'function' || creds.__kvpwsafe) return;

  const native = { create: creds.create.bind(creds), get: creds.get.bind(creds) };
  const PKC = window.PublicKeyCredential;
  const pending = new Map();
  let seq = 0;

  const bytes = (src) => (src instanceof ArrayBuffer ? new Uint8Array(src) : new Uint8Array(src.buffer, src.byteOffset, src.byteLength));
  const b64u = (src) => {
    const b = bytes(src);
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const buf = (text) => {
    const s = String(text).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '==='.slice((s.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (ev.source !== window || !d || d.channel !== CHANNEL || d.dir !== 'toPage') return;
    const p = pending.get(d.id);
    if (!p) return;
    if (d.ack) {
      clearTimeout(p.ackTimer);
      return;
    }
    pending.delete(d.id);
    clearTimeout(p.timeoutTimer);
    p.resolve(d);
  });

  // Sends a request to the extension. Resolves with { result } | { error } | { fallback } | { aborted }.
  function relay(kind, payload, signal, timeout) {
    return new Promise((resolve) => {
      const id = `${Date.now().toString(36)}-${++seq}-${Math.random().toString(36).slice(2)}`;
      const p = { resolve };
      p.ackTimer = setTimeout(() => {
        pending.delete(id);
        resolve({ fallback: true }); // Extension not reachable.
      }, 1500);
      if (timeout > 0) {
        p.timeoutTimer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          window.postMessage({ channel: CHANNEL, dir: 'toExt', id, abort: true }, '*');
          resolve({ error: { name: 'NotAllowedError', message: 'Zeitüberschreitung' } });
        }, timeout);
      }
      if (signal) {
        signal.addEventListener('abort', () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          clearTimeout(p.ackTimer);
          clearTimeout(p.timeoutTimer);
          window.postMessage({ channel: CHANNEL, dir: 'toExt', id, abort: true }, '*');
          resolve({ aborted: true });
        }, { once: true });
      }
      pending.set(id, p);
      window.postMessage({ channel: CHANNEL, dir: 'toExt', id, kind, payload }, '*');
    });
  }

  function sameOriginChain() {
    if (window.top === window) return true;
    const ancestors = location.ancestorOrigins;
    if (!ancestors) return false;
    for (let i = 0; i < ancestors.length; i++) if (ancestors[i] !== location.origin) return false;
    return true;
  }

  const abortError = (signal) => signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  const toError = (e) => new DOMException(e?.message || 'Der Vorgang wurde nicht erlaubt.', e?.name || 'NotAllowedError');

  function attestationCredential(r) {
    const response = {
      clientDataJSON: buf(r.response.clientDataJSON),
      attestationObject: buf(r.response.attestationObject),
      getAuthenticatorData: () => buf(r.response.authenticatorData),
      getPublicKey: () => buf(r.response.publicKey),
      getPublicKeyAlgorithm: () => r.response.publicKeyAlgorithm,
      getTransports: () => r.response.transports.slice(),
    };
    const credential = {
      id: r.id,
      rawId: buf(r.rawId),
      type: 'public-key',
      authenticatorAttachment: r.authenticatorAttachment,
      response,
      getClientExtensionResults: () => JSON.parse(JSON.stringify(r.clientExtensionResults || {})),
      toJSON: () => JSON.parse(JSON.stringify(r)),
    };
    // Own properties shadow the native getters, the prototypes make instanceof checks pass.
    Object.setPrototypeOf(response, window.AuthenticatorAttestationResponse.prototype);
    Object.setPrototypeOf(credential, PKC.prototype);
    return credential;
  }

  function assertionCredential(r) {
    const response = {
      clientDataJSON: buf(r.response.clientDataJSON),
      authenticatorData: buf(r.response.authenticatorData),
      signature: buf(r.response.signature),
      userHandle: r.response.userHandle ? buf(r.response.userHandle) : null,
    };
    const credential = {
      id: r.id,
      rawId: buf(r.rawId),
      type: 'public-key',
      authenticatorAttachment: r.authenticatorAttachment,
      response,
      getClientExtensionResults: () => JSON.parse(JSON.stringify(r.clientExtensionResults || {})),
      toJSON: () => JSON.parse(JSON.stringify(r)),
    };
    Object.setPrototypeOf(response, window.AuthenticatorAssertionResponse.prototype);
    Object.setPrototypeOf(credential, PKC.prototype);
    return credential;
  }

  async function create(options) {
    const pk = options?.publicKey;
    if (!pk || options.mediation === 'conditional' || !sameOriginChain()) return native.create(options);
    if (options.signal?.aborted) throw abortError(options.signal);
    let payload;
    try {
      payload = {
        rp: { id: pk.rp?.id, name: pk.rp?.name },
        user: { id: b64u(pk.user.id), name: pk.user.name, displayName: pk.user.displayName },
        challenge: b64u(pk.challenge),
        pubKeyCredParams: (pk.pubKeyCredParams || []).map((p) => ({ type: p.type, alg: p.alg })),
        excludeCredentials: (pk.excludeCredentials || []).map((c) => b64u(c.id)),
        authenticatorSelection: pk.authenticatorSelection ? {
          authenticatorAttachment: pk.authenticatorSelection.authenticatorAttachment,
          residentKey: pk.authenticatorSelection.residentKey,
          userVerification: pk.authenticatorSelection.userVerification,
        } : undefined,
        hints: Array.isArray(pk.hints) ? pk.hints.slice() : [],
        attestation: pk.attestation,
        extensions: { credProps: !!pk.extensions?.credProps },
      };
    } catch {
      return native.create(options); // Malformed input: let the browser raise the right TypeError.
    }
    const res = await relay('create', payload, options.signal, pk.timeout);
    if (res.fallback) return native.create(options);
    if (res.aborted) throw abortError(options.signal);
    if (res.error) throw toError(res.error);
    return attestationCredential(res.result);
  }

  async function get(options) {
    const pk = options?.publicKey;
    if (!pk || !sameOriginChain()) return native.get(options);
    if (options.signal?.aborted) throw abortError(options.signal);
    let payload;
    try {
      payload = {
        rpId: pk.rpId,
        challenge: b64u(pk.challenge),
        allowCredentials: (pk.allowCredentials || []).map((c) => b64u(c.id)),
        userVerification: pk.userVerification,
        conditional: options.mediation === 'conditional',
      };
    } catch {
      return native.get(options);
    }
    if (!payload.conditional) {
      const res = await relay('get', payload, options.signal, pk.timeout);
      if (res.fallback) return native.get(options);
      if (res.aborted) throw abortError(options.signal);
      if (res.error) throw toError(res.error);
      return assertionCredential(res.result);
    }

    // Conditional UI (passkey autofill): offer vault passkeys in the field menu while the browser's own
    // autofill stays available; whichever the user picks first wins.
    const controller = new AbortController();
    const outer = options.signal;
    outer?.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    const nativePromise = native.get({ ...options, signal: controller.signal }).then((c) => ({ credential: c }), (e) => ({ error: e }));
    const oursPromise = relay('get', payload, controller.signal, 0);
    const first = await Promise.race([nativePromise.then((r) => ({ from: 'native', ...r })), oursPromise.then((r) => ({ from: 'ours', r }))]);
    if (first.from === 'native') {
      if (first.credential) {
        controller.abort();
        return first.credential;
      }
      if (outer?.aborted) throw abortError(outer);
      const r = await oursPromise;
      if (r.result) return assertionCredential(r.result);
      throw first.error;
    }
    const r = first.r;
    if (r.result) {
      controller.abort();
      return assertionCredential(r.result);
    }
    if (r.aborted) throw abortError(outer);
    const n = await nativePromise;
    if (n.credential) return n.credential;
    throw n.error;
  }

  const define = (obj, name, fn) => Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true });
  define(creds, 'create', function create_(options) { return create(options); });
  define(creds, 'get', function get_(options) { return get(options); });
  define(creds, '__kvpwsafe', true);
  define(PKC, 'isConditionalMediationAvailable', async () => true);
  if (PKC.isUserVerifyingPlatformAuthenticatorAvailable) {
    define(PKC, 'isUserVerifyingPlatformAuthenticatorAvailable', async () => true);
  }
})();
