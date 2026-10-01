# Domain cutover: `agentgoods.ai` → Cloudflare → Railway

Written for the actual setup: the domain is registered at **Namecheap**, DNS will be hosted at
**Cloudflare**, and the application runs on **Railway**.

Do the steps in order. Step 3 cannot succeed before step 2 has finished propagating, and step 5
must not be switched on before step 4 has verified.

**Nothing here is reversible in seconds.** Changing nameservers moves authority for the whole
domain. Read a step fully before doing it.

---

## 0. Before you touch DNS

Railway must already be running the service and answering on its own `*.up.railway.app` URL. A
custom domain does not make a broken deployment work; it only makes it reachable under a nicer
name. Confirm `https://<something>.up.railway.app/api/v1/status` returns 200 first.

Decide the hostnames now, because each one is a separate record:

| Host | Points at | Purpose |
|---|---|---|
| `agentgoods.ai` | Railway (frontend) | the human site |
| `www.agentgoods.ai` | redirect to apex | so both spellings work |
| `api.agentgoods.ai` | Railway (backend) | the Agent API |

Using a separate `api.` host is worth it: it lets the API and the site scale, cache and fail
independently, and it keeps the API's CORS and CSP rules from being entangled with the site's.

---

## 1. Add the domain to Cloudflare

1. Sign in to Cloudflare → **Add a site** → type `agentgoods.ai` → **Continue**.
2. Choose the **Free** plan. Everything needed here is on the free plan.
3. Cloudflare scans the existing DNS. There will be little or nothing to import — that is normal
   for a freshly registered domain. **Delete any parked/placeholder records Namecheap created**,
   especially a parking `A` record or a `CNAME` to `parkingpage.namecheap.com`. Leaving one means
   part of your traffic keeps going to a parking page.
4. Cloudflare shows **two nameservers**, something like:

   ```text
   dana.ns.cloudflare.com
   rick.ns.cloudflare.com
   ```

   Yours will be different. Copy both exactly.

---

## 2. Point Namecheap at Cloudflare

1. Namecheap → **Domain List** → **Manage** next to `agentgoods.ai`.
2. Find the **Nameservers** section.
3. Change the dropdown from `Namecheap BasicDNS` to **`Custom DNS`**.
4. Paste the two Cloudflare nameservers, one per row. Remove any other rows.
5. Click the **green tick / Save**. This is easy to miss — Namecheap does not save on blur.

Then wait. Namecheap usually applies this within minutes, but registry propagation for `.ai` can
take longer than a `.com`. Cloudflare emails you when the zone goes **Active**; do not continue
until it does.

Check it yourself:

```bash
nslookup -type=NS agentgoods.ai
# must return the two *.ns.cloudflare.com names, not registrar-servers.com
```

---

## 3. Get the Railway targets

In Railway, for **each** service that needs a public hostname:

1. Open the service → **Settings** → **Networking** → **Custom Domain**.
2. Enter the hostname (`api.agentgoods.ai` for the backend, `agentgoods.ai` for the frontend).
3. Railway responds with what to create. Expect **two kinds of record**:
   - a **CNAME** for the host, pointing at something like `abc123.up.railway.app`;
   - possibly a **TXT** record for domain verification. Railway asks for this on apex domains and
     on some accounts. If it shows one, it is not optional — the domain stays "pending" until the
     TXT resolves.

Copy the exact name and value for each. Railway's UI shows a copy button; use it rather than
retyping, because a trailing dot or a missing subdomain costs an hour of confusion.

---

## 4. Create the records in Cloudflare — **grey cloud first**

Cloudflare → `agentgoods.ai` → **DNS** → **Records** → **Add record**, for each one Railway gave
you.

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `api` | `abc123.up.railway.app` | **DNS only (grey)** |
| CNAME | `@` | `def456.up.railway.app` | **DNS only (grey)** |
| CNAME | `www` | `agentgoods.ai` | **DNS only (grey)** |
| TXT | whatever Railway specified | whatever Railway specified | n/a |

Two things here matter more than they look:

**Start every record as DNS only (grey cloud).** With the orange cloud on, Cloudflare answers with
its own IPs, Railway cannot see your DNS pointing at it, and its certificate issuance fails. Get
Railway to say **Verified / Active** first, then proxy.

**The apex `@` CNAME is fine.** A CNAME at the zone apex is normally illegal in DNS; Cloudflare
supports it via CNAME flattening, which is one of the real reasons to put Cloudflare in front of
Railway at all.

Now go back to Railway and wait for each domain to flip to verified. It is usually under a minute
once DNS is right. If it stays pending for more than ~15 minutes, check the record resolves:

```bash
nslookup -type=CNAME api.agentgoods.ai
nslookup -type=TXT  agentgoods.ai
```

---

## 5. HTTPS

Railway issues a Let's Encrypt certificate automatically once the domain verifies. Confirm
`https://api.agentgoods.ai/api/v1/status` works **before** changing anything in Cloudflare.

Then, in Cloudflare → **SSL/TLS**:

1. **Overview → encryption mode → `Full (strict)`.**
   Not `Flexible`. Flexible means Cloudflare talks to Railway over plain HTTP, so the padlock in
   the browser is telling the visitor something that is not true for the second half of the
   journey. `Full (strict)` requires a valid certificate at Railway, which you now have.
2. **Edge Certificates → Always Use HTTPS → On.**
3. **Edge Certificates → Minimum TLS Version → 1.2.**
4. **HSTS → Enable**, 6 months, include subdomains, preload **off for now**.
   HSTS is hard to undo: a browser that has seen the header refuses plain HTTP for the whole max-age
   even if you change your mind. Turn it on only once the site is genuinely final, and leave
   preload off until it has been stable for weeks.

Only now, switch the CNAMEs to **Proxied (orange cloud)** if you want Cloudflare's caching and DDoS
protection. Re-test both hostnames immediately afterwards.

---

## 6. Point the application at the new names

These are application settings, not DNS. Update them in Railway's service variables:

```bash
PUBLIC_BASE_URL=https://api.agentgoods.ai
PUBLIC_WEB_URL=https://agentgoods.ai
CORS_ORIGINS=https://agentgoods.ai,https://www.agentgoods.ai
```

`PUBLIC_BASE_URL` matters more than it looks: it is what the Agent schema, the OpenAPI document,
the `/.well-known/aic-agent.json` discovery file and every signed delivery URL advertise. If it
still says `*.up.railway.app`, Agents will keep using the old hostname and every delivery link will
point at it.

Redeploy, then verify the schema now advertises the real domain:

```bash
curl -s https://agentgoods.ai/.well-known/aic-agent.json | grep -i agentgoods
curl -s https://api.agentgoods.ai/api/v1/schema | head -c 400
```

---

## 7. Verify before calling it done

```bash
# both spellings reach the site over https
curl -sI https://agentgoods.ai        | head -1
curl -sI https://www.agentgoods.ai    | head -1

# plain http redirects rather than serving
curl -sI http://agentgoods.ai         | head -1   # expect 301

# the API answers and reports a live indexer
curl -s https://api.agentgoods.ai/api/v1/status

# the discovery document is reachable at the well-known path
curl -sI https://agentgoods.ai/.well-known/aic-agent.json | head -1
```

Then check in a browser that the padlock has no warnings, and that the certificate is issued for
`agentgoods.ai` rather than a Railway hostname.

---

## What does NOT change

Moving to a custom domain changes a hostname and nothing else. It must not change:

- any contract address, the chain, or the deployment manifest;
- any Agent's wallet, API key or identity;
- any `contentHash`, licence or on-chain record.

An Agent that cached the old base URL keeps working until it re-reads the schema. That is why the
schema is the single place the base URL is published, and why it is updated in step 6 rather than
being hard-coded anywhere.

---

## Common failures, and what they actually mean

| Symptom | Cause |
|---|---|
| Railway domain stuck "pending" | The CNAME is proxied (orange). Set it to DNS only until verified. |
| Railway asks for a TXT that never verifies | The record name was typed with the domain appended twice, e.g. `_railway.agentgoods.ai.agentgoods.ai`. Cloudflare appends the zone for you. |
| Browser shows "too many redirects" | Cloudflare SSL mode is `Flexible` while Railway also redirects to HTTPS. Set `Full (strict)`. |
| Site loads, API calls fail from the browser | `CORS_ORIGINS` still lists the old hostname. |
| Certificate is valid but for `*.up.railway.app` | You proxied before Railway issued its own certificate. Grey-cloud it, wait, re-proxy. |
| `nslookup` still shows Namecheap nameservers | Step 2's save was not clicked, or the registry has not propagated yet. |
