// Is this release.mjs run a release build? (#445) Only with an explicit release option; a plain `node scripts/release.mjs`
// builds a local test installer, which the app shows as "Developer".
export const RELEASE_FLAGS = ['--early-access', '--publish', '--publish-only', '--hotfix', '--release'];
export const isReleaseRun = (argv) => RELEASE_FLAGS.some((f) => argv.includes(f));
