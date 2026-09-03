#!/usr/bin/env python3
"""Instantly.ai daily campaign pull.

Per-campaign contacted / not-contacted lead counts and sendable capacity,
for the daily send tracker. See SKILL.md in this folder for the full
write-up of the four traps this script avoids.

Usage:
    export IK=<instantly api key>
    python3 pull.py                  # writes CSV to stdout
    python3 pull.py --csv out.csv    # writes CSV to a file

Requires outbound network access to https://api.instantly.ai. Some
sandboxed environments block this host by egress policy -- if every
request fails with a connection/tunnel error rather than an HTTP error
from Instantly itself, that's a network policy problem, not a script bug.

NOTE: the "Step 1 (Yesterday)" / "Step 1 (2 days ago)" / "Sent Yesterday"
columns are all populated from the same `new_leads_contacted` field on the
daily analytics endpoint (see SKILL.md's closing note). This was written
without a live API response to verify the exact response shape, since
network access wasn't available at write time -- `daily_new_contacted()`
below parses defensively (list or dict-wrapped) but double check the real
shape the first time this runs and adjust if needed.
"""
import argparse
import csv
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://api.instantly.ai"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

SN = {1: "ACTIVE", 2: "PAUSED", 3: "COMPLETED", 0: "DRAFT",
      -1: "ACCOUNTS UNHEALTHY", 4: "SUBSEQUENCES"}

TODAY = datetime.date.today()
YESTERDAY = TODAY - datetime.timedelta(days=1)
TWO_DAYS_AGO = TODAY - datetime.timedelta(days=2)

KEY = os.environ.get("IK")


def req(method, path, body=None, tries=5):
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(tries):
        r = urllib.request.Request(BASE + path, data=data, method=method)
        if KEY:  # otherwise rely on an environment-level API credential to attach it
            r.add_header("Authorization", "Bearer " + KEY)
        r.add_header("User-Agent", UA)
        if data is not None:
            r.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(r, timeout=90) as f:
                return json.loads(f.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(3 * (attempt + 1))
                continue
            raise
        except Exception:
            time.sleep(3 * (attempt + 1))
            continue
    raise RuntimeError("failed " + path)


def campaigns():
    out, sa = [], None
    while True:
        p = "/api/v2/campaigns?limit=100" + (f"&starting_after={sa}" if sa else "")
        d = req("GET", p)
        out += [{"id": i["id"], "name": i["name"], "status": i.get("status")}
                for i in d.get("items", [])]
        sa = d.get("next_starting_after")
        if not sa:
            return out


def daily_new_contacted(cid, day):
    """New leads contacted on `day`, from the date-respecting daily endpoint.

    Defensive about response shape since this wasn't verified live -- see
    module docstring.
    """
    ds = day.isoformat()
    d = req("GET", f"/api/v2/campaigns/analytics/daily?campaign_id={cid}"
                    f"&start_date={ds}&end_date={ds}")
    items = d if isinstance(d, list) else d.get("items", d.get("data", []))
    if isinstance(items, dict):
        items = [items]
    return sum((row.get("new_leads_contacted", 0) or 0) for row in (items or []))


def work(i):
    cid = i["id"]
    d = req("GET", "/api/v2/campaigns/" + cid)
    delays = [st.get("delay", 1) for s in d.get("sequences", [])
              for st in s.get("steps", [])]
    wait = delays[0] if delays else 1  # trap 3: step 2 waits on delays[0], not delays[1]
    sch = d.get("campaign_schedule", {}).get("schedules") or [{}]
    t = (sch[0].get("timing") or {}) if sch else {}

    nc = ct = due = tom = 0
    sa = None
    while True:
        b = {"campaign": cid, "limit": 100}  # trap 2: max limit is 100
        if sa:
            b["starting_after"] = sa
        rr = req("POST", "/api/v2/leads/list", b)
        it = rr.get("items", [])
        for x in it:
            ts = x.get("timestamp_last_contact")
            if not ts:
                nc += 1
                continue
            ct += 1
            ds = (TODAY - datetime.date(int(ts[:4]), int(ts[5:7]), int(ts[8:10]))).days
            if x.get("status") == 1 and len(delays) > 1:
                if ds >= wait:
                    due += 1
                elif ds + 1 >= wait:
                    tom += 1
        sa = rr.get("next_starting_after")
        if not sa or not it:  # trap 4: stop only on a genuinely empty page
            break

    cap = d.get("daily_limit") or 0
    step1_yesterday = daily_new_contacted(cid, YESTERDAY)
    step1_2d_ago = daily_new_contacted(cid, TWO_DAYS_AGO)

    return dict(
        name=i["name"].strip(),
        status=SN.get(i["status"], str(i["status"])),
        limit=cap,
        window=(f"{t.get('from')}-{t.get('to')}" if t.get("from") else "NONE"),
        wait=wait,
        leads=nc + ct,
        contacted=ct,
        notyet=nc,
        step1_yesterday=step1_yesterday,
        step1_2d_ago=step1_2d_ago,
        step2_due=due,
        step2_tom=tom,
        sendable=nc + due,
        maxusers=min(nc + due, cap or 10**9) // 15,
        sent_yesterday=step1_yesterday,
    )


HEADER = [
    "Campaign Name", "Leads Loaded", "Contacted", "Not Yet Contacted",
    "Step 1 (Yesterday)", "Step 1 (2 days ago)",
    "Status", "Daily Cap", "Send Window", "Step Wait",
    "Step 2 Due TODAY", "TOTAL SENDABLE TODAY", "Max Users",
    "Step 2 Due TOMORROW", "Sent Yesterday",
]


def row_values(r):
    return [
        r["name"], r["leads"], r["contacted"], r["notyet"],
        r["step1_yesterday"], r["step1_2d_ago"],
        r["status"], r["limit"], r["window"], r["wait"],
        r["step2_due"], r["sendable"], r["maxusers"],
        r["step2_tom"], r["sent_yesterday"],
    ]


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                  formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default=None,
                     help="write output to this CSV path instead of stdout")
    ap.add_argument("--workers", type=int, default=12)
    args = ap.parse_args()

    if not KEY:
        print("IK is not set -- assuming the Instantly API key is attached via an "
              "environment-level API credential instead.", file=sys.stderr)

    try:
        items = campaigns()
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            sys.exit("Instantly rejected the request (HTTP %d) -- set IK to your API key, "
                      "or add it as an API credential for api.instantly.ai on this "
                      "environment." % e.code)
        raise
    if not items:
        sys.exit("No campaigns returned -- check the API key and network access to api.instantly.ai.")

    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        rows = list(ex.map(work, items))

    rows.sort(key=lambda r: r["name"].lower())  # every campaign included, zero-lead ones too

    fh = open(args.csv, "w", newline="") if args.csv else sys.stdout
    out = csv.writer(fh)
    out.writerow(HEADER)
    warnings = []
    for r in rows:
        if r["contacted"] + r["notyet"] != r["leads"]:
            warnings.append(f"{r['name']}: contacted + not-contacted != leads loaded")
        if r["contacted"] > r["leads"]:
            warnings.append(f"{r['name']}: contacted > leads -- looks like the lifetime endpoint was used (trap 1)")
        out.writerow(row_values(r))
    if args.csv:
        fh.close()
        print(f"Wrote {len(rows)} campaigns to {args.csv}", file=sys.stderr)

    for w in warnings:
        print("WARNING: " + w, file=sys.stderr)


if __name__ == "__main__":
    main()
