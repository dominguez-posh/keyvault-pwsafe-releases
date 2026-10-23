// Where browsers fetch the self-hosted extension: latest release of the public releases repository (the source
// repository is private, browsers cannot sign in there).
export const RELEASE_REPO = 'dominguez-posh/keyvault-pwsafe-releases';
const BASE = `https://github.com/${RELEASE_REPO}/releases/latest/download`;

export const EXTENSION_UPDATE = {
  manifest: `${BASE}/update.xml`,
  crx: `${BASE}/kvpwsafe-extension.crx`,
};
