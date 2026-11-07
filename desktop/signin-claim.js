// Which browser tab a one-click sign-in belongs to (#372). The job of the app (account, password, one-time code) goes
// to the first tab that asks for it; a second tab – opened by a foreign page within the two minutes – gets nothing.

/**
 * job: the open sign-in job; tab: key of the asking tab (browser instance and tab id). Marks the job for the first
 * tab and answers whether this tab may have it. Without a tab key (an older extension) nothing is claimed, and a job a
 * tab already claimed is not handed out (#424).
 */
export function claimJob(job, tab) {
  if (!tab) return !job.tab;
  if (job.tab && job.tab !== tab) return false;
  job.tab = tab;
  return true;
}
