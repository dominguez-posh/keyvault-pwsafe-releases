// Smoke helper for the RDP connection with Credential Guard (#29, step "devices"): the linked password goes to the
// protected clipboard (Keevault-Update.exe --clipboard, #337). Windows has one clipboard for everything on the machine;
// another process can hold it for longer than the helper waits (a second smoke run, a clipboard tool, a remote
// session's clipboard sync). Then the app refuses the copy, which is right (#337), but says nothing about this check.
// So a refused copy is looked at once more: if the helper itself cannot copy right now, the machine is the cause and
// the run says so instead of failing; if it can, the connection is tried again and judged as usual.

const REFUSED = /geschützte Zwischenablage|protected clipboard/;
const PROBE = 'kv-smoke-clipboard-probe';

/** → the result of connectServer ({ credentialGuard, copied } or { error }), with environment: true when the clipboard is not usable here. */
export async function connectWithCredentialGuard({ api, containerId, id, copyViaHelperExe, clipboardHas, log = console.log }) {
  const connect = async () => {
    process.env.KVPWSAFE_TEST_CREDENTIAL_GUARD = '1';
    try {
      return await api.connectServer({ containerId, id, method: 'rdp' }).catch((e) => ({ error: e.message }));
    } finally {
      delete process.env.KVPWSAFE_TEST_CREDENTIAL_GUARD;
    }
  };
  const first = await connect();
  if (!REFUSED.test(first.error || '')) return first;
  const usable = await copyViaHelperExe(PROBE);
  await clipboardHas(PROBE); // clears the probe again: the clipboard is empty after the run
  if (!usable) {
    log('[features] devices: the protected clipboard cannot be used on this machine right now (helper missing or the clipboard held by another process) – the clipboard checks of this step are not judged');
    return { ...first, environment: true };
  }
  return connect();
}
