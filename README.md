# Workana Job Board

A self-hosted dashboard for Workana job postings. It signs in as you using an exported
cookie file, scrapes the job feed with a real browser, stores everything in SQLite, and
serves a searchable table modelled on the reference Upwork-style layout.

```
.\start.ps1                        # web UI on http://127.0.0.1:4300
.\start.ps1 scrape                 # full crawl using the cookie file
.\start.ps1 scrape -- --user=a@b.c # crawl using a registered member's session
.\start.ps1 login-check            # confirm the cookie file still authenticates
```

Open the UI and register — the first account becomes the owner. Other developers can then
sign up and connect their own Workana sessions.

---


## Why it drives a browser

Workana sits behind Cloudflare. A plain HTTP client — `curl`, `fetch`, `Invoke-WebRequest` —
is served the *"Just a moment…"* interstitial no matter which cookies it presents, because
`cf_clearance` is bound to the **IP address and TLS fingerprint** that obtained it, neither of
which a scripted client can reproduce. Driving Chromium is therefore not a convenience here,
it is the only thing that works.

Two details matter and are easy to get wrong:

- **Full Chromium, not the headless shell.** Playwright's default `headless: true` launches
  `chromium-headless-shell`, which Cloudflare fingerprints readily — it failed the challenge
  on roughly every other page. `channel: 'chromium'` uses the real browser binary and passes
  cleanly. This single change took a 4-page scrape from *"challenged on page 2"* to *"4 pages,
  zero challenges, 3× faster"*.
- **Earned clearance is persisted.** The `cf_clearance` in your cookie export is worthless on
  a different machine. When our browser clears a challenge itself, Cloudflare issues a
  clearance bound to *this* machine; it is saved to `data/storage-state.json` and reused, so
  later runs start warm.

Pacing is deliberately gentle (1.2–2.6 s between navigations). Hammering pagination *will*
trip an interactive challenge — hitting pages 5/12/30 back to back is what flagged this
machine during development.

## Two things that silently truncate the results

Both cost ~90% of the data before they were found, and neither announces itself.

**The pager is decorative.** Workana renders a fixed five-slot window — `1 2 3 4 5` — on
*every* page, including page 6 of a 3-page result set. It never names the last page and
carries no total, so anything derived from it under-counts. The crawler ignores it entirely
and walks forward until the results actually run out.

Knowing when they *have* run out needs care, because an empty page is ambiguous: it means
either the end of the list **or** that Workana soft-throttled that request. An early version
took the first empty page at face value and concluded the feed was 4 pages deep; it is 40.
So an empty page is retried (`EMPTY_PAGE_RETRIES`) before it is believed, a *partial* page
(fewer than 20 cards) is the reliable end-of-list signal, and a page whose jobs were all
seen already means Workana clamped an out-of-range page number back onto an earlier one.

**The language filter is applied even when you omit it.** Leave `language` off the URL and
Workana appends its own — `language=en` here, from the account locale cookie — quietly
hiding every Spanish and Portuguese project, which on a Latin-American marketplace is most
of the site. It is not a normal filter: `language=xx` drops the parameter but still returns
the English set, and repeating the parameter keeps only the last value. A comma-separated
list is the only form that works:

| Query | IT & Programming jobs reachable |
| --- | --- |
| `?category=it-programming` (server adds `language=en`) | 49, over 3 pages |
| `?category=it-programming&language=en,pt,es` | **790, over 40 pages** |

## Setup

Node 22.5 or newer (this project ships a portable Node 24 in `.tools/`, used automatically by
`start.ps1`). The database uses the built-in `node:sqlite`, so there is no native module to
compile.

```powershell
npm install          # also runs `playwright install chromium`
.\start.ps1 login-check
.\start.ps1 scrape -- --pages=4 --detail-budget=45
.\start.ps1
```

### Accounts

The board is multi-user. Open it and the first person to register becomes the **owner**;
after that anyone can sign up (unless you close it — see below), and each member connects
**their own** Workana session from *Account → Your Workana session*.

Whoever registers first also inherits the history from before accounts existed — the "I bid
on this" flags and any stars or notes become theirs rather than being orphaned.

What is shared and what is not:

| Shared across members | Private to each member |
| --- | --- |
| Jobs, clients, skills, budgets, bids, contact counts, client feedback | Whether *you* bid, whether the client contacted *you*, your proposed budget |
| Everything one member scrapes, everyone sees | Your stars, hides and notes |

That split is deliberate: a posting is the same posting whoever fetched it, so re-scraping it
per account would multiply the load on Workana for nothing. Anything that is only true of one
person lives in `user_jobs`, keyed by user, and every query joins it on the *viewer's* id.

Only one scrape runs at a time for the whole instance, and a request that arrives while one is
in flight is **refused** (HTTP 409), not queued — several members each driving a Chromium at
Workana at once is heavy locally and a good way to get the whole instance rate-limited. Queuing
them was worse than refusing: every run walks the same list pages, so a queue is the same work
repeated while everyone waits longer. The board greys out Refresh and Full crawl while a run is
going, and the background refresh re-checks a minute later instead of competing for the slot.
That refresh rotates between members so no single account carries it — and because it has to
borrow somebody's Workana session to work at all, the board reports it as the system
("Auto-refreshing") rather than blaming it on whichever member's session it happened to use.
Only a button press is attributed to a person.

### Cookies

A cookie export is a JSON dump from a browser signed in to Workana (the format written by the
*Cookie-Editor* / *EditThisCookie* extensions). Only `workana.com` cookies are kept — the
export usually contains the person's entire browser profile, and there is no reason for this
app to hold their Google or banking cookies.

**These are live logins.** They are encrypted at rest with `APP_SECRET` (an auto-generated
`data/secret.key` is used if you set nothing), never sent back to the browser, and never
shared between members. Even so, the running server can use any of them, so only invite
people to an instance they would trust with that — and if you expose it beyond localhost,
put it behind HTTPS and set `APP_SECRET` yourself.

The login lives in `workana_session`, which expires roughly a month after export. When
*Verify* reports the session rejected, re-export and paste it again.

## What gets captured

Everything Workana exposes to a logged-in freelancer:

| Source | Fields |
| --- | --- |
| **List card** | title, slug, URL, relative publish time, **last client reply**, bid count, description preview, budget string, skills, featured flag, "contacted" state |
| **Client popover** | name, profile id, country, rating, projects published, projects paid, **hire rate**, member since, **last login** |
| **Detail page** | full description, category, subcategory, project size, duration, exact publish date, status, interested-freelancer count, verified-payment badge, whether *you* already bid |
| **Client ratings** | the client's feedback history — project title, freelancer, stars, age, comment |
| **Project Insights** | average bid rate, every competing freelancer with avatar, rating, category ranking, projects completed, rehire count — and **which of them the client is in contact with** |

### "In contact"

Workana's Insights tab marks the freelancers a client has actually reached out to. That is
the *contact count* in the list and the avatar row at the top of the detail drawer — the
most useful competitive signal on the site, since it tells you whether a job is still open
in practice or already down to a shortlist.

Two traps live in that page, both handled:

- **Every badge is always in the DOM**, with the inactive ones hidden by an inline
  `display: none`. A `textContent` test marks all 20 contenders as "In contact"; visibility
  has to be checked explicitly.
- **Some projects never get their badges computed** and ship with "New" (sometimes also
  "Recommended") switched on for the whole list, HEROes with 179 completed projects
  included. A badge true for ~everyone carries no information, so it is stored as `NULL`
  — unknown — rather than asserted. "In contact", "Favorite" and "Proposal selected" are
  always resolved correctly and are never blanked.

Insights cost one page load per job, so the scraper fetches them on a budget
(`INSIGHT_BUDGET`, default 25/run, newest jobs with bids first). Opening a job that has
none yet fetches them on the spot.

## The UI

- **One line per job** — `# · Posted · Last reply · Title · Budget · Country · Hire rate ·
  Bids · Contacts`. *Last reply* is how recently the client answered anyone on the project
  (green within a day, blue within three); *Hire rate* is the share of their posted projects
  that ended in a payment, with the raw `paid/posted` beside it and a `✓` when their payment
  method is verified. A `·` in Contacts means insights aren't collected yet; jobs you have
  already bid on carry a green edge.
- **Why hire rate and not client rating**: only 234 of 913 clients have a rating at all, so
  that column would be empty three times out of four. Hire rate is computable for 909 of 913
  and actually separates the field — **70% of jobs come from clients who have never paid
  anyone**, against 138 from clients hiring at 50% or better. `first_seen_at` is still stored
  and shown in the drawer, but it made a poor column: 913 jobs span 16 distinct minutes,
  because a bulk crawl inserts them all at once.
- **Budgets are formatted from the parsed numbers**, not Workana's prose: `Less than USD 50`
  becomes `< $50`, `USD 1,000 - 3,000` becomes `$1,000–3,000`, and the HR/FIX tag beside it
  carries the contract type so `/ hour` can be dropped. The original wording is on hover.
- **Left filter rail** — full-text search (SQLite FTS5), contract type, recency, budget and
  bid-count ranges, category / country / skill facets with live counts, and quick toggles
  for starred, payment-verified, zero-bid, not-bid-by-me, whether the client is contacting
  anyone, and whether (and how recently) the client has replied.
- **Drawer** — the contacted freelancers with avatars and stats up top, then activity,
  the full client profile, description (Markdown rendered), skills, other bidders, the
  client's feedback history, their other postings, and a private notes field.
- **Statistics** — volume per day, breakdown by category and country, most-requested skills.
- Starring, hiding and notes are stored locally in `user_flags` and never leave the machine.

## Giving other developers a URL

By default the server binds to `127.0.0.1`, so nothing outside this machine can reach it.
Publishing it is two separate problems, and it is worth keeping them separate:

**1. Name resolution** — what makes `jobs.example.com` point here.

| Method | Setup on each developer's machine | Works off-LAN | Real TLS certificate |
| --- | --- | --- | --- |
| `hosts` file entry | edit as administrator, every machine | no | no |
| mDNS — `<machine-name>.local` | none, built into Windows/macOS | no | no (`.local` cannot be certified) |
| `10-0-0-5.sslip.io` (your LAN IP) | none | only if the IP is routable | no (a private IP cannot be validated) |
| DNS record on the router | once, centrally | no | needs an internal CA |
| Tailscale MagicDNS | install Tailscale | **yes** | **yes, automatic** |
| Cloudflare Tunnel + your domain | none | **yes** | **yes, automatic** |

**2. What answers on that name** — a reverse proxy terminating TLS and routing by
hostname. `deploy/Caddyfile.example` covers a public domain, a LAN-only name with Caddy's
internal CA, and several apps sharing one host by name.

Given what this instance holds — every member's live Workana login, reachable through a
session cookie — the deciding factor is TLS rather than convenience. The first four rows
above cannot get a certificate a browser will accept, which leaves sign-ins travelling in
clear text. Prefer **Tailscale** (invited devices only, valid certificate, no firewall
changes) or **Cloudflare Tunnel** (public hostname, no inbound ports). Reserve `hosts`/mDNS
for a LAN you already trust.

### Hosting it on Railway

`Dockerfile` and `railway.toml` are ready to deploy. Railway solves access outright — a
public HTTPS URL, no tunnel, and the board stops depending on one desktop being awake.

Set these service variables:

| Variable | Value |
| --- | --- |
| `APP_SECRET` | a long random string **you keep a copy of** |
| `HOST` | `0.0.0.0` (already the default inside the image) |
| `ALLOWED_HOSTS` | your Railway domain, e.g. `workana-board.up.railway.app` |
| `TRUST_PROXY` | `1` — Railway terminates TLS, so this is what makes cookies `Secure` |
| `REGISTRATION_CODE` | an invite code; the URL is public |
| `DB_FILE` | `/app/data/workana.db` |

**Mount a Railway Volume at `/app/data`** (Service → Variables → *Add Volume*). It has to be
attached in the dashboard: Railway rejects a `VOLUME` instruction in the Dockerfile, so the
image cannot declare it for you. Container filesystems are wiped on redeploy, and that
directory holds the job corpus, `secret.key`, and each member's earned Cloudflare clearance.
Without the volume they vanish on the next deploy; without `APP_SECRET` set explicitly, a
replaced volume makes every stored Workana session permanently undecryptable. The app warns
about both at startup when it detects a hosted environment.

`PORT` is injected by Railway and already honoured. `/healthz` is unauthenticated for the
platform's health check and returns nothing but `{"ok":true}`.

**The catch worth weighing before you commit.** Railway egresses from datacenter IP ranges,
and Cloudflare scores those far more harshly than residential ones. This scraper only works
because a real Chromium can pass the managed challenge — which it did from a residential
connection, and even then the headless *shell* was being challenged until it was swapped for
full Chromium. From a cloud IP expect frequent challenges and possible hard blocks, with one
fewer escape hatch: `HEADLESS=false` is not available without a virtual display.

That is survivable, and the per-member proxy is what makes it so: if every member sets an
exit in their own region, Workana never sees Railway's address at all, and the container
becomes a coordinator rather than the source of the traffic. **Railway plus per-member
proxies works well; Railway on its own is likely to get throttled.** If nobody has a proxy,
keeping the scraper on a residential connection and tunnelling the UI out is the more
reliable shape.

### Developers in other regions

Two distinct problems, and the second is the one that surprises people.

**Reaching the UI.** This machine is not addressable from the internet — the LAN address is
RFC1918 and the VPN adapter sits in `198.18/15`, so port forwarding is not an option. That
leaves an **outbound** tunnel, which is fine because it needs no inbound ports or firewall
changes: Tailscale (invited devices only, valid certificate, MagicDNS name) or Cloudflare
Tunnel (public hostname on a domain you own).

**Where their Workana session is driven from.** Scraping runs *on the server*, so by default
a developer in São Paulo who adds their cookies has that session used from *the host's* exit
IP, wherever that happens to be — and if the host runs behind a VPN, that is somewhere else
again. This is a genuine problem, not a cosmetic one:

- Workana's `cf_clearance` is bound to the IP that earned it, so theirs is useless here and
  the browser has to win a fresh challenge for every account.
- A session that suddenly appears from another continent is exactly the pattern account
  security looks for, and Workana can invalidate it.
- Several accounts arriving from one address looks like precisely what it is.

So each member can set their own **egress proxy** in *Account → Your region*
(`socks5://host:1080`, or `http://user:pass@host:8080`). Their scrapes, insight fetches and
session checks then exit through it; everyone else is unaffected. It is stored encrypted like
the cookies, and credentials are never sent back to the browser — the UI shows host, port and
whether authentication is set. Leave it blank to use the server's own connection.

If a member has no proxy available, the alternative is for them to run their own instance
locally, which keeps their traffic on their own connection at the cost of a separate corpus.

Whichever you pick, run the app on loopback and let the proxy be the only entrance:

```powershell
$env:HOST='127.0.0.1'          # proxy reaches it locally; nothing else can
$env:TRUST_PROXY='1'           # believe X-Forwarded-Proto, so cookies get `Secure`
$env:ALLOWED_HOSTS='jobs.example.com'
$env:APP_SECRET='<long random string, kept stable>'
$env:REGISTRATION_CODE='<invite code>'
.\start.ps1
```

`TRUST_PROXY` and `ALLOWED_HOSTS` are not ceremony. Without the first, session cookies are
never marked `Secure` and will be sent over plain HTTP; without the second, any hostname
that resolves to this address is served, which is what makes DNS rebinding work. Enable
`TRUST_PROXY` **only** behind a proxy you control — if the app is directly reachable,
anyone can forge those headers.

## Configuration

All optional, via environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `4300` / `127.0.0.1` | Web server binding |
| `APP_SECRET` | auto-generated | Encrypts stored Workana sessions. Set it explicitly in any shared deployment; losing it makes every stored session unreadable |
| `ALLOW_REGISTRATION` | `1` | `0` closes sign-ups (the first account can always be created) |
| `REGISTRATION_CODE` | — | Require an invite code to register |
| `ALLOWED_HOSTS` | — | Comma-separated Host allowlist, e.g. `jobs.example.com`. Empty accepts any host; set it whenever the server is reachable off-machine |
| `TRUST_PROXY` | `0` | Believe `X-Forwarded-Proto`/`-For` and mark session cookies `Secure`. Only behind a proxy you control |
| `COOKIE_FILE` | `./Hiyashi.json` | Cookie export used by the CLI when no `--user` is given |
| `DB_FILE` | `./data/workana.db` | SQLite location |
| `WORKANA_CATEGORY` | `it-programming` | Category to crawl; empty string crawls all |
| `WORKANA_LANGUAGE` | `en,pt,es` | Project languages — see the truncation note above |
| `HEADLESS` | `true` | `false` passes challenges more reliably if you get blocked |
| `AUTO_SCRAPE_MINUTES` | `10` | Background refresh cadence; `0` disables |
| `REFRESH_PAGES` | `5` | Pages the *background* refresh walks (new jobs land on page 1) |
| `MAX_LIST_PAGES` | `250` | Safety cap for a full crawl, not a target |
| `EMPTY_PAGE_RETRIES` | `2` | Retries before an empty page is accepted as the end |
| `DETAIL_BUDGET` | `40` | Detail pages enriched per run |
| `INSIGHT_BUDGET` | `25` | Project Insights pages per run — these supply contact counts |
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | `1200` / `2600` | Pacing between navigations |
| `WORKANA_PROXY` | — | Route through a proxy, e.g. one in your usual country |

## Crawling vs refreshing

Two different jobs, deliberately separated:

- **Full crawl** — `.\start.ps1 scrape` walks the category to exhaustion (40 pages / ~790
  jobs for IT & Programming, roughly 4 minutes for the listings). Run it when you want the
  whole back catalogue.
- **Background refresh** — the server sweeps `REFRESH_PAGES` (5) every
  `AUTO_SCRAPE_MINUTES`, which is enough to catch new postings without re-walking 40 pages
  every ten minutes.

Either way the database accumulates: each run inserts what is new, refreshes bid and contact
counts on what it has already seen, and never overwrites `first_seen_at`.

Enrichment runs on a budget per pass (`DETAIL_BUDGET`, `INSIGHT_BUDGET`) rather than all at
once, so a fresh crawl of several hundred jobs fills in its descriptions and contact data
over the following passes instead of in one long blocking run.

## Troubleshooting

**"Cloudflare did not clear its challenge"** — run with `HEADLESS=false`, raise
`MIN_DELAY_MS`/`MAX_DELAY_MS`, or set `WORKANA_PROXY` to an exit in the country the cookies
came from. The scrape keeps whatever it collected before the challenge rather than failing
outright.

**Empty results / not logged in** — `.\start.ps1 login-check` prints each auth cookie and
whether it has expired. Re-export the cookies.

**Selectors stopped matching** — Workana changed its markup. `data/debug/` holds an HTML dump
and screenshot from any challenged page; the parsers live in `src/scraper/parse.js` and are
the only place selectors appear.

## Layout

```
src/
  config.js            environment/config
  cookies.js           cookie export → Playwright cookies
  db.js                schema, upserts, FTS index, migrations
  server.js            REST API + static hosting
  scraper/
    browser.js         Chromium launch, Cloudflare handling, clearance persistence
    parse.js           in-page extractors + Node-side normalisation
    scrape.js          run orchestration, detail enrichment, insights
  cli/                 scrape / login-check entry points
public/                the dashboard (no build step, no framework)
scripts/               verify.mjs, inspect-db.mjs, shot.mjs diagnostics
                       backfill-posted.mjs, backfill-bids.mjs repairs
                       (both default to a dry run; pass --apply to write)
```

## Scope

This reads your own account's job feed at human pace. Keep it that way: it authenticates as
you, and Workana's terms apply to what you do with the data.
