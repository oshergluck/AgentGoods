# Connecting agentgoods.ai

Everything that could be done without your accounts is done. What remains needs your Cloudflare and
your registrar, and this document is written from the deployment that actually exists — every
hostname and DNS value below was read back from Railway, not invented.

---

## What was built, and the one architectural decision

**The API and the observer UI now answer on a single origin.** The UI is compiled into the API
image and served by it, so:

```
https://agentgoods.ai/                          the human observer UI
https://agentgoods.ai/.well-known/aic-agent.json the live Agent manifest
https://agentgoods.ai/api/v1/...                 the API
https://agentgoods.ai/docs/agents                Agent documentation
```

You asked for same-origin if it was safe, and it is — it is also better here than the alternative:

- An Agent needs **one hostname and nothing else**. No `api.` subdomain to discover or guess.
- The browser's API calls become same-origin, so **CORS stops being load-bearing** for the UI. A
  CORS misconfiguration can no longer break the site.
- `/.well-known/aic-agent.json` is the **live document**, not a copy that can drift.
- One DNS record, one certificate, one thing to get right.

The cost is that the UI and API now deploy together. The standalone `frontend` service is still
deployed and working as a rollback (§Rollback).

### Verified as a zero-knowledge Agent

`backend/scripts/agent-smoke.mjs` starts from one origin and discovers everything else through the
public machine interface, reading nothing from the repository. **41/41 checks pass** against the
current deployment.

---

## The architecture that exists right now

| Railway service | Role | Public URL today |
|---|---|---|
| `backend` | **API + UI + manifest** | `https://<service>.up.railway.app` |
| `frontend` | UI only — rollback path | `https://<service>.up.railway.app` |
| `MongoDB` | database, private | internal only |
| `AgentGoods.ai` | **stray**, from the first failed deploy | none |

The custom domains are **already attached to the `backend` service**. You do not need to add them.

---

# A. Railway — already done

I added both domains and Railway returned these targets:

| Domain | Railway target |
|---|---|
| `agentgoods.ai` | `<service>.up.railway.app` |
| `www.agentgoods.ai` | `<service>.up.railway.app` |

**The two targets are different.** That is normal — Railway issues one per domain. Do not point
both at the same value.

Nothing further is needed in Railway before DNS.

---

# B. Cloudflare DNS — what to create

In Cloudflare, select **agentgoods.ai** → **DNS** → **Records**, and add exactly these two:

```text
Type:   CNAME
Name:   @
Target: <service>.up.railway.app
Proxy:  DNS only  (grey cloud)   ← see §E
TTL:    Auto
```

```text
Type:   CNAME
Name:   www
Target: <service>.up.railway.app
Proxy:  DNS only  (grey cloud)
TTL:    Auto
```

**On the apex CNAME.** A CNAME at the root is not legal DNS, but Cloudflare implements *CNAME
flattening*: it resolves the target and serves A records in its place. So entering a CNAME at `@`
is correct here and will work. You do not need an A record and you must not invent one.

---

# C. Existing DNS — check before you add

Before adding, look at what is already in the zone.

**Remove or edit only these, and only if present:**

- any existing **A**, **AAAA** or **CNAME** record on `@` — it conflicts directly with the new
  apex CNAME, and DNS will not let both exist
- any existing **A**, **AAAA** or **CNAME** on `www` — same reason
- Namecheap's **parking page** records, which are usually an A record on `@` and a CNAME on `www`
  pointing at `parkingpage.namecheap.com`

**Leave everything else alone.** In particular do not touch:

- **MX** records — deleting these silently breaks email for the domain
- **TXT** records — SPF, DKIM, DMARC, and any domain-verification token. Deleting a verification
  TXT can un-verify you somewhere you have forgotten about.
- **NS** and **SOA** — managed by Cloudflare
- any `_acme-challenge`, `_dmarc`, or vendor verification records

If you are unsure about a specific record, paste it to me rather than deleting it.

---

# D. SSL/TLS mode

Cloudflare → **SSL/TLS** → **Overview** → set:

```
Full (strict)
```

Railway terminates TLS with a valid publicly-trusted certificate, so Cloudflare can and should
verify it end to end.

**Do not choose Flexible.** Flexible makes Cloudflare talk to the origin over plain HTTP while
showing a padlock to the visitor. It is unencrypted on the second hop and the padlock is a lie
about it.

**Full (not strict)** would also work but accepts any certificate, including an invalid one, which
gives up the protection you are turning this on for.

---

# E. Proxy — start grey, then go orange

**Create both records as `DNS only` (grey cloud) first.**

Railway has to reach your domain to complete its certificate challenge. While Cloudflare proxies
the record, Cloudflare answers on Railway's behalf, the challenge never resolves to Railway, and
issuance silently never finishes. The symptom is a certificate error that looks like a Railway
problem and is not.

**Sequence:**

1. Add both records as **DNS only**.
2. Wait for Railway to show both domains as issued (the service's Settings → Networking page).
3. Verify `https://agentgoods.ai/` loads.
4. **Then** switch the proxy to **Proxied (orange)** if you want Cloudflare's CDN and protection.
5. Re-run the checks in §G — the proxy is a new network path and deserves its own verification.

Orange-cloud is optional. Everything works on grey.

### If you turn the proxy on

Cloudflare must not cache authenticated or per-wallet responses. The application already sends
`Cache-Control: private, no-store` on those, which Cloudflare respects by default — verified:
`/api/v1/me` returns `private, no-store, max-age=0`.

If you later add a caching rule, exclude at minimum:

```
/api/v1/me
/api/v1/auth/*
/api/v1/dividends/me
/api/v1/webhooks*
/api/v1/stores/*/products/*/quote
```

and leave POST uncached entirely.

---

# F. Environment variables — after DNS resolves

Two variables, on the **backend** service only. Do not change them before DNS works, or the
service will be advertising a domain that does not yet answer.

```text
VARIABLE:         PUBLIC_BASE_URL
old value:        https://<service>.up.railway.app
new value:        https://agentgoods.ai
service:          backend
requires redeploy: YES
```

```text
VARIABLE:         PUBLIC_WEB_URL
old value:        https://<service>.up.railway.app
new value:        https://agentgoods.ai
service:          backend
requires redeploy: YES
```

```text
VARIABLE:         CORS_ORIGINS
old value:        https://<service>.up.railway.app,https://<service>.up.railway.app
new value:        https://agentgoods.ai,https://www.agentgoods.ai
service:          backend
requires redeploy: YES
```

Say the word and I will set these and redeploy.

**`ESH_ENVIRONMENT` stays `PROVING`.** It is currently a Base **Sepolia** deployment with test
USDC. Setting it to `PRODUCTION` would make the startup guard demand a mainnet manifest and a
timelock, and would be a false claim about what this is. That change belongs with the mainnet
deployment, not with the domain.

---

# G. Verification checklist

After DNS resolves, check each of these:

| URL | Expected |
|---|---|
| `https://agentgoods.ai/` | the observer UI, valid certificate, no warning |
| `https://www.agentgoods.ai/` | the same UI |
| `https://agentgoods.ai/.well-known/aic-agent.json` | JSON, `apiBaseUrl` reads `https://agentgoods.ai` |
| `https://agentgoods.ai/api/v1/schema` | JSON, `chain.chainId` is `84532` |
| `https://agentgoods.ai/api/v1/openapi.json` | JSON, 47 paths including `/api/v1/me` |
| `https://agentgoods.ai/api/v1/contracts` | JSON, addresses match the manifest |
| `https://agentgoods.ai/api/v1/me` | **401** — correct; it is authenticated |
| `https://agentgoods.ai/api/v1/status` | `indexerStatus: "live"`, `lagBlocks` small |
| `https://agentgoods.ai/health/ready` | `200`, `status: "ready"` |
| `http://agentgoods.ai/` | redirects to `https://` |

A `401` on `/api/v1/me` is a pass, not a failure. It proves authentication is enforced.

---

# H. The Agent test — one command, one origin

This is the proof that matters. It starts from nothing but the domain and discovers the entire
Agent interface, never touching a Railway hostname:

```bash
node backend/scripts/agent-smoke.mjs https://agentgoods.ai
```

Expected: **41 checks, all PASS.**

It deliberately fails if the manifest still advertises a `*.up.railway.app` or `localhost` URL, so
it catches exactly the mistake of connecting the domain and forgetting §F.

A one-liner if you prefer:

```bash
curl -s https://agentgoods.ai/.well-known/aic-agent.json | head -40
```

Everything an Agent needs is reachable from that one document.

---

# I. Rollback

Nothing here is one-way.

- The Railway URLs **keep working**. I have not removed them, and they should stay until the domain
  has been stable for a while.
- `https://<service>.up.railway.app` still serves the standalone UI.
- To undo: revert the three variables in §F and redeploy. DNS can be removed in Cloudflare.
- **HSTS preload is deliberately off.** It ships in browser binaries and is effectively permanent;
  it is not something to enable as a side effect of a cutover.

---

# What is NOT ready, and should not be claimed

**This is not a production deployment yet, and the domain does not change that.**

- The contracts are on **Base Sepolia (84532)** with a **test USDC** we deployed. They are not
  mainnet contracts and no mainnet contracts exist yet.
- `ESH_ENVIRONMENT` is `PROVING`.
- No timelock exists, so a single key still holds authority. The deployment gate refuses
  `PRODUCTION` for exactly this reason.
- The 72-hour proving run has not been done.

Connecting the domain now is still worth doing — it makes the real Agent surface reachable at its
real address and lets everything be exercised there. But `agentgoods.ai` will be serving a testnet
until the mainnet deployment happens, and the manifest says so in `environment`.
