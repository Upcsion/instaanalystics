---
name: instantly-campaign-pull
description: Pull per-campaign contacted / not-contacted lead counts and sendable capacity from Instantly.ai for the daily send tracker. Use for "pull the campaigns", "contacted not contacted", "how many leads left", "what can we send today", or building the daily Instantly sheet.
---

# Instantly daily campaign pull

Produces, for every campaign: leads loaded, contacted, not yet contacted, step 2 due today, total sendable today, and max users.

Run it with `python3 pull.py` (see `pull.py` in this folder) after exporting the API key:

```
export IK=<instantly api key>
python3 pull.py --csv output.csv
```

## Before anything else: the four traps

These are the mistakes that produce confident wrong numbers. All four were hit in production.

1. `/api/v2/campaigns/analytics` returns LIFETIME totals, not current status.
   Its `contacted_count` counts every lead ever contacted, so a campaign can show 68,832 contacted against 5,646 leads. It also ignores any `start_date` / `end_date` you pass. It omits DRAFT campaigns entirely. Never use it for "how many are left". Use it only for lifetime bounce and reply totals.

2. Count contacted / not-contacted from `POST /api/v2/leads/list`.
   This respects the campaign filter. Max limit is 100 — passing 500 or 1000 returns zero rows, silently.

3. Step 2 becomes due after `delays[0]`, not `delays[1]`.
   The wait that matters is the delay on step 1. Verified empirically: leads contacted 1 day ago did not send; 2 days ago did.

4. Never use `except: break` inside a pagination loop.
   A transient API error will truncate the count and it will look like a real number. Retry, then stop only on a genuinely empty page.

## Environment

Two non-obvious requirements:

- User-Agent header is mandatory. Cloudflare blocks the default Python-urllib with HTTP 403 error 1010. Send a browser UA.
- A bodyless DELETE must not set `Content-Type: application/json`, or it fails with `FST_ERR_CTP_EMPTY_JSON_BODY`.

The API key lives in the `IK` environment variable. Base URL `https://api.instantly.ai`.

Running in a Claude Code cloud environment (claude.ai/code) instead of a terminal with `IK` exported: add the key as an environment-level **API credential** for host `api.instantly.ai` (Bearer type, `Authorization` header) instead. That both grants network access to the host and attaches the key to matching requests outside the sandbox, so the key never appears in the session, its environment variables, or any file. `pull.py` only sets the `Authorization` header itself when `IK` is present, so it works either way.

## The formulas

- Sendable today = not yet contacted + step 2 due today
- Max users = min(sendable, daily cap) / 15, rounded down — 15 is the per-mailbox daily limit
- The campaign `daily_limit` is a separate ceiling from the per-mailbox 15

## Real first-touch counts

For "how many new people did we actually email", use the daily endpoint and its `new_leads_contacted` field. This is the column that never reconciled in the manual tracker.

```
GET /api/v2/campaigns/analytics/daily?campaign_id={cid}&start_date={d}&end_date={d}
```

Unlike the non-daily analytics endpoint, this one does respect the dates. It has no usable bounce field — "bounced" reads 0 even on days with known bounces.

## Output

Sort alphabetically by campaign name and write these columns, in this order, so columns A-F paste straight into the Campaign Send Tracker:

`Campaign Name | Leads Loaded | Contacted | Not Yet Contacted | Step 1 (Yesterday) | Step 1 (2 days ago)`

Then as reference: `Status | Daily Cap | Send Window | Step Wait | Step 2 Due TODAY | TOTAL SENDABLE TODAY | Max Users | Step 2 Due TOMORROW | Sent Yesterday`

Include every campaign, including zero-lead ones, so row positions stay stable between days.

## Sanity checks before sending the numbers on

- Contacted + not contacted must equal leads loaded, per campaign
- A campaign showing far more contacted than its lead count means the lifetime endpoint was used — trap 1
- Any campaign with leads but zero sends today: check status. ACCOUNTS UNHEALTHY, PAUSED and DRAFT cannot send regardless of leads
- Zero not-contacted does not mean a campaign is finished — it may still have step 2 due, and pulling its users off will lose those sends

## Note on "Step 1 (Yesterday/2 days ago)" vs "Sent Yesterday"

The source spec lists both a "Step 1 (Yesterday)" column and a separate "Sent Yesterday" reference column, but only documents one field (`new_leads_contacted` from the daily analytics endpoint) for computing them. `pull.py` currently populates all three "yesterday" figures from that single field. If the live API turns out to expose a distinct total-sends field on the daily endpoint, split `sent_yesterday` out from `step1_yesterday` in `pull.py` accordingly — this was not verified against a live response before being committed (see `pull.py` header comment).
