// Which account a passkey prompt on a sign-in page belongs to (one-click sign-in of the app or the account chosen in the
// Microsoft bar): that account's passkey comes first and is used without a further click.

// A sign-in started by the user (app tile or Microsoft bar) counts for two minutes, like the app's own jobs.
export const MS_JOB_MS = 120_000;

/**
 * Account of the sign-in running in the sender's tab: the app's one-click job, else the account chosen in the bar.
 * The app's job only for a tab that may start a sign-in, claimed with its key like cs:signIn; the bar's account only in
 * the tab where it was chosen (#424). A foreign page opening the sign-in within the two minutes gets neither.
 * deps: { demo, app, signInHosts, msLoginHosts, mayStartSignIn, tabKey }.
 */
export async function signInUser(host, sender, { demo, app, signInHosts, msLoginHosts, mayStartSignIn, tabKey }) {
  if (!host || !signInHosts.test(host)) return '';
  if (!demo && (await mayStartSignIn(sender))) {
    const job = await app.signIn(host, await tabKey(sender)).catch(() => null);
    if (job?.username) return job.username;
  }
  if (!msLoginHosts.test(host)) return '';
  const { msJob } = await chrome.storage.session.get('msJob');
  if (!msJob || !(msJob.until > Date.now()) || !msJob.tab || msJob.tab !== (await tabKey(sender))) return '';
  return msJob.username || '';
}
