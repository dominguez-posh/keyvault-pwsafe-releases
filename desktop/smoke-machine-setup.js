// Smoke check of the device setup (#395), part of the feature checks (desktop/smoke-features.js), which have reached
// their size limit. It reads only (no UAC here); the elevated part is covered by test/machine-setup.test.js.

export async function machineSetupCheck({ api, fail }) {
  const m = await api.machineSetupStatus();
  if (process.platform === 'win32') {
    if (!m?.supported || typeof m.canRunSetup !== 'boolean' || typeof m.policyBlocked !== 'boolean') fail('machinesetup', `status incomplete: ${JSON.stringify(m)}`);
    else if (m.canRunSetup && m.certTrusted && ((m.edgePolicy && m.chromePolicy) || m.policyBlocked)) fail('machinesetup', 'setup offered although nothing is missing');
    // #455: the status names the browsers whose policy the company sets (no policy is created there: test/machine-setup.test.js).
    else if (typeof m.edgeCompany !== 'boolean' || typeof m.chromeCompany !== 'boolean') fail('machinesetup', `company state missing: ${JSON.stringify(m)}`);
  }
}
