// #420: release stages Dev → Early Access (beta) → Prod (stable). Pure functions shared by the app and the extension.
//
// The app's stage: a Dev build (kvBuild.kind "dev", stamped by the build) is always "dev" – neither the setting nor a policy
// changes it. Every other build follows the effective setting updateChannel (policy included): "beta" or "stable".
//
// The extension stays one extension (update_url on Prod; Early Access switches its policy feed, #455). It learns the stage
// from the app in the answer to hello and unlocks only *new* functions with it. Without an app connection it is "stable".
// Security functions never hang on a switch: FEATURE_STAGES lists only new, optional functions.

export const STAGES = Object.freeze(['stable', 'beta', 'dev']);

/** The stage of the app: build = buildKind() ({ dev }), setting = the effective updateChannel. */
export function appStage(build, setting) {
  if (build?.dev === true) return 'dev';
  return setting === 'beta' ? 'beta' : 'stable';
}

/**
 * The update channel of the browser extension's policy (#455) for an app stage: Early Access and Dev get the Early Access
 * feed (the newest public extension; Dev functions are unlocked through the app, not through an own extension feed).
 */
export const extensionFeedChannel = (stage) => (stage === 'beta' || stage === 'dev' ? 'beta' : 'stable');

/** What the app reported about its stage. A claim from the native port: anything unknown counts as "stable". */
export const reportedStage = (claim) => (STAGES.includes(claim) ? claim : 'stable');

/**
 * New extension functions behind a switch: name → the lowest stage that sees it ("dev" = Dev only, "beta" = Early Access
 * and Dev). A function leaves this list when it reaches Prod. Never a security function.
 */
export const FEATURE_STAGES = Object.freeze({});

/** Whether a switched function is on at a stage. A name that is not listed is a normal (Prod) function: always on. */
export function featureOn(name, stage, table = FEATURE_STAGES) {
  if (!Object.hasOwn(table, name)) return true;
  const need = STAGES.indexOf(table[name]);
  if (need < 0) return false;
  return STAGES.indexOf(reportedStage(stage)) >= need;
}

/** All switched functions with their state at a stage, e.g. for the popup: { name: true|false }. */
export const featuresAt = (stage, table = FEATURE_STAGES) => Object.fromEntries(Object.keys(table).map((n) => [n, featureOn(n, stage, table)]));
