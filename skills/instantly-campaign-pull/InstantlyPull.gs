/**
 * Instantly.ai daily campaign pull -- Google Apps Script port of
 * skills/instantly-campaign-pull/pull.py (upcsion/instaanalystics).
 *
 * Writes one row per campaign to the "INSTA-PULL" tab of this spreadsheet
 * (created automatically if missing), in the same column order pull.py's
 * CSV uses.
 *
 * SETUP -- adding this to a project that already has other .gs code:
 *   Apps Script merges every file in a project into one shared global
 *   scope, so this file is written to be safe to drop in alongside
 *   existing code: every top-level name below is prefixed `Insta` /
 *   `Insta_`, and the entry point is `Insta_onOpen()` -- a plain helper,
 *   NOT the magic `onOpen()` trigger -- so it will never silently
 *   replace an onOpen() you already have.
 *   1. Open the spreadsheet -> Extensions -> Apps Script.
 *   2. Click the + next to "Files" -> Script, name it InstantlyPull,
 *      and paste this whole file into that new file (leave your
 *      existing file(s) untouched).
 *   3. Save. Then wire up the menu -- pick ONE:
 *        a) No existing onOpen(): add a new file with just
 *             function onOpen() { Insta_onOpen(); }
 *        b) You already have an onOpen(): add one line to it:
 *             Insta_onOpen();
 *      (If you'd rather skip the menu entirely and only use a button,
 *      skip this step -- go straight to step 6.)
 *   4. Reload the spreadsheet tab. An "Instantly" menu appears next to
 *      Help. Click Instantly -> Set API Key... and paste your Instantly
 *      API key. It's stored in this script's Script Properties, not in
 *      any cell, so it isn't visible to anyone who can only view/edit
 *      the sheet.
 *   5. Click Instantly -> Pull Instantly Data once to authorize the
 *      script (Google will ask you to approve it -- this is expected for
 *      any script that calls an external API).
 *   6. Optional/alternative button: Insert -> Drawing, draw/label a
 *      button, click Save and Close, then click the image once -> the
 *      3-dot menu in its corner -> Assign script -> type: Insta_pull
 *      (this works whether or not you did step 3 -- the button calls
 *      the pull function directly, no menu needed)
 *
 * This runs on Google's servers, not in any Claude Code sandbox, so it
 * needs its own copy of the API key (Script Properties above) -- it
 * cannot see the IK env var or environment-level API credential that
 * pull.py uses locally.
 *
 * Ported traps (see SKILL.md in the repo for the full write-up):
 *   1. Never use /api/v2/campaigns/analytics (lifetime totals) for
 *      "how many are left" -- only the paginated leads/list endpoint
 *      and the *date-respecting* .../analytics/daily endpoint are used.
 *   2. leads/list max page size is 100; larger silently returns zero rows.
 *   3. Step 2 becomes due after delays[0], not delays[1].
 *   4. Pagination stops only on a genuinely empty page, never on the
 *      first error -- retries happen instead.
 *   5. Verified live: the daily endpoint returns a bare JSON list with
 *      distinct `new_leads_contacted` (first-touch) and `sent` (all
 *      sends that day, incl. step 2+) fields.
 */

var INSTA_BASE = 'https://api.instantly.ai';
var INSTA_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
var INSTA_SHEET_NAME = 'INSTA-PULL';
var INSTA_API_KEY_PROP = 'INSTANTLY_API_KEY';

var INSTA_STATUS_NAMES = {
  1: 'ACTIVE', 2: 'PAUSED', 3: 'COMPLETED', 0: 'DRAFT',
  4: 'SUBSEQUENCES'
};
INSTA_STATUS_NAMES[-1] = 'ACCOUNTS UNHEALTHY';

var INSTA_HEADER = [
  'Campaign Name', 'Leads Loaded', 'Contacted', 'Not Yet Contacted',
  'Step 1 (Yesterday)', 'Step 1 (2 days ago)',
  'Status', 'Daily Cap', 'Send Window', 'Step Wait',
  'Step 2 Due TODAY', 'TOTAL SENDABLE TODAY', 'Max Users',
  'Step 2 Due TOMORROW', 'Sent Yesterday'
];

// ---------------------------------------------------------------------
// Menu / button entry points
// ---------------------------------------------------------------------

function Insta_onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Instantly')
    .addItem('Pull Instantly Data', 'Insta_pull')
    .addItem('Set API Key...', 'Insta_promptForApiKey_')
    .addToUi();
}

function Insta_promptForApiKey_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt(
    'Instantly API Key',
    'Paste your Instantly API key. It is saved in this script\'s Script ' +
      'Properties, not in the sheet.',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() === ui.Button.OK) {
    var key = resp.getResponseText().trim();
    if (key) {
      PropertiesService.getScriptProperties().setProperty(INSTA_API_KEY_PROP, key);
      ui.alert('Saved.');
    }
  }
}

/** Entry point for the menu item and for a drawing/button assigned to it. */
function Insta_pull() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(INSTA_SHEET_NAME) || ss.insertSheet(INSTA_SHEET_NAME);

  sheet.getRange(1, 1).setValue('Pulling from Instantly...').setFontStyle('italic').setFontColor(null);
  SpreadsheetApp.flush();

  try {
    var key = Insta_getApiKey_();
    var campaigns = Insta_fetchAllCampaigns_(key);
    if (!campaigns.length) {
      throw new Error('No campaigns returned -- check the API key and Instantly account.');
    }

    var rows = Insta_fetchCampaignRows_(key, campaigns);
    rows.sort(function (a, b) {
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    Insta_writeSheet_(sheet, rows);

    var warnings = Insta_sanityCheck_(rows);
    var stamp = 'Last pulled: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss z') +
      '  (' + rows.length + ' campaigns' + (warnings.length ? ', ' + warnings.length + ' warning(s) below' : '') + ')';
    sheet.getRange(1, 1).setValue(stamp).setFontStyle('italic');

    if (warnings.length) {
      SpreadsheetApp.getUi().alert('Pull finished with warnings:\n\n' + warnings.join('\n'));
    }
  } catch (e) {
    sheet.getRange(1, 1).setValue('Pull FAILED: ' + e.message).setFontStyle('italic').setFontColor('red');
    SpreadsheetApp.getUi().alert('Instantly pull failed:\n\n' + e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------

function Insta_getApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty(INSTA_API_KEY_PROP);
  if (!key) {
    throw new Error('No Instantly API key set. Use Instantly -> Set API Key... first.');
  }
  return key;
}

// ---------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------

function Insta_buildRequest_(key, call) {
  var opt = {
    url: INSTA_BASE + call.path,
    method: call.method,
    headers: { Authorization: 'Bearer ' + key, 'User-Agent': INSTA_UA },
    muteHttpExceptions: true
  };
  if (call.body !== undefined) {
    opt.contentType = 'application/json';
    opt.payload = JSON.stringify(call.body);
  }
  return opt;
}

/**
 * Runs a batch of {method, path, body} calls concurrently via
 * UrlFetchApp.fetchAll, retrying transient failures (429/5xx/network) up
 * to 5 times with backoff. Trap 4's rule ported here: only a clean
 * non-retryable HTTP error aborts -- a flaky response is retried, never
 * silently treated as "done".
 */
function Insta_batchFetch_(key, calls) {
  var CHUNK = 50;
  var MAX_TRIES = 5;
  var pending = calls.map(function (c, idx) {
    return { idx: idx, method: c.method, path: c.path, body: c.body };
  });
  var results = new Array(calls.length);

  for (var attempt = 0; attempt < MAX_TRIES && pending.length; attempt++) {
    if (attempt > 0) Utilities.sleep(3000 * attempt);
    var stillPending = [];

    for (var i = 0; i < pending.length; i += CHUNK) {
      var chunk = pending.slice(i, i + CHUNK);
      var requests = chunk.map(function (p) { return Insta_buildRequest_(key, p); });
      var responses;
      try {
        responses = UrlFetchApp.fetchAll(requests);
      } catch (e) {
        stillPending = stillPending.concat(chunk);
        continue;
      }
      for (var j = 0; j < responses.length; j++) {
        var p = chunk[j];
        var code = -1, text = '';
        try {
          code = responses[j].getResponseCode();
          text = responses[j].getContentText();
        } catch (e2) {
          text = String(e2);
        }
        if (code >= 200 && code < 300) {
          try {
            results[p.idx] = JSON.parse(text);
            continue;
          } catch (e3) {
            stillPending.push(p);
            continue;
          }
        }
        if (code === 429 || code >= 500 || code === -1) {
          stillPending.push(p);
        } else {
          throw new Error('HTTP ' + code + ' for ' + p.path + ': ' + text.slice(0, 300));
        }
      }
    }
    pending = stillPending;
  }

  if (pending.length) {
    throw new Error('Failed after retries: ' + pending.map(function (p) { return p.path; }).join(', '));
  }
  return results;
}

// ---------------------------------------------------------------------
// Instantly API
// ---------------------------------------------------------------------

function Insta_fetchAllCampaigns_(key) {
  var out = [], sa = null;
  while (true) {
    var path = '/api/v2/campaigns?limit=100' + (sa ? '&starting_after=' + sa : '');
    var d = Insta_batchFetch_(key, [{ method: 'get', path: path }])[0];
    (d.items || []).forEach(function (i) {
      out.push({ id: i.id, name: i.name, status: i.status });
    });
    sa = d.next_starting_after;
    if (!sa) return out;
  }
}

function Insta_dailyPath_(cid, dayUTC) {
  var ds = Utilities.formatDate(dayUTC, 'UTC', 'yyyy-MM-dd');
  return '/api/v2/campaigns/analytics/daily?campaign_id=' + cid +
    '&start_date=' + ds + '&end_date=' + ds;
}

/** {newContacted, sent} for one day -- see header comment, trap 5. */
function Insta_parseDailyAnalytics_(d) {
  var items = Array.isArray(d) ? d : (d.items || d.data || []);
  if (items && !Array.isArray(items)) items = [items];
  items = items || [];
  var newContacted = 0, sent = 0;
  items.forEach(function (row) {
    newContacted += row.new_leads_contacted || 0;
    sent += row.sent || 0;
  });
  return { newContacted: newContacted, sent: sent };
}

function Insta_addDaysUTC_(dateUTC, n) {
  var d = new Date(dateUTC.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

/**
 * For every campaign: campaign details (delays/cap/window), full
 * leads/list pagination (contacted / not-contacted / step-2-due), and
 * two days of daily analytics -- all batched across campaigns via
 * Insta_batchFetch_ so 185 campaigns finish in a handful of network round
 * trips instead of hundreds of sequential ones.
 */
function Insta_fetchCampaignRows_(key, campaigns) {
  var now = new Date();
  var todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  var yesterdayUTC = Insta_addDaysUTC_(todayUTC, -1);
  var twoDaysAgoUTC = Insta_addDaysUTC_(todayUTC, -2);

  // 1. Campaign details (parallel).
  var details = Insta_batchFetch_(key, campaigns.map(function (c) {
    return { method: 'get', path: '/api/v2/campaigns/' + c.id };
  }));
  var meta = {};
  campaigns.forEach(function (c, idx) {
    var d = details[idx];
    var delays = [];
    (d.sequences || []).forEach(function (s) {
      (s.steps || []).forEach(function (st) {
        delays.push(st.delay != null ? st.delay : 1);
      });
    });
    var wait = delays.length ? delays[0] : 1; // trap 3
    var sch = (d.campaign_schedule && d.campaign_schedule.schedules) || [{}];
    var t = (sch[0] && sch[0].timing) || {};
    meta[c.id] = {
      wait: wait,
      delaysLen: delays.length,
      cap: d.daily_limit || 0,
      window: t.from ? (t.from + '-' + t.to) : 'NONE'
    };
  });

  // 2. leads/list pagination, round-robin in parallel across campaigns
  //    still needing another page (trap 2: limit=100; trap 4: only an
  //    empty page ends pagination, never an error).
  var leadState = {};
  campaigns.forEach(function (c) {
    leadState[c.id] = { nc: 0, ct: 0, due: 0, tom: 0, sa: null };
  });
  var pending = campaigns.map(function (c) { return c.id; });
  while (pending.length) {
    var calls = pending.map(function (id) {
      var body = { campaign: id, limit: 100 };
      if (leadState[id].sa) body.starting_after = leadState[id].sa;
      return { method: 'post', path: '/api/v2/leads/list', body: body };
    });
    var results = Insta_batchFetch_(key, calls);
    var next = [];
    pending.forEach(function (id, idx) {
      var rr = results[idx];
      var items = rr.items || [];
      var st = leadState[id];
      var m = meta[id];
      items.forEach(function (x) {
        var ts = x.timestamp_last_contact;
        if (!ts) { st.nc++; return; }
        st.ct++;
        var contactUTC = new Date(Date.UTC(
          parseInt(ts.slice(0, 4), 10), parseInt(ts.slice(5, 7), 10) - 1, parseInt(ts.slice(8, 10), 10)
        ));
        var ds = Math.round((todayUTC.getTime() - contactUTC.getTime()) / 86400000);
        if (x.status === 1 && m.delaysLen > 1) {
          if (ds >= m.wait) st.due++;
          else if (ds + 1 >= m.wait) st.tom++;
        }
      });
      var sa = rr.next_starting_after;
      if (sa && items.length) {
        st.sa = sa;
        next.push(id);
      }
    });
    pending = next;
  }

  // 3. Daily analytics for yesterday + two days ago (parallel).
  var dailyCalls = [];
  campaigns.forEach(function (c) {
    dailyCalls.push({ method: 'get', path: Insta_dailyPath_(c.id, yesterdayUTC) });
    dailyCalls.push({ method: 'get', path: Insta_dailyPath_(c.id, twoDaysAgoUTC) });
  });
  var dailyResults = Insta_batchFetch_(key, dailyCalls);

  return campaigns.map(function (c, idx) {
    var y = Insta_parseDailyAnalytics_(dailyResults[idx * 2]);
    var t2 = Insta_parseDailyAnalytics_(dailyResults[idx * 2 + 1]);
    var st = leadState[c.id];
    var m = meta[c.id];
    var leads = st.nc + st.ct;
    var sendable = st.nc + st.due;
    return {
      name: (c.name || '').trim(),
      status: INSTA_STATUS_NAMES[c.status] !== undefined ? INSTA_STATUS_NAMES[c.status] : String(c.status),
      limit: m.cap,
      window: m.window,
      wait: m.wait,
      leads: leads,
      contacted: st.ct,
      notyet: st.nc,
      step1_yesterday: y.newContacted,
      step1_2d_ago: t2.newContacted,
      step2_due: st.due,
      sendable: sendable,
      maxusers: Math.floor(Math.min(sendable, m.cap || Number.MAX_SAFE_INTEGER) / 15),
      step2_tom: st.tom,
      sent_yesterday: y.sent
    };
  });
}

// ---------------------------------------------------------------------
// Sheet output
// ---------------------------------------------------------------------

function Insta_rowValues_(r) {
  return [
    r.name, r.leads, r.contacted, r.notyet,
    r.step1_yesterday, r.step1_2d_ago,
    r.status, r.limit, r.window, r.wait,
    r.step2_due, r.sendable, r.maxusers,
    r.step2_tom, r.sent_yesterday
  ];
}

function Insta_writeSheet_(sheet, rows) {
  sheet.clearContents();
  sheet.getRange(2, 1, 1, INSTA_HEADER.length).setValues([INSTA_HEADER]).setFontWeight('bold');
  if (!rows.length) return;
  var values = rows.map(Insta_rowValues_);
  sheet.getRange(3, 1, values.length, INSTA_HEADER.length).setValues(values);
  sheet.setFrozenRows(2);
  sheet.autoResizeColumns(1, INSTA_HEADER.length);
}

/** Same checks as pull.py's warnings. */
function Insta_sanityCheck_(rows) {
  var warnings = [];
  rows.forEach(function (r) {
    if (r.contacted + r.notyet !== r.leads) {
      warnings.push(r.name + ': contacted + not-contacted != leads loaded');
    }
    if (r.contacted > r.leads) {
      warnings.push(r.name + ': contacted > leads -- looks like the lifetime endpoint was used (trap 1)');
    }
  });
  return warnings;
}
