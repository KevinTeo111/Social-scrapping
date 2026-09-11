/**
 * Counting the proposals this account has actually written.
 *
 * The board can only recognise a bid on a job it has scraped, and the feed drops
 * postings as they age — so its count is "proposals on jobs still listed", which
 * drifts further below the real number the longer the account has been active.
 *
 * Workana's own inbox knows, because sending a proposal opens a thread and the
 * thread outlives the listing. /roaster/search/ returns those threads as JSON,
 * fifteen to a page, and walking it to the end is the only honest total.
 *
 * The request is replayed from inside the page rather than issued from Node: it
 * needs the session cookies, the same origin, and the XHR header the site sends,
 * and asking the page to do it gets all three for free.
 */
import { gotoWithChallenge, sleep } from './browser.js';
import { config } from '../config.js';

const XHR_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/javascript, */*; q=0.01',
};

export async function fetchMyProposals(page, { maxPages = 60, onProgress = () => {} } = {}) {
  await gotoWithChallenge(page, `${config.baseUrl}/inbox`, { waitFor: 'body' });
  // The shell has to boot before its own fetches will carry a session.
  await sleep(3000);

  const projects = [];
  for (let p = 1; p <= maxPages; p++) {
    const batch = await page.evaluate(
      async ([pageNo, headers]) => {
        const res = await fetch(`/roaster/search/?page=${pageNo}`, { headers, credentials: 'include' });
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          return Array.isArray(data) ? data : null;
        } catch {
          return null; // an HTML body means the session was not accepted
        }
      },
      [p, XHR_HEADERS],
    );

    if (batch === null) {
      if (p === 1) throw new Error('Workana did not return the inbox as JSON — the session may have expired.');
      break;
    }
    if (batch.length === 0) break;

    for (const job of batch) {
      projects.push({
        slug: job.slug,
        title: job.name,
        status: job.status,
        lastPostAt: job.lastPostCreated ? new Date(job.lastPostCreated * 1000).toISOString() : null,
        unread: Number(job.totalUnreadMessages) || 0,
      });
    }
    onProgress({ phase: 'proposals', page: p, total: projects.length });
    if (batch.length < 15) break; // a short page is the last one
  }

  return projects;
}
