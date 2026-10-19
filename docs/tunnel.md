# Publishing the board

The board runs on this workstation and listens on `127.0.0.1:4300`. To let
anyone else reach it, something has to carry traffic in from the internet.
There are two ways here, and they are not equivalent.

## Tailscale Funnel — a permanent address

```
run.cmd funnel
```

The address is `https://<machine>.<tailnet>.ts.net` and **never changes**. Share
it once. Restarts, reboots and network changes do not alter it, so nothing has
to be redeployed or re-sent when the tunnel comes back.

### One-time setup

1. **Install it** (needs administrator):

   ```
   winget install tailscale.tailscale
   ```

   or download from <https://tailscale.com/download>.

2. **Sign in** — opens a browser once:

   ```
   tailscale up
   ```

3. **Allow HTTPS certificates** for the tailnet, at
   <https://login.tailscale.com/admin/dns> → *Enable HTTPS*.

4. **Allow Funnel** for this machine, at
   <https://login.tailscale.com/admin/acls>. Tailscale usually offers to add
   this for you the first time `tailscale funnel` runs; if it does not, the
   policy needs:

   ```json
   "nodeAttrs": [{ "target": ["*"], "attr": ["funnel"] }]
   ```

5. `run.cmd funnel`. It prints the address and writes it to
   `data\tunnel-url.txt`.

The free plan covers all of this.

### Note for this machine

Astrill is running here, and two VPN clients on one Windows machine can fight
over the routing table and the DNS resolver. If Tailscale cannot connect while
Astrill is on, that conflict is the first thing to suspect: switch Astrill off,
confirm Tailscale works, then decide which one has to give way. Astrill is also
what breaks cloudflared, so the problem is not new — it is the same problem in a
different place.

## cloudflared quick tunnel — a throwaway address

```
run.cmd tunnel
```

Needs no account and no setup, which is its only advantage. The address changes
**every time cloudflared restarts**, and on this machine it restarts several
times a day because the VPN's resolver cannot reliably look up
`region1.v2.argotunnel.com`.

Everything built to paper over that churn became a problem of its own:

- a Vercel function held the permanent address and proxied every request to the
  board;
- each new hostname rewrote `BOARD_ORIGIN` and triggered a redeploy;
- the redeploys were frequent enough to trip GitHub's secondary rate limit, so
  the front door was often left pointing at a hostname that no longer existed;
- the function was billed for provisioned memory for the whole 1.2 s each
  proxied request waited, which exhausted the free tier and got the project
  deleted.

Keep it as the fallback for when Tailscale cannot run. If `VERCEL_TOKEN` and
`VERCEL_PROJECT` are set in `data\local.env`, the keeper will still update a
front door; leave them unset and it simply prints the address.

## Which the board will accept

`ALLOWED_HOSTS` gates the `Host` header, because serving on a hostname rather
than an IP invites DNS rebinding. Both `*.ts.net` and `*.trycloudflare.com` are
accepted by default — see `allowedHosts` in `src/config.js`.
