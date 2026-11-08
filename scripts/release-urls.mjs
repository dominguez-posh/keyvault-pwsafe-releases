// Where browsers fetch the self-hosted extension: latest release of the public releases repository (the source
// repository is private, browsers cannot sign in there).
export const RELEASE_REPO = 'dominguez-posh/keyvault-pwsafe-releases';
const BASE = `https://github.com/${RELEASE_REPO}/releases/latest/download`;

export const EXTENSION_UPDATE = {
  manifest: `${BASE}/update.xml`,
  crx: `${BASE}/kvpwsafe-extension.crx`,
};

/**
 * #455: Early Access pre-releases are not "latest", so there the CRX is fetched from the release's own tag; otherwise an
 * Early Access update.xml would hand out the Prod extension. Prod stays on latest.
 */
export function extensionCodebase(version, earlyAccess) {
  return earlyAccess ? `https://github.com/${RELEASE_REPO}/releases/download/v${version}/kvpwsafe-extension.crx` : EXTENSION_UPDATE.crx;
}

/**
 * #455: fixed address of the Early Access extension feed. release.mjs --early-access writes update-ea.xml to the root of the
 * public repo's branch "early-access"; the app points the browser policies of a tester here, so they need no change per version.
 * The same address is in desktop/machine-setup.js (test/ea-channel.test.js compares them).
 */
export const EARLY_ACCESS_FEED_FILE = 'update-ea.xml';
export const EARLY_ACCESS_FEED = `https://raw.githubusercontent.com/${RELEASE_REPO}/early-access/${EARLY_ACCESS_FEED_FILE}`;

/**
 * The content of update-ea.xml for a version: the update.xml of the build with the codebase on the tag's own CRX. A Prod
 * hotfix has the "latest" address in its update.xml; the Early Access feed must still name the tag, so it is rewritten here.
 */
export function earlyAccessFeedXml(xml, version) {
  return checkEarlyAccessFeed(xml.replace(/codebase='[^']*'/, `codebase='${extensionCodebase(version, true)}'`), version);
}

/** The Early Access feed must hand out the CRX of its own tag (never the Prod one, which is "latest"). */
export function checkEarlyAccessFeed(xml, version) {
  const want = extensionCodebase(version, true);
  if (!xml.includes(`codebase='${want}'`) || !xml.includes(`version='${version}'`)) throw new Error(`update.xml ist nicht für Early Access ${version} gebaut (erwartet ${want})`);
  return xml;
}
