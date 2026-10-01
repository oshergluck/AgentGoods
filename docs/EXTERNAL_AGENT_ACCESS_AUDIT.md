# External Agent access audit

**Incident:** an external machine client could not fetch `https://agentgoods.ai/`,
`/.well-known/aic-agent.json`, `/api/v1/schema` or `/api/v1/openapi.json`, while the same domain
worked normally in a browser.

**Status: resolved.** Verified from outside with a plain HTTP client. No action is required from
you; the one item left is optional and listed in §10.

**Date:** 2026-09-23. **Environment:** `PROVING`, chainId 84532 (Base Sepolia).

---

## 1. Root cause

**The failure was in our own application, not in any infrastructure layer.**

`TRUST_PROXY_HOPS` defaulted to `0` and was never set in production. With `trust proxy` at 0,
Express ignores `X-Forwarded-For` entirely and `req.ip` is the socket peer — which behind
Railway's edge is *Railway's address*, identical for every client on earth.

The global rate limiter keys on `req.ip`:

```ts
return `ip:${req.ip ?? "unknown"}`;
```

So every visitor on the internet shared **one 600-request-per-minute counter**, and that limiter
was registered *before* the discovery routes:

```
app.use(limiter(60_000, RATE_LIMIT_GLOBAL_PER_MIN, "global"));   // line 163
app.use(systemRouter());                                          // line 165
```

Once the shared bucket was exhausted, **every path returned 429** — the root, the manifest, the
schema and the OpenAPI document included. Exhaustion was easy: a single page load is a dozen
requests, and an open price chart polls once per second, so one human with a chart open consumes
60+ requests a minute against the same counter an Agent needs.

That explains every part of the report precisely:

| Symptom | Explanation |
|---|---|
| All four paths failed together | The limiter sits in front of all of them |
| A browser worked | Its requests landed in a window that still had allowance |
| It failed "several times" then worked when tested | The window resets every 60 seconds |
| No error in any log that looked like a fault | 429 is a designed response, not an error |

A second, independent defect was found and fixed during the same investigation: the SPA fallback
rejected `HEAD` (§4.7).

### Why the count was wrong twice

The first fix set `TRUST_PROXY_HOPS=1`. Measuring the real chain showed that was still wrong:

```
x-forwarded-for: "216.73.217.141, 152.233.47.69"
                  ^ real client     ^ Railway edge
```

`trust proxy` is a count of hops trusted **from the right**. At `1`, `req.ip` resolved to
`152.233.47.69` — a Railway edge node from a small pool, still shared by many clients. The correct
value is **2**. This is recorded because it is the kind of detail that gets "fixed" to a
plausible-looking wrong number.

---

## 2. Layer-by-layer findings

Each layer was tested directly rather than assumed. **Cloudflare was explicitly not assumed to be
the cause, and was not the cause.**

| Layer | Result | Evidence |
|---|---|---|
| DNS | **OK** | `A agentgoods.ai → 69.46.46.70`, single record, no stale A, no conflicting CNAME, no duplicates. NS = `armfazh.ns.cloudflare.com`, `rihana.ns.cloudflare.com` |
| IPv6 | **No AAAA, and that is correct** | No AAAA on `agentgoods.ai` *or* on the Railway origin `<service>.up.railway.app`. There is no broken AAAA — the dangerous case. See §5 |
| Cloudflare | **Not in the request path** | `Server: railway-hikari`, `x-railway-edge: ams1`, **no `cf-ray`**. The apex is DNS-only (grey cloud); the A record is Cloudflare CNAME-flattening the Railway target. No WAF, bot mode, challenge or Worker can apply |
| TLS | **OK** | `Verification: OK`, `Verify return code: 0`. Chain complete: `CN=agentgoods.ai` → `Let's Encrypt YR2` → `ISRG Root YR` → cross-signed by `ISRG Root X1`. TLSv1.3, correct SNI, hostname match. Not Flexible SSL — Cloudflare is not terminating at all |
| Railway custom domain | **OK** | `agentgoods.ai` → the `backend` service, which serves API **and** UI **and** manifest from one origin |
| Routing / reverse proxy | **OK** | Protocol routes registered before static; no redirect chain on any tested path |
| Frontend catch-all | **OK, after a fix** | Never swallows `/api/*` or `/.well-known/*`; verified by Content-Type. `HEAD` was broken and is fixed (§4.7) |
| Backend | **ROOT CAUSE** | Shared rate-limit bucket, §1 |
| Discovery endpoints | **OK, after the fix** | §7 matrix |

---

## 3. DNS detail

```
A      agentgoods.ai     69.46.46.70          (Cloudflare flattening of the Railway target)
AAAA   agentgoods.ai     none
NS     agentgoods.ai     armfazh.ns.cloudflare.com, rihana.ns.cloudflare.com
```

No stale A record, no broken AAAA, no conflicting CNAME at the apex, no duplicate records, no
split DNS, no DNSSEC failure observed. **No DNS change was made, and no MX or TXT record was
touched.**

---

## 4. Changes made

### 4.1 `TRUST_PROXY_HOPS = 2` (Railway variable, production)

`req.ip` is now the real client. Set via `railway variables --service backend`, with
`--skip-deploys` so it applied with the deliberate deploy rather than mid-investigation.

### 4.2 Discovery gets its own rate-limit budget

`backend/src/app.ts`. Public protocol discovery is now counted separately from everything else,
so unrelated traffic can never make the protocol undiscoverable again:

```ts
const PUBLIC_DISCOVERY_PATHS = new Set([
  "/.well-known/aic-agent.json",
  "/api/v1/schema",
  "/api/v1/openapi.json",
  "/api/v1/contracts",
]);
```

Discovery: **300/min per client**. Everything else: **600/min per client**. Discovery is still
rate limited — it was not made unlimited, and no WAF or protection was disabled.

### 4.3 A runtime guard against this recurring

Both directions of a wrong hop count fail silently — too low shares one bucket globally, too high
lets a client spoof `X-Forwarded-For` and bypass limits entirely. Neither produces anything that
looks like an error. The app now measures the real chain on its first request and says so:

```
proxy chain depth matches TRUST_PROXY_HOPS; rate limits key on the real client
  forwardedDepth=2 trustProxyHops=2
```

A mismatch logs at **warn** with which direction it is wrong in.

### 4.4 `backend/test/agent-accessibility.test.ts` — 10 tests

Discovery reachable without credentials and returning JSON; no challenge markers; discovery and
ordinary reads on separate budgets; discovery still finite; `/me` a documented 401; `/me` never
shared-cacheable; and a pin against "fixing" a future reachability problem with wildcard CORS.

### 4.5 `backend/scripts/smoke-agent-production.mjs` — 43 checks

Takes only a base URL. **The API base, schema URL and OpenAPI URL are read out of the manifest,
never hard-coded** — so it keeps working if the API ever moves to `api.agentgoods.ai`, and a
discovery failure cannot be masked by a script that already knew the answer. Plain HTTP: no
browser, no JavaScript, no cookies, no retries that could hide an intermittent limit. Exits
non-zero, so it can gate a deploy.

### 4.6 `robots.txt`

`User-agent: *` / `Allow: /` already permitted every crawler, but `GPTBot`, `OAI-SearchBot`,
`ChatGPT-User`, `ClaudeBot`, `PerplexityBot`, `Googlebot` and others are now named explicitly with
the same permissions, so there is nothing left to infer. No protocol resource is disallowed; the
only `Disallow` entries are authenticated per-wallet paths, which have nothing to index.

### 4.7 `HEAD` is answered wherever `GET` is — separate bug, found during the audit

The SPA fallback was registered with `app.get` and then re-checked `req.method !== "GET"` inside
the handler. Express dispatches `HEAD` to a `GET` handler, so **every `HEAD` fell through to the
404 handler**: `GET /` returned 200 and `HEAD /` returned 404, on the same URL, at the same
moment. Crawlers, link unfurlers and agent browsers preflight with `HEAD`.

Fixed, plus `backend/test/crawlability.test.ts` (11 tests) asserting `HEAD` status matches `GET`
on every public path, while `POST` still falls through rather than receiving the app shell.

### 4.8 `/sitemap.xml` now exists

`robots.txt` advertised it and it did not exist, so the SPA fallback answered with the app shell:
200, `text/html`, where XML was declared. A broken sitemap is worse than none. Now generated from
indexed stores and products, bounded at 2,000 URLs each, against the canonical web origin.

---

## 5. IPv4 / IPv6

`curl -4` succeeds. There is **no AAAA record** on `agentgoods.ai`, and none on the Railway origin
either — so this is Railway's platform behaviour, not a misconfiguration or a stale record on our
side.

**No broken AAAA exists**, which is the important part: a published-but-unreachable AAAA is what
strands machine clients, because many simple HTTP clients do not implement the Happy Eyeballs
fallback a browser does. An *absent* AAAA is resolved cleanly and the client uses IPv4.

Residual risk: a strictly IPv6-only client cannot reach the domain. Not fixable by us — it needs
IPv6 at the Railway origin. Recorded in §10.

---

## 6. TLS

```
0 s:CN=agentgoods.ai            i:C=US, O=Let's Encrypt, CN=YR2
1 s:C=US, O=Let's Encrypt, CN=YR2   i:C=US, O=ISRG, CN=Root YR
2 s:C=US, O=ISRG, CN=Root YR        i:C=US, O=ISRG, CN=ISRG Root X1
Verification: OK          Verify return code: 0 (ok)
TLSv1.3, TLS_AES_256_GCM_SHA384
```

Valid, hostname matches, chain complete and correctly ordered, cross-signed to `ISRG Root X1` so
trust stores without the newer `ISRG Root YR` still verify. Cloudflare is not terminating TLS at
all, so Flexible SSL is not in play. `No ALPN negotiated` — HTTP/1.1 only, which no HTTP client
requires HTTP/2 over.

---

## 7. Endpoint matrix (external, after the fix)

Plain HTTP client, no browser, no credentials, no cookies.

| Path | Status | Content-Type | Cache-Control | Redirects |
|---|---|---|---|---|
| `/` | 200 | `text/html; charset=UTF-8` | `no-cache` | none |
| `/` (HEAD) | 200 | `text/html; charset=UTF-8` | `no-cache` | none |
| `/.well-known/aic-agent.json` | 200 | `application/json` | `public, s-maxage=60` | none |
| `/api/v1/schema` | 200 | `application/json` | `public, s-maxage=30` | none |
| `/api/v1/openapi.json` | 200 | `application/json` | `public, s-maxage=60` | none |
| `/api/v1/contracts` | 200 | `application/json` | `public, s-maxage=15` | none |
| `/api/v1/me` (no auth) | **401** | `application/json` | `private, no-store, max-age=0` | none |
| `/docs/agents` | 200 | `text/html` | `no-cache` | none |
| `/robots.txt` | 200 | `text/plain` | `no-cache` | none |
| `/sitemap.xml` | 200 | `application/xml` | `public, s-maxage=300` | none |

No redirect loops anywhere. Slowest response 733 ms. No HTML challenge, no CAPTCHA, no cookie
requirement, no JavaScript requirement on any path.

`/api/v1/me` returns a documented error, not an infrastructure failure:

```json
{"error":{"code":"INVALID_API_KEY",
          "message":"Missing Authorization: Bearer <api key> header",
          "documentation":"/docs/agents#error-invalid_api_key"}}
```

### Rate limiting, as now advertised

```
/.well-known/aic-agent.json   ratelimit: limit=300 ...   (discovery budget)
/api/v1/schema                ratelimit: limit=300 ...   (discovery budget)
/api/v1/stores                ratelimit: limit=600 ...   (general budget)
```

---

## 8. CORS and caching

`Origin: https://evil.example` against `/api/v1/me` returns **no**
`Access-Control-Allow-Origin` at all — neither the foreign origin nor `*`. `OPTIONS` preflight is
answered `204`. Allowed origins are `https://agentgoods.ai` and `https://www.agentgoods.ai`, fail-
closed in production against localhost, non-HTTPS and `*.up.railway.app`.

Private state is never shared-cacheable: `/api/v1/me` is `private, no-store, max-age=0`. Public
schema, manifest, OpenAPI and contracts carry bounded `s-maxage` with freshness semantics. No
Cloudflare cache applies, because Cloudflare is not proxying.

---

## 9. Verification performed

**Proof the buckets were shared (before):** twelve requests each claiming a different
`X-Forwarded-For` client. The counter decremented regardless of the claimed address — one bucket.

**Proof they are per-client (after):** read my own allowance, drove six requests from a genuinely
different source IP (Jina's infrastructure), read it again. My counter moved by exactly my own two
requests; the foreign client's six consumed none of it.

**Proof from outside this network:** the site was fetched successfully by two independent
third-party services — `r.jina.ai` and the W3C validator — from their own infrastructure.

**Automated:**

- `backend/scripts/smoke-agent-production.mjs https://agentgoods.ai` → **43/43**
- `backend/scripts/agent-smoke.mjs https://agentgoods.ai` → **41/41** (zero-knowledge)
- `npm test` → **193/193**
- `scan-secrets` → clean, 221 files

### Contract safety

**No contract address was changed, added or invented as part of this work.** The manifest
addresses are the live, Etherscan-verified Base Sepolia deployment; they are **not** local or mock
contracts. The manifest honestly reports `environment: PROVING` and `chainId: 84532`. It contains
no `localhost`, `127.0.0.1`, `0.0.0.0`, `up.railway.app`, `example.com` or mock URL — asserted in
the smoke test so it cannot regress.

---

## 10. Remaining risks and optional actions

**Nothing is required from you.** These are judgement calls, not defects.

1. **No IPv6.** A strictly IPv6-only client cannot reach the domain. Railway publishes no AAAA for
   the origin, so this is not fixable from DNS — adding an AAAA ourselves would create exactly the
   broken record that strands machine clients. Only worth revisiting if Railway ships IPv6.

2. **Rate-limit counters are per-instance and in memory.** With more than one replica the
   effective ceiling is N × the configured limit. This fails *open*, never closed, so it cannot
   cause this incident again. A shared store would only be needed if the limits ever become an
   enforcement boundary rather than an abuse control.

3. **Shared-egress clients.** Agents behind one NAT share a per-IP bucket. 300/min for discovery
   and 600/min for reads is generous for cacheable documents, and raising it is a variable change
   if a real platform ever needs it.

4. **Cloudflare is DNS-only.** That is why no challenge could block anything, and it is currently a
   feature. If the orange cloud is ever enabled, Bot Fight Mode and Managed Challenges **will**
   break machine discovery. Before enabling it, add a WAF skip rule for
   `/.well-known/*`, `/api/*`, `/robots.txt` and `/sitemap.xml`, and re-run
   `smoke-agent-production.mjs` — it is written to catch exactly that.

5. **`ESH_ENVIRONMENT=PROVING`,** so HSTS is deliberately off and the deployment does not claim to
   be `PRODUCTION`. That remains correct until the proving period completes.

---

## 11. Preventing recurrence

| Guard | Catches |
|---|---|
| `agent-accessibility.test.ts` | Discovery starved, made unlimited, or opened to any origin |
| `crawlability.test.ts` | `HEAD` diverging from `GET`; the sitemap regressing to HTML |
| `smoke-agent-production.mjs` | Anything only visible from outside, over plain HTTP |
| Proxy-chain self-check | The platform changing hop depth under us, in either direction |

The smoke test is the one that would have caught the original incident, and it is the one to run
after any infrastructure change — Cloudflare setting, Railway domain, proxy, or WAF.


---

## 12. Follow-up: why a crawler kept reporting "blocked" after the fix

Reported after §1 was deployed and verified: ChatGPT still said the site was blocked.

It was not a second outage. The site was returning 200 on every path, including to OpenAI's exact
published user agents (`GPTBot/1.2`, `OAI-SearchBot/1.0`, `ChatGPT-User/1.0`), on the apex and on
`www`, over both schemes, with no redirects.

**The cause is that `robots.txt` was itself served from the exhausted bucket.**

`robots.txt` is a static file, so it was covered by the general 600/min limiter rather than the
discovery budget. While the shared bucket was exhausted, `GET /robots.txt` returned **429** along
with everything else.

RFC 9309 §2.3.1.4 makes that catastrophic rather than merely annoying:

> If the crawler encounters an unsuccessful status code when fetching robots.txt, the crawler MAY
> assume complete disallow.

The major crawlers, OpenAI's included, do exactly that **and cache the verdict for up to 24
hours**. So one 429 on one path did not degrade one request — it removed the entire site from that
crawler for a day, and the verdict outlived the repair by design. Every subsequent fetch was
refused by the crawler before a request was ever made, which is why nothing could be observed from
the server side.

A 429 on `robots.txt` is amplified perhaps a thousandfold compared to a 429 on any other path.

### Fix

`/robots.txt` and `/sitemap.xml` moved into the budget that ordinary traffic cannot starve
(`limit=300`, verified live). Thirty rapid consecutive fetches: **0 failures**.

`backend/test/agent-accessibility.test.ts` gained assertions that both paths return 200 and do
**not** share the general budget. That suite now provisions a real static root, because without
`FRONTEND_DIST` the app serves no `robots.txt` at all and the assertion would have passed for the
wrong reason — the same blind spot that let the original bug through.

### Confirming it from outside

`www.agentgoods.ai` is a **separate origin** for robots.txt caching, and is fully functional
(`/`, `/robots.txt`, `/.well-known/aic-agent.json`, `/api/v1/schema` all 200). If a crawler can
fetch `https://www.agentgoods.ai` while refusing `https://agentgoods.ai`, that is conclusive: the
difference is the cached verdict, not the server.

Its manifest still advertises `apiBaseUrl: https://agentgoods.ai`, which is correct — canonical
identity must not change with the hostname a client happened to arrive on.

### Residual

Nothing to fix. The cached disallow expires on its own and cannot be flushed from our side.
`Cache-Control: no-cache` on `robots.txt` encourages revalidation at the next attempt.


---

## 13. Follow-up 2: the remaining refusal is OpenAI's, and it is about the domain

`www` was reported failing too, which rules out §12's cached-robots verdict as the explanation —
a crawler caches robots per origin, and `www` had never been fetched before.

So the investigation was reopened. Every hypothesis below was tested rather than argued.

### Hypotheses eliminated

| Hypothesis | Test | Result |
|---|---|---|
| Cloudflare proxy/WAF on `www` (even though the apex is grey) | Response headers on `www` | `Server: railway-hikari`, **no `cf-ray`**. DNS-only, same as the apex. No Cloudflare rule can apply to either |
| **IPv6** — suggested by the reporting agent | `curl -6` both hosts; AAAA lookups across the whole chain | No IPv6 anywhere (exit 6). **But OpenAI publishes their fetcher ranges and they are 100% IPv4**: `chatgpt-user.json` 229 prefixes, `gptbot.json` 18, `searchbot.json` 39, **zero IPv6 in all three**. The absence of AAAA cannot be the cause |
| Geography / a bad Railway edge | 12 distributed nodes via check-host.net | Reachable from **11/12**, including the US node. One Romanian node timed out at 3s |
| Intermittent connection failures | 25 sequential requests per host | `agentgoods.ai` 25/25, `www.agentgoods.ai` 25/25. Only the unused `<service>.up.railway.app` fails, and it is not referenced by anything |
| robots.txt disallow | Parsed the live file with a real robots parser for `ChatGPT-User`, `GPTBot`, `OAI-SearchBot` | Every tested path permitted. No BOM, clean UTF-8 |
| TLS trust | Verified against the certifi bundle, which does **not** contain `ISRG Root YR` | Verified OK — the cross-sign to `ISRG Root X1` works |
| User-agent filtering | OpenAI's three exact published UA strings, every path, both hosts | All 200 |

### What is left

```
registration   2026-09-22T22:31:03Z
status         ["client transfer prohibited", "add period"]
```

**The domain was registered less than 24 hours before the report, and is still inside the ICANN
add-grace period.**

A newly-registered domain is the single strongest signal used by URL-reputation systems, because
it is the defining characteristic of phishing and scam infrastructure. ChatGPT's browsing tool
applies such a check before it issues a request, and reports the outcome as "blocked" — which is
why nothing appears in our logs: **no request is ever made**. The content profile here (tokens,
wallets, dividends, a bonding curve) sits in the category those classifiers weight most heavily.

This is consistent with every observation: uniform failure across both hostnames and all paths,
"blocked" rather than a timeout or a connection error, and a site that is simultaneously reachable
from eleven countries.

### This is not fixable in the application

Nothing in the server, DNS, TLS, routing or headers is wrong. §1–§12 fixed four real defects, and
they were worth fixing — the robots.txt budget in §12 in particular would have caused exactly this
symptom later, for real — but none of them is what is refusing the fetch now.

What actually changes a reputation verdict:

1. **Time.** Domain age is the dominant term. Days to weeks.
2. **Being indexed.** Submit the domain and `https://agentgoods.ai/sitemap.xml` to **Bing Webmaster
   Tools** and Google Search Console. Bing matters most here — ChatGPT's browsing has historically
   leaned on Bing's index and its safety classification, and an unindexed domain has nothing to
   weigh against its newness. The sitemap and `robots.txt` now work correctly, so the site is ready
   to be indexed; it has simply never been submitted.
3. **Inbound links from established domains.**

No action is required on the infrastructure. Re-run
`node backend/scripts/smoke-agent-production.mjs https://agentgoods.ai` at any time to confirm the
server side stays correct — it was 43/43 throughout this investigation.


---

## 14. Follow-up 3: "cannot find" is a different failure from "cannot reach"

Reported next: Claude's chat also could not find the site. That turned out to be a **third,
unrelated** problem, and the distinction matters because the remedy is different.

### Claude's fetcher reaches the site perfectly

Tested directly, not inferred. `WebFetch` — the same class of infrastructure an assistant browses
with — returned live content from both:

```
https://agentgoods.ai/.well-known/aic-agent.json
  -> apiBaseUrl: https://agentgoods.ai   environment: PROVING   (full description returned)

https://agentgoods.ai/
  -> "AgentGoods.AI — Autonomous Agent Marketplace"
```

So reachability is confirmed working from a second independent assistant platform. Combined with
§13, that isolates ChatGPT's refusal to ChatGPT's own policy layer.

### What actually failed was SEARCH

A web search for `agentgoods.ai` returns **zero results for the domain**. Nothing points at it,
nothing has indexed it, and it is one day old. An assistant asked to "find" a site searches for
it, gets nothing, and reports that it cannot find it — which is literally true and has nothing to
do with the server.

### The site is ready to be indexed

Checked, because submitting a site that indexes badly wastes the one thing that fixes this — time.
The root serves **963 characters of real visible text with no JavaScript**, including the machine
entrypoint, the endpoint list and the API-key/wallet boundary. Plus a valid `sitemap.xml`, a
permissive `robots.txt`, a canonical link, title, description and OG tags.

Nothing needed fixing. It had simply never been submitted anywhere.

### Submitted via IndexNow

`backend/scripts/indexnow-submit.mjs`. IndexNow is the one index submission that needs **no
account**: host a key file at the domain root, POST a URL list. Bing, Yandex, Seznam and Naver
consume it, and Bing is the one that matters most here — assistant browsing tools lean on its
index and its safety classification, and a domain with no index presence has nothing to weigh
against its newness.

```
key       https://agentgoods.ai/a22261e8df54377d994b03917e1a930a.txt   (verified served)
urls      13, read from the live sitemap so they cannot drift
result    202 Accepted
```

The script reads URLs from `/sitemap.xml` rather than a hard-coded list, so new stores and
products are picked up automatically. It verifies the key file is served **before** submitting,
because IndexNow validates the key asynchronously and a broken key produces a silent no-op that
returns 200.

### Still requires an account, so still yours to do

| Action | Why |
|---|---|
| **Bing Webmaster Tools** — add `agentgoods.ai`, submit `https://agentgoods.ai/sitemap.xml` | IndexNow pushes URLs but does not register the site. Bing is the index assistant browsing leans on |
| **Google Search Console** — add the property, submit the same sitemap | Google does not support IndexNow at all |

Both need a login I do not have. If verification needs an HTML file or meta tag, give me the token
and I will serve it — the mechanism is already in place, the same way the IndexNow key file is.

### Expected timeline

Days, not minutes, and domain age is the dominant term in every reputation model involved. Nothing
further on the infrastructure will speed it up.


---

## 15. Follow-up 4: the root was reachable, the manifest was not

Reported once the domain became reachable: `/` worked, but the Agent bootstrap still broke at step
two — `/.well-known/aic-agent.json`, `/api/v1/schema` and `/api/v1/openapi.json` all failed for the
same client that had just read the root.

The reporting agent suggested routing, a Cloudflare rule or Railway service mapping. It was none of
those, and the correlation says so precisely:

| Path | Result | Content-Type |
|---|---|---|
| `/` | reachable | `text/html` |
| `/docs` | reachable | `text/html` |
| `/.well-known/aic-agent.json` | **not** | `application/json` |
| `/api/v1/schema` | **not** | `application/json` |
| `/api/v1/openapi.json` | **not** | `application/json` |

**The split is exactly `text/html` versus `application/json`, not the path prefix.** `/docs` is an
HTML page served by the same SPA fallback and it works; `/.well-known/*` and `/api/*` are different
routers with different middleware, and both fail identically. No routing rule partitions a request
space that way. A content-type does.

Some assistant browsing tools fetch through a browser-shaped pipeline and cannot render a raw JSON
response: the request succeeds, and the tool reports the resource as unavailable. Which is why
nothing appeared in our logs as an error — from the server's side these were ordinary 200s.

For this product that is fatal rather than cosmetic. The root page tells an Agent "start here" and
points at the manifest. If the manifest is the one document such a client cannot read, the chain
breaks at step two and everything downstream is unreachable.

### Fix: content negotiation, with the emphasis on *strictly*

`backend/src/http/contentNegotiation.ts`. JSON stays canonical for every client that can accept it;
HTML is served only when the client's stated preference for HTML is **strictly** stronger than for
JSON, compared by q-value.

| `Accept` | Served |
|---|---|
| absent | JSON |
| `*/*` (curl, most Agent clients) | JSON |
| `application/json` | JSON |
| `text/html,application/json` (equal) | **JSON** — ties go to canonical |
| `text/html;q=0.5,application/json;q=0.9` | JSON |
| `text/html,…,*/*;q=0.8` (a browser) | HTML |

Ties going to JSON is the deliberate part. A client that does not express a preference is treated
as a machine, because guessing wrong in that direction costs nothing and guessing wrong in the
other breaks every conforming Agent.

The HTML representation is not a summary. It carries the document verbatim in a `<pre>` block —
verified live: 14,323 bytes of HTML containing 12,374 characters of JSON that parses back to the
identical document — plus `<link rel="alternate" type="application/json">`, a visible canonical
URL, and an explicit instruction to send `Accept: application/json` to get the JSON directly. A
client that lands on the HTML can still find and quote the real thing.

`Vary: Accept` is set on every one of these responses. Without it a shared cache could hand HTML to
a client that asked for JSON, which would break conforming Agents intermittently and be extremely
hard to reproduce.

It is served under the API's strict CSP (`default-src 'none'`), so the page carries no script and
no external resource — inline style only, or it would be blocked by our own headers.

### Verified live

```
                        manifest      schema        openapi       contracts
curl (*/*)              json          json          json          json
Agent (application/json) json         json          json          json
browser-shaped          text/html     text/html     text/html     text/html
```

`smoke-agent-production.mjs` **43/43** and `agent-smoke.mjs` **41/41** after the change — machine
clients are unaffected, which is the property that mattered.

`backend/test/content-negotiation.test.ts` — 37 tests, most of them on the negotiation table
itself rather than end to end, because the entire risk of this feature is a future edit that lets
a `*/*` client receive HTML.

### Deployment note

Three `railway up --ci` runs built and pushed images that were never promoted — the container kept
serving the previous build while the CLI reported "Deploy complete", and log streaming failed each
time with "Failed to retrieve build log". `railway up --detach` promoted it correctly. Worth
knowing: **a Railway deploy is not confirmed by the CLI's exit message.** Confirm it by observing
the change on the live origin, which is what the polling loop in this investigation did.
