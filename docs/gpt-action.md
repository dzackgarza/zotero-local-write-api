# Custom GPT Action for the Zotero Local Write API

This walkthrough exposes the plugin's endpoints at `https://zotero-write.dzackgarza.com` through a Cloudflare named tunnel, then imports them into a Custom GPT as an Action.
The result: a GPT that can write items, attach fulltext, and report the plugin version against the live Zotero library on this machine.

## Architecture

```
Custom GPT Action ──HTTPS──▶ Cloudflare edge
                                  │  (named tunnel "zotero-write",
                                  │   ingress limited to /write /attach
                                  │   /version /openapi.yaml)
                                  ▼
                     cloudflared (systemd user unit)
                                  │
                                  ▼
                     Zotero HTTP server 127.0.0.1:23119
                     └─ this plugin: Bearer-token check on /write and /attach
```

Two layers do the guarding:

- **Ingress path filter** — port 23119 also hosts Zotero's unauthenticated local read API and the connector endpoints.
  The tunnel config exposes exactly the four plugin routes; everything else answers 404 at the edge.

- **Plugin Bearer auth** — with the `extensions.zotero.localWriteAPI.token` pref set, `/write` and `/attach` require `Authorization: Bearer <token>`. `/version` and `/openapi.yaml` stay public: the first is the health check, the second is the schema the GPT builder imports.
  With the pref unset the plugin behaves exactly as before (loopback-only, no auth).

The plugin cannot tell a loopback request from a tunnelled one — cloudflared forwards to `127.0.0.1:23119`, so both look identical to Zotero's server.
So "unset pref = open" is safe only on loopback, and the guard against exposing an unauthenticated write surface lives at the deployment boundary: `just tunnel-setup`, `tunnel-install`, and `tunnel-restart`, plus the unit's `ExecStartPre` on every start (including at boot), all run `dev/cloudflared/require-write-token.sh`, which probes the **live** plugin (an unauthenticated `POST /write` must return 401) and refuses otherwise.
The add-on also logs its auth state at startup (`Bearer auth ENABLED`/`DISABLED`).

That start-time guard is no longer the only one.
The plugin also refuses `/write` and `/attach` per request whenever `publicBaseURL` is set and the token pref is not, so clearing the token while the tunnel is up now returns 401 immediately rather than leaving the surface exposed until the next restart.
`publicBaseURL` is the plugin's own record that it is reachable off-loopback, which is what lets it tell the two regimes apart.
Unauthenticated on loopback with neither pref set remains the documented default.

There is no Cloudflare Access policy in front, deliberately: Access needs two headers (`CF-Access-Client-Id`/`-Secret`) and a Custom GPT Action can send exactly one credential.

## One-time setup

Prerequisites: `cloudflared` is logged in (`~/.cloudflared/cert.pem` exists), Zotero is running with plugin ≥ 3.4.0 installed.

1. **Mint a token** and store it where the house keeps secrets:

   ```bash
   openssl rand -hex 32
   # add to ~/.envrc:  export ZOTERO_WRITE_API_TOKEN="<the token>"
   direnv allow ~
   ```

2. **Set the Zotero prefs.** Zotero → Settings → Advanced → Config Editor:

   - `extensions.zotero.localWriteAPI.token` → the same token (string; create it if absent)

   - `extensions.zotero.localWriteAPI.publicBaseURL` → `https://zotero-write.dzackgarza.com`

   The second pref makes `/openapi.yaml` advertise the public server URL instead of `http://127.0.0.1:23119`, so the GPT builder imports a schema that already points at the tunnel.
   The next step probes the live plugin, so the pref takes effect immediately once set — no need to wait for Zotero to flush it to disk.

3. **Create the tunnel and DNS route, install the service:**

   ```bash
   just tunnel-setup     # creates named tunnel "zotero-write", routes DNS,
                         # writes ~/.cloudflared/zotero-write.yml
   just tunnel-install   # installs + enables the systemd user unit
   ```

   Both recipes (and the unit's `ExecStartPre` on every start) abort unless the live write surface rejects an unauthenticated request, so the tunnel cannot start while `/write` is open.

4. **Verify from outside:**

   ```bash
   curl https://zotero-write.dzackgarza.com/version          # 200 + version JSON
   curl -X POST https://zotero-write.dzackgarza.com/write \
        -H 'Content-Type: application/json' -d '{}'          # 401 without token
   curl https://zotero-write.dzackgarza.com/api/users/0/items # 404: read API not exposed
   ```

   With `ZOTERO_WRITE_API_TOKEN` exported (step 1) and matching the pref, `just smoke-live` additionally proves the bearer gate against the running instance: `/write` returns 401 without the token, 401 with a wrong token, and passes auth with the right one.

## Import into a Custom GPT

1. ChatGPT → Explore GPTs → **Create** → Configure → **Create new action**.

2. Authentication → **API Key** → Auth Type **Bearer** → paste the token.

3. Schema → **Import from URL** → `https://zotero-write.dzackgarza.com/openapi.yaml`.

4. The four operations appear.
   Test with a prompt like *"What version is the Zotero write API running?"* (calls `/version`), then *"File this paper: …"* (calls `/write`).

## Operations

```bash
just tunnel-status     # unit + connector state
just tunnel-logs       # follow cloudflared logs
just tunnel-restart
just tunnel-uninstall  # stop + disable the unit (tunnel and DNS survive)
```

Token rotation: mint a new token, update the Zotero pref and `~/.envrc`, then update the key in the GPT's Action auth.
No service restart needed — the plugin reads the pref per request.

Teardown beyond the unit: `cloudflared tunnel delete zotero-write` and remove the `zotero-write` CNAME in the Cloudflare dashboard.
