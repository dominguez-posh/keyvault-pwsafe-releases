// Areas of the demo smoke run, for partial runs during development (#397): --only=<area>[,<area>…]. A partial run is never
// a full run: the verdict says so (smoke-guard.js) and the full run stays due before a merge. No Electron and no app code
// here, scripts/start.mjs checks the arguments with it before anything starts.

/** The flows at the start of the demo run (desktop/main/smoke.js). */
export const FLOW_AREAS = ['shortcuts', 'protection', 'bridge', 'vaultsettings', 'license', 'rename', 'pin', 'secured', 'windows', 'personal'];

/** The steps of the feature checks (desktop/smoke-features.js), in their order. A test keeps the two lists equal. */
export const FEATURE_AREAS = [
  'buildkind', 'clipboard', 'mainmenu', 'trash', 'vaultsearch', 'navheading', 'sharehint', 'exthint', 'extreinstall', 'vaultorder', 'newmenu', 'vaultmenu', 'kdbximport', 'loginlink',
  'browserimport', 'foldericons', 'vaultwizard', 'firstaccount', 'firstwizard', 'recoverykey', 'adminstart', 'narrowsidebar', 'sidebarfoot', 'version', 'versionchannel',
  'list', 'agentfront', 'agententer', 'agentrevoke', 'agentwrite', 'agentlock', 'agenttrust', 'passkeypin', 'passkeypinagent', 'passkeypinwindows', 'passkeypinbrowser', 'folderdrag', 'multidrag', 'multiclear', 'droptarget',
  'deleterefused', 'vaultprofile', 'deleterace', 'moveassets', 'cutpaste', 'mcpextra', 'helpfeedback', 'noscroll', 'passkeynarrow', 'listnarrow', 'passkeydrag', 'adminpin', 'admin', 'devices',
  'bastionfqdn', 'adminpim', 'offlinedelete', 'winlock', 'releasesign', 'versionhistory', 'otpsecret', 'fieldhover', 'adminflags', 'nurfuermich', 'pimlock', 'machinesetup', 'settingsfile', 'logging', 'compliance', 'tlsenv',
];

export const SMOKE_AREAS = [...FLOW_AREAS, ...FEATURE_AREAS];

// What an area finds only after another one has run: the vault search looks for the secured file "Team-Datei".
// The drop targets (#491) need the personal vault as the forbidden target.
const NEEDS = { vaultsearch: ['secured'], sharehint: ['secured'], droptarget: ['personal'] };

const onlyArg = (args) => args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

/** Why these arguments can't start a partial run, or null. Only known names reach the output: it may be a CI log. */
export function onlyProblem(args) {
  const value = onlyArg(args);
  if (value === undefined) return null;
  if (!args.includes('--smoke-test') || !args.includes('--demo')) return '--only needs --demo --smoke-test';
  if (args.some((a) => a.startsWith('--view='))) return '--only and --view exclude each other';
  const names = value.split(',');
  const unknown = names.filter((n) => !SMOKE_AREAS.includes(n));
  if (!unknown.length) return null;
  const shown = unknown.map((n) => (/^[a-z0-9]{1,32}$/.test(n) ? `"${n}"` : '(invalid name)')).join(', ');
  return `unknown area ${shown}. Areas: ${SMOKE_AREAS.join(', ')}`;
}

/** The areas of this partial run with what they need, in the order of the run; null for a full run. */
export function onlyAreas(args) {
  const value = onlyArg(args);
  if (value === undefined) return null;
  const chosen = new Set(value.split(','));
  for (const n of [...chosen]) for (const need of NEEDS[n] || []) chosen.add(need);
  return [...SMOKE_AREAS.filter((n) => chosen.has(n)), ...[...chosen].filter((n) => !SMOKE_AREAS.includes(n))];
}

/** What the run does with its areas: runs(name) decides and remembers, missing() names what did not happen as it should. */
export function areaSelection(args = process.argv) {
  const names = onlyAreas(args);
  const ran = new Set();
  return {
    partial: names !== null,
    names,
    runs(name) {
      if (names && !names.includes(name)) return false;
      ran.add(name);
      return true;
    },
    missing() {
      const due = names || SMOKE_AREAS;
      return [
        ...due.filter((n) => !ran.has(n)).map((n) => `area "${n}" did not run`),
        ...[...ran].filter((n) => !SMOKE_AREAS.includes(n)).map((n) => `area "${n}" is missing in desktop/smoke-areas.js`),
      ];
    },
  };
}

/**
 * The runs of `npm run smoke`, as arguments for scripts/start.mjs: the normal start and the demo. A partial run is the demo
 * alone (the normal start would print "SMOKE OK"). KVPWSAFE_SMOKE_ONLY is how the CI workflow hands in its input.
 */
export function smokePlan(args, env = process.env) {
  const demo = ['--demo', '--smoke-test', ...args];
  if (env.KVPWSAFE_SMOKE_ONLY && onlyArg(args) === undefined) demo.push(`--only=${env.KVPWSAFE_SMOKE_ONLY}`);
  return onlyArg(demo) === undefined ? [['--smoke-test'], demo] : [demo];
}
