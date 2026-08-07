// =====================================================================
// TC Roofing — Inbound SMS Logger  (Cloudflare Worker: acculynx-sms-logger)
//
// WHAT THIS DOES
// When someone replies to one of TC's automated group texts, this Worker
// finds the job and posts the reply onto that job's AccuLynx file as
// "[Inbound SMS Reply] From: ... | <timestamp>", replying into the
// existing message thread when one is known so the whole customer
// conversation stays in a single AccuLynx thread.
//
// ONE WORKER PER BRAND — DO NOT CROSS THE CONFIG
// Peachtree has its own deployment (peachtree-sms-logger) with its own
// sheet, AccuLynx key, texting number, and TIMEZONE. The two were
// accidentally swapped once, which produced two silent failures at the
// same time: Peachtree replies were stamped in Central, and each worker
// searched the other brand's sheet and quietly found nothing. If you are
// copying this file to the other brand, change the whole BRAND CONFIG
// block, not just one line.
//
//   TC        -> America/Chicago,  "CT", RC_FROM +12147168582, dedup +12145098272
//   Peachtree -> America/New_York, "ET", RC_FROM +14043295117, dedup +14045768975
//
// SETUP
// 1. Paste this file into the Worker and fill in every YOUR_... value.
// 2. Register the inbound-SMS webhook from the app's Config tab so a
//    RingCentral subscription delivers here.
// =====================================================================

// ---- BRAND CONFIG (TC) ----
const BRAND            = "TC";
const LOG_TIMEZONE     = "America/Chicago"; // TC operates on Central
const TZ_LABEL         = "CT";
const RC_FROM          = "+12147168582";    // TC's automated texting number
const GS_SHEET_ID      = "YOUR_TC_GS_SHEET_ID";
const GS_SHEET_NAME    = "Log 2026";
const ACCULYNX_API_KEY = "YOUR_TC_ACCULYNX_API_KEY";
const GS_CLIENT_ID     = "YOUR_GS_CLIENT_ID";
const GS_CLIENT_SECRET = "YOUR_GS_CLIENT_SECRET";
const GS_REFRESH_TOKEN = "YOUR_GS_REFRESH_TOKEN";
// The app injects this into a job's Secondary Phone when two jobs share a primary
// phone, purely to force RingCentral into separate group threads. Never a real
// participant, so it must not resolve to a job. Brand-specific — TC's app uses
// +12145098272 (see DEDUP_PHONE in index.template.html), Peachtree's +14045768975.
const DEDUP_PHONE_LAST10 = "2145098272";

function last10(v) { return String(v || "").replace(/\D/g, "").slice(-10); }

// ---- DENIED SUBSCRIPTIONS ----
// Notifications from these subscription IDs are dropped outright. Use it when a
// duplicate subscription cannot be removed: RingCentral scopes both GET and DELETE
// /subscription to the user AND app that created it, so one registered with other
// credentials is invisible to List All and DELETE returns 404 CMN-102. Deleting
// the owning app does not necessarily stop it delivering either — Peachtree hit
// exactly this and needed an entry here.
//
// Deliberately a denylist rather than an allowlist. Re-registering the webhook
// mints a new subscription ID, and an allowlist would silently stop all inbound
// logging until someone remembered to update this constant. Every payload's
// subscriptionId is logged, so a new offender is easy to identify and add.
const IGNORED_SUBSCRIPTION_IDS = [
  // Hidden duplicate on TC's account (63377564031). Delivered a second copy of
  // every inbound ~1ms after the app's own subscription
  // 4c5f6ae9-8ef4-45a2-8fe6-4a24c846a991, so each reply was posted to AccuLynx
  // twice. Not visible to List All and not deletable from the app, same as the
  // Peachtree case. Stored as a prefix because Cloudflare's log view truncates
  // the id and that is the only place it appears.
  "fa50c707-121e-4cbd-bcd6-"
];

// Entries may be a full UUID or just the leading portion of one — the offending
// id is usually only visible in a truncated log line. A minimum length keeps a
// short or accidental entry from matching real subscriptions.
function isDeniedSubscription(id) {
  if (!id) return false;
  return IGNORED_SUBSCRIPTION_IDS.some(function (entry) {
    return entry && entry.length >= 8 && String(id).indexOf(entry) === 0;
  });
}

// ---- DUPLICATE DELIVERY GUARD ----
// If a second subscription exists on this extension, it delivers every message a
// second time about 1ms later. When it was created with different RingCentral
// credentials, this app cannot list it (GET /subscription is scoped to the
// authenticating user AND app) and cannot delete it either — DELETE returns
// 404 CMN-102. Without a guard, each delivery posts its own AccuLynx note.
// Peachtree hit exactly this.
//
// Cloudflare routinely handles near-simultaneous requests in the same isolate, so
// a module-scope map catches them with no KV binding and no setup. It is
// per-isolate, so treat this as a strong mitigation rather than a guarantee; if
// duplicates ever reappear, the two deliveries landed in separate isolates and
// this needs promoting to KV.
const seenMessages = new Map(); // messageId -> epoch ms
const SEEN_TTL_MS = 10 * 60 * 1000;

function claimMessage(msgId) {
  if (!msgId) return true; // nothing to key on — let it through
  const now = Date.now();
  for (const [k, t] of seenMessages) { if (now - t > SEEN_TTL_MS) seenMessages.delete(k); }
  if (seenMessages.has(msgId)) return false;
  seenMessages.set(msgId, now);
  return true;
}

// Release the claim when posting failed, so a genuine retry is not swallowed by
// the guard for the next ten minutes.
function releaseMessage(msgId) { if (msgId) seenMessages.delete(msgId); }

// Timestamps carry an explicit zone label so a wrong-timezone deployment is
// visible on the job file instead of silently reading an hour off.
function brandTimestamp(creationTime) {
  return new Date(creationTime || Date.now())
    .toLocaleString("en-US", { timeZone: LOG_TIMEZONE }) + " " + TZ_LABEL;
}

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, Validation-Token"
    }});
  }

  const validationToken = request.headers.get("Validation-Token");
  if (validationToken && request.method === "GET") {
    return new Response(null, { status: 200, headers: {
      "Validation-Token": validationToken, "Content-Type": "application/json" }});
  }

  if (request.method === "POST") {
    const contentLength = parseInt(request.headers.get("content-length") || "0");
    if (validationToken && contentLength < 10) {
      return new Response(null, { status: 200, headers: {
        "Validation-Token": validationToken, "Content-Type": "application/json" }});
    }

    try {
      const bodyText = await request.text();
      console.log("Received body:", bodyText);
      const body = JSON.parse(bodyText);

      // Drop denied subscriptions before doing any work. subscriptionId lives on
      // the envelope, so this is one check per notification, not per message.
      if (body && isDeniedSubscription(body.subscriptionId)) {
        console.log("Ignoring notification from denied subscription", body.subscriptionId,
                    "— known duplicate delivery, see IGNORED_SUBSCRIPTION_IDS");
        const h = { "Content-Type": "application/json" };
        if (validationToken) h["Validation-Token"] = validationToken;
        return new Response(JSON.stringify({ status: "ignored" }), { status: 200, headers: h });
      }

      const msgBody = body?.body;
      const msgs = msgBody?.messages || (msgBody?.direction ? [msgBody] : []);
      console.log("Messages found:", msgs.length);

      for (const msg of msgs) {
        if (msg.direction !== "Inbound") { console.log("Skipping - not inbound."); continue; }

        // Only handle texts sent TO this brand's number. Both brands' numbers can
        // live on one RingCentral account, and a stale subscription can deliver
        // another brand's traffic here. Without this, a foreign message just
        // fails its sheet lookup, which is indistinguishable from a real bug.
        const toNumbers = (msg.to || []).map(t => t && t.phoneNumber).filter(Boolean);
        if (!toNumbers.includes(RC_FROM)) {
          console.log("[" + BRAND + "] Ignoring inbound to " + JSON.stringify(toNumbers) + " — not " + RC_FROM);
          continue;
        }

        const fromPhone = msg.from?.phoneNumber || "";
        const text = msg.subject || msg.body || msg.text || "(no text)";
        const conversationId = msg.conversation?.id || "";
        const timestamp = brandTimestamp(msg.creationTime);
        // subscriptionId is logged because a second, hidden subscription on the
        // same account will silently deliver every message twice, and the worker
        // posts once per delivery. RingCentral scopes GET /subscription to the
        // authenticating user, so the app's Config panel cannot see subscriptions
        // created under other credentials — this field is the only reliable way
        // to tell duplicate delivery apart from a bug in this code.
        console.log("From:", fromPhone, "ConversationId:", conversationId,
                    "msgId:", msg.id, "subscriptionId:", body.subscriptionId, "Text:", text);
        if (!fromPhone) continue;

        // Claim before the sheet lookup, so the duplicate is dropped as early as
        // possible rather than racing us through the slower AccuLynx call.
        if (!claimMessage(msg.id)) {
          console.log("Duplicate delivery of msgId", msg.id, "via subscription",
                      body.subscriptionId, "— already handled, skipping");
          continue;
        }

        const jobInfo = await findJob(fromPhone, conversationId);
        const note = "[Inbound SMS Reply] From: " + fromPhone + " | " + timestamp + "\n\n" + text;

        if (jobInfo && jobInfo.jobGuid) {
          try {
            if (jobInfo.messageId) {
              try {
                await replyToAccuLynx(jobInfo.jobGuid, jobInfo.messageId, note);
                console.log("Successfully replied to AccuLynx thread for Job", jobInfo.jobNum);
              } catch (replyErr) {
                console.log("Reply failed, posting as new message:", replyErr.message);
                await postToAccuLynx(jobInfo.jobGuid, note);
              }
            } else {
              await postToAccuLynx(jobInfo.jobGuid, note);
            }
          } catch (e) {
            console.error("AccuLynx post error:", e.message);
            releaseMessage(msg.id);
          }
        } else if (jobInfo && !jobInfo.jobGuid) {
          console.log("Found job", jobInfo.jobNum, "but no GUID");
          releaseMessage(msg.id); // nothing posted — do not block a later attempt
        } else {
          console.log("No job found for phone:", fromPhone, "conversationId:", conversationId);
          releaseMessage(msg.id); // nothing posted — do not block a later attempt
        }
      }

      const respHeaders = { "Content-Type": "application/json" };
      if (validationToken) respHeaders["Validation-Token"] = validationToken;
      return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: respHeaders });

    } catch (e) {
      console.error("Error:", e.message);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 200, headers: { "Content-Type": "application/json" }});
    }
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200, headers: { "Content-Type": "application/json" }});
}

async function getGSToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "client_id=" + encodeURIComponent(GS_CLIENT_ID) +
          "&client_secret=" + encodeURIComponent(GS_CLIENT_SECRET) +
          "&refresh_token=" + encodeURIComponent(GS_REFRESH_TOKEN) +
          "&grant_type=refresh_token"
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Google token failed: " + JSON.stringify(data));
  return data.access_token;
}

// Conversation ID first: it identifies the thread, so it resolves ANY participant
// (secondary numbers, salespeople) with no extra bookkeeping. Phone is only a
// fallback for replies RingCentral did not associate with a conversation.
//   column D (3)  primary phone
//   column M (12) secondary phone
//   column O (14) secondary texting number
async function findJob(phone, conversationId) {
  const clean = last10(phone);
  try {
    const token = await getGSToken();
    const sheetName = encodeURIComponent(GS_SHEET_NAME);
    const res = await fetch("https://sheets.googleapis.com/v4/spreadsheets/" + GS_SHEET_ID +
      "/values/" + sheetName + "!A:O", { headers: { Authorization: "Bearer " + token } });
    const data = await res.json();
    if (!data.values) {
      console.error("Sheet read returned no values — check GS_SHEET_ID and GS_SHEET_NAME:",
        JSON.stringify(data).slice(0, 300));
      return null;
    }
    const rows = data.values.slice(1);
    const hit = row => ({ jobNum: row[1] || "", jobGuid: row[9] || "", messageId: row[10] || "" });

    if (conversationId) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if ((rows[i][13] || "").trim() === conversationId) {
          console.log("Matched by ConversationID - Job#:", rows[i][1]);
          return hit(rows[i]);
        }
      }
      console.log("No conversation ID match - falling back to phone");
    }

    if (!clean) return null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const candidates = [last10(row[3]), last10(row[12]), last10(row[14])]
        .filter(Boolean)
        .filter(p => p !== DEDUP_PHONE_LAST10);
      if (candidates.includes(clean)) {
        const which = clean === last10(row[3]) ? "primary"
                    : clean === last10(row[12]) ? "secondary phone"
                    : "secondary texting number";
        console.log("Matched by phone (" + which + ") - Job#:", row[1]);
        return hit(row);
      }
    }
    return null;
  } catch (e) {
    console.error("Sheets lookup error:", e.message);
    return null;
  }
}

async function replyToAccuLynx(jobId, messageId, message) {
  const res = await fetch("https://api.acculynx.com/api/v2/jobs/" + jobId +
    "/messages/" + messageId + "/replies", {
    method: "POST",
    headers: { Authorization: "Bearer " + ACCULYNX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  const txt = await res.text();
  if (!res.ok) throw new Error("AccuLynx reply failed: " + res.status + " " + txt);
  return txt;
}

async function postToAccuLynx(jobId, message) {
  const res = await fetch("https://api.acculynx.com/api/v2/jobs/" + jobId + "/messages", {
    method: "POST",
    headers: { Authorization: "Bearer " + ACCULYNX_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ message })
  });
  const txt = await res.text();
  if (!res.ok) throw new Error("AccuLynx post failed: " + res.status + " " + txt);
  return txt;
}
