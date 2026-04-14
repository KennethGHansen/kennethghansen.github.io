// ============================================================
// Cloudflare Pages Functions — Weather backend
// Ported from Python BaseHTTPRequestHandler version
// ============================================================
//
// Runtime: Cloudflare Workers (via Pages Functions)
// Storage: Workers KV
//

// ============================================================
// Configuration
// ============================================================

// History file (JSON Lines format, append-only)
// NOTE: Older lines in this file may NOT contain "boot_id".
//
// NEW: In Pages Functions we use KV instead of a file.
// Each entry is stored as one KV row with a timestamp key.
const HISTORY_KEY_PREFIX = "history:";

// In-memory cache of latest reading
//
// NEW: Workers are stateless between invocations,
// so "latest" must be reconstructed or cached separately.
// We store "latest" explicitly in KV.
const LATEST_KEY = "latest";


// ------------------------------------------------------------
// Helper: send JSON responses
// ------------------------------------------------------------
function sendJSON(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",

      // ✅ CORS headers (ADD THESE)
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}


// ------------------------------------------------------------
// Browser CORS preflight
// ------------------------------------------------------------
function handleOPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}


// ============================================================
// Main request handler (replaces do_GET / do_POST)
// ============================================================
export async function onRequest(context) {
  const { request, env, params } = context;

  const url = new URL(request.url);
  const method = request.method;

  // Path after `/api/`
  const path = params.path ? "/" + params.path : "/";

  // ----------------------------------------------------------
  // OPTIONS (CORS preflight)
  // ----------------------------------------------------------
  if (method === "OPTIONS") {
    return handleOPTIONS();
  }

  // ----------------------------------------------------------
  // POST /weather
  // ----------------------------------------------------------
  if (method === "POST" && path === "/weather") {

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return sendJSON({ error: "invalid json", detail: String(e) }, 400);
    }

    // Prefer device timestamp, fall back to server time
    let ts = payload.ts;
    if (!ts || ts < 1_000_000_000) {
      ts = Date.now() / 1000;
    }

    const entry = {
      ts,
      device_id: payload.device_id,
      boot_id: payload.boot_id,
      weather: payload,
    };

    // Update latest cache
    await env.HISTORY.put(LATEST_KEY, JSON.stringify(entry));

    // Append to history (schema-tolerant)
    //
    // NEW: KV does not support append‑only files,
    // so we store one key per reading, ordered by timestamp.
    await env.HISTORY.put(
      HISTORY_KEY_PREFIX + ts.toFixed(3),
      JSON.stringify(entry)
    );

    return sendJSON({ ok: true });
  }

  // ----------------------------------------------------------
  // GET handlers
  // ----------------------------------------------------------
  if (method !== "GET") {
    return sendJSON({ error: "method not allowed" }, 405);
  }

  // ----------------------------------------------------------
  // GET /weather
  // ----------------------------------------------------------
  if (path === "/weather") {
    const raw = await env.HISTORY.get(LATEST_KEY);
    if (!raw) {
      return sendJSON({ error: "no data yet" }, 404);
    }
    return sendJSON(JSON.parse(raw));
  }

  // ----------------------------------------------------------
  // GET /history
  // ----------------------------------------------------------
  if (path === "/history") {
    const list = await env.HISTORY.list({ prefix: HISTORY_KEY_PREFIX });
    const entries = [];

    for (const key of list.keys) {
      const raw = await env.HISTORY.get(key.name);
      if (raw) entries.push(JSON.parse(raw));
    }

    entries.sort((a, b) => a.ts - b.ts);
    return sendJSON(entries);
  }

  // ----------------------------------------------------------
  // GET /boots
  // ----------------------------------------------------------
  if (path === "/boots") {
    const list = await env.HISTORY.list({ prefix: HISTORY_KEY_PREFIX });
    if (!list.keys.length) {
      return sendJSON({ boots: [] });
    }

    const entries = [];
    for (const k of list.keys) {
      const raw = await env.HISTORY.get(k.name);
      if (raw) entries.push(JSON.parse(raw));
    }

    const EXPECTED_INTERVAL = 10;
    const boots = {};

    for (const e of entries) {
      const boot = e.boot_id;
      const ts = e.ts;
      if (!boot || !ts) continue;

      if (!boots[boot]) {
        boots[boot] = {
          boot_id: boot,
          start_ts: ts,
          end_ts: ts,
          sample_count: 1,
        };
      } else {
        boots[boot].end_ts = ts;
        boots[boot].sample_count += 1;
      }
    }

    const boot_list = Object.values(boots).map(b => {
      const duration = b.end_ts - b.start_ts;
      const expected = duration > 0 ? duration / EXPECTED_INTERVAL : 0;
      const uptime_ratio = expected > 0 ? b.sample_count / expected : 0;

      return {
        boot_id: b.boot_id,
        start_ts: b.start_ts,
        end_ts: b.end_ts,
        duration_seconds: +duration.toFixed(1),
        sample_count: b.sample_count,
        uptime_ratio: +uptime_ratio.toFixed(4),
      };
    });

    boot_list.sort((a, b) => b.start_ts - a.start_ts);
    return sendJSON({ boots: boot_list });
  }

  // ----------------------------------------------------------
  // GET /status
  // ----------------------------------------------------------
  if (path === "/status") {
    const list = await env.HISTORY.list({ prefix: HISTORY_KEY_PREFIX });
    const entries = [];

    for (const k of list.keys) {
      const raw = await env.HISTORY.get(k.name);
      if (raw) entries.push(JSON.parse(raw));
    }

    if (entries.length < 2) {
      return sendJSON({ error: "not enough data for current boot" }, 400);
    }

    const current_boot = entries[entries.length - 1].boot_id;
    if (!current_boot) {
      return sendJSON({ error: "current boot unknown" }, 400);
    }

    const boot_entries = entries.filter(
      e => e.boot_id === current_boot && e.ts
    );

    if (boot_entries.length < 2) {
      return sendJSON({ error: "not enough data for current boot" }, 400);
    }

    const EXPECTED_INTERVAL = 10;
    const start_ts = boot_entries[0].ts;
    const end_ts = boot_entries[boot_entries.length - 1].ts;
    const duration = end_ts - start_ts;
    const sample_count = boot_entries.length;

    const expected_samples = duration > 0 ? duration / EXPECTED_INTERVAL : 0;
    const uptime_ratio =
      expected_samples > 0 ? sample_count / expected_samples : 0;

    let state, note;
    if (uptime_ratio >= 0.98) {
      state = "ok";
      note = "Data flow is stable";
    } else if (uptime_ratio >= 0.9) {
      state = "degraded";
      note = "Minor data loss detected";
    } else {
      state = "bad";
      note = "Significant data loss detected";
    }

    return sendJSON({
      state,
      note,
      boot_id: current_boot,
      uptime_seconds: +duration.toFixed(1),
      sample_count,
      uptime_ratio: +uptime_ratio.toFixed(4),
    });
  }

  // ----------------------------------------------------------
  // GET /metrics
  // ----------------------------------------------------------
  if (path === "/metrics") {
    const list = await env.HISTORY.list({ prefix: HISTORY_KEY_PREFIX });
    const entries = [];

    for (const k of list.keys) {
      const raw = await env.HISTORY.get(k.name);
      if (raw) entries.push(JSON.parse(raw));
    }

    if (entries.length < 2) {
      return sendJSON({ error: "not enough data" }, 400);
    }

    const EXPECTED_INTERVAL = 10;
    let reboot_count = 0;
    let last_boot = null;

    for (const e of entries) {
      const boot = e.boot_id;
      if (!boot) continue;
      if (last_boot && boot !== last_boot) reboot_count++;
      last_boot = boot;
    }

    const total_samples = entries.length;
    const total_time = entries[entries.length - 1].ts - entries[0].ts;
    const expected_samples =
      total_time > 0 ? total_time / EXPECTED_INTERVAL : 0;
    const uptime_ratio =
      expected_samples > 0 ? total_samples / expected_samples : 0;

    return sendJSON({
      device_id: entries[entries.length - 1].device_id,
      total_samples,
      expected_samples: +expected_samples.toFixed(2),
      reboot_count,
      uptime_ratio: +uptime_ratio.toFixed(4),
    });
  }

  // ----------------------------------------------------------
  // Not found
  // ----------------------------------------------------------
  return sendJSON({ error: "not found" }, 404);
}
``