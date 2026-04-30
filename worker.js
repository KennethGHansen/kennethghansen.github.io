/* =============================================================================
 * weather-station / worker.js  (ESM module)
 * =============================================================================
 *
 * IMPORTANT:
 * - NO top-level `return` allowed in ESM. All returns must be inside functions. [1](https://github.com/evanw/esbuild/issues/1814)
 *
 * FEATURE FLAG:
 * - env.HISTORY_ENABLED controls whether history is written/read.
 * - The flag is checked INSIDE the Worker fetch handler (never at top-level).
 *
 * TWO Durable Objects:
 * 1) WeatherDO: latest only (KV)
 * 2) WeatherHistoryDO: history rows (SQLite), bucketed+gap-filled
 * =============================================================================
 */

/* ----------------------------------------------------------------------------- */
/* JSON helper                                                                    */
/* ----------------------------------------------------------------------------- */
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

/* ----------------------------------------------------------------------------- */
/* HISTORY CONFIG                                                                 */
/* ----------------------------------------------------------------------------- */
const HISTORY_CFG = {
  "6h":  { stepSec: 5 * 60,    maxSamples: 72,  windowSec: 6 * 3600   },
  "24h": { stepSec: 10 * 60,   maxSamples: 144, windowSec: 24 * 3600  },
  "7d":  { stepSec: 60 * 60,   maxSamples: 168, windowSec: 7 * 86400  },
};


/* ============================================================================
 * SIMULATED HISTORY (FIXTURE MODE)
 * ============================================================================
 *
 * GOAL:
 * - Provide a perfect stand-in for real history so frontend work has no surprises
 * - Output shape must MATCH real history exactly:
 *     { range: "6h|24h|7d", samples: [ { ts, boot_id, weather: { ... } } ] }
 *
 * IMPORTANT DESIGN RULES:
 * 1) Deterministic: same bucket timestamp => same values
 *    This prevents "jumping" on every poll/refresh.
 * 2) Bucket-aligned: timestamps are always exactly bucket boundaries.
 * 3) Same semantics as real:
 *    - 6h => 72 buckets @ 5 min
 *    - 24h => 144 buckets @ 10 min
 *    - 7d => 168 buckets @ 1 hour
 * 4) Values look like a stream:
 *    - temperature random-walk + gentle daily cycle
 *    - humidity inversely correlated to temperature
 *    - pressure slow drift + small noise
 *    - outdoor slightly different + its own noise
 * ========================================================================== */

/* --------------------------------------------------------------------------
 * Deterministic PRNG utilities
 * --------------------------------------------------------------------------
 * We use a simple hash-based generator:
 * - Feed it (seed + bucket_ts + channel)
 * - It returns a repeatable pseudo-random number in [0, 1)
 * This guarantees stability across requests/reloads.
 * ------------------------------------------------------------------------ */

// 32-bit integer hash (fast, deterministic)
function hash32(x) {
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

// pseudo-random float in [0, 1)
function rand01(seed) {
  return hash32(seed) / 4294967296;
}

// pseudo-random float in [-1, 1)
function randSigned(seed) {
  return rand01(seed) * 2 - 1;
}

/* --------------------------------------------------------------------------
 * Clamp helper
 * ------------------------------------------------------------------------ */
function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/* --------------------------------------------------------------------------
 * Compute one bucket's simulated weather values
 * --------------------------------------------------------------------------
 * INPUT:
 * - bucketTs: unix seconds, aligned to bucket boundary
 * - prev: previous bucket’s values (for smooth random walk)
 *
 * OUTPUT:
 * - { temp, hum, pressure, shelly: { temperature_c, humidity_pct } }
 * ------------------------------------------------------------------------ */
function simulateBucket(bucketTs, prev) {
  // ---- GLOBAL SEED (change this to get a different "world") ----
  const BASE_SEED = 1337;

  // ---- daily cycle factor (0..2π over 24h) ----
  const dayPhase = (bucketTs % 86400) / 86400 * Math.PI * 2;

  // ---- random sources (stable per bucket) ----
  const nTemp = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x01));
  const nHum  = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x02));
  const nPres = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x03));
  const nOutT = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x04));
  const nOutH = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x05));

  // ---- Temperature (°C): random-walk + gentle daily sinusoid ----
  // Start around 22°C, drift slowly.
  const baseTemp = prev ? prev.temp : 22.0;

  // random walk step (small)
  const tempStep = nTemp * 0.08; // adjust if you want more/less jitter

  // daily cycle (~±0.6°C)
  const tempCycle = Math.sin(dayPhase) * 0.6;

  let temp = baseTemp + tempStep;
  temp = temp + (tempCycle - (prev ? prev.tempCycle : 0)); // preserve continuity of cycle
  temp = clamp(temp, 16, 30);

  // ---- Humidity (%): inversely related to temp + small noise ----
  // Start around 45%, drift slowly. Higher temp -> slightly lower humidity.
  const baseHum = prev ? prev.hum : 45.0;
  const humStep = nHum * 0.5;

  // temp influence: warmer => lower RH
  const humTempCoupling = (22 - temp) * 1.2;

  let hum = baseHum + humStep + humTempCoupling * 0.05;
  hum = clamp(hum, 20, 80);

  // ---- Pressure (Pa): slow drift + tiny noise ----
  // Around 101300 Pa with very small random walk.
  const basePres = prev ? prev.pressure : 101300.0;
  const presStep = nPres * 8; // very small drift in Pa

  let pressure = basePres + presStep;
  pressure = clamp(pressure, 98000, 105000);

  // ---- Outdoor (Shelly) ----
  // Outdoor temp tends to be slightly cooler/warmer with more noise.
  // Outdoor humidity tends to be a bit different with more noise.
  let outTemp = (temp - 1.5) + nOutT * 0.4;
  outTemp = clamp(outTemp, -10, 35);

  let outHum = (hum + 5) + nOutH * 2.0;
  outHum = clamp(outHum, 10, 100);

  return {
    temp,
    hum,
    pressure,
    tempCycle, // internal bookkeeping so cycle stays continuous bucket-to-bucket
    shelly: {
      temperature_c: outTemp,
      humidity_pct: outHum
    }
  };
}

/* ============================================================================
 * SIMULATED HISTORY CACHE (freeze within a bucket window)
 * ============================================================================
 *
 * WHY:
 * - Frontend polls every ~15s.
 * - We do NOT want to recompute the whole simulated series on every poll.
 * - Real history behaves like: "same window until the next bucket boundary".
 *
 * WHAT THIS DOES:
 * - Caches the generated response for (range + endBucket).
 * - While the clock remains inside the same endBucket, responses are identical.
 * - When endBucket changes (next 5/10/60 min boundary), cache auto-advances.
 * ========================================================================== */
const SIM_HISTORY_CACHE = new Map(); // key -> { endBucket:number, payload:any }

/* --------------------------------------------------------------------------
 * Generate simulated history for one range
 * --------------------------------------------------------------------------
 * NOTE:
 * - We align the right edge to the current bucket boundary (like real).
 * - We always return exactly cfg.maxSamples buckets.
 * ------------------------------------------------------------------------ */
async function getSimulatedHistory(range) {
  const cfg = HISTORY_CFG[range];
  if (!cfg) return json({ error: "invalid range" }, 400);

  const step = cfg.stepSec;

  // ------------------------------------------------------------------------
  // Align right edge to the current bucket boundary (same as real history)
  // ------------------------------------------------------------------------
  const now = Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(now / step) * step;

  // ------------------------------------------------------------------------
  // CACHE KEY: range + endBucket
  // - Same range + same endBucket => return cached response (frozen)
  // - New endBucket => generate new series once
  // ------------------------------------------------------------------------
  const cacheKey = `${range}:${endBucket}`;

  const cached = SIM_HISTORY_CACHE.get(cacheKey);
  if (cached) {
    // Frozen response within this bucket window
    return json(cached.payload);
  }

  // ------------------------------------------------------------------------
  // Build NEW simulated series (only runs once per bucket boundary)
  // ------------------------------------------------------------------------
  const startBucket = endBucket - (cfg.maxSamples - 1) * step;

  const samples = [];
  let prev = null;

  for (let i = 0; i < cfg.maxSamples; i++) {
    const ts = startBucket + i * step;

    const v = simulateBucket(ts, prev);

    samples.push({
      ts,
      boot_id: null,
      weather: {
        temp: v.temp,
        hum: v.hum,
        pressure: v.pressure,
        shelly: {
          temperature_c: v.shelly.temperature_c,
          humidity_pct: v.shelly.humidity_pct
        }
      }
    });

    prev = v;
  }

  // ------------------------------------------------------------------------
  // Store in cache and return
  // ------------------------------------------------------------------------
  const payload = { range, samples };
  SIM_HISTORY_CACHE.set(cacheKey, { endBucket, payload });

  // Optional: keep cache small (only latest 3 windows per range)
  // This prevents unbounded growth if someone keeps the tab open for days.
  for (const key of SIM_HISTORY_CACHE.keys()) {
    if (key.startsWith(`${range}:`) && key !== cacheKey) {
      // Keep only the newest entry for this range (simple policy)
      SIM_HISTORY_CACHE.delete(key);
    }
  }

  return json(payload);
}

/* =============================================================================
 * Durable Object #1: WeatherDO (LATEST ONLY, KV)
 * ============================================================================= */
export class WeatherDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.latest = null;

    this.ctx.blockConcurrencyWhile(async () => {
      this.latest = await this.ctx.storage.get("latest");
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /update -> store latest
    if (url.pathname === "/update" && request.method === "POST") {
      let record;
      try {
        record = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      this.latest = record;
      await this.ctx.storage.put("latest", record);
      return json({ ok: true });
    }

    // GET /latest -> return latest
    if (url.pathname === "/latest" && request.method === "GET") {
      if (!this.latest) this.latest = await this.ctx.storage.get("latest");
      if (!this.latest) return json({ error: "no data yet" }, 404);
      return json(this.latest);
    }

    return json({ error: "not found" }, 404);
  }
}

/* =============================================================================
 * Durable Object #2: WeatherHistoryDO (HISTORY, SQLite)
 * ============================================================================= */
export class WeatherHistoryDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = this.ctx.storage.sql;

    this.ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS samples (
          ts INTEGER PRIMARY KEY,
          boot_id INTEGER,
          weather_json TEXT NOT NULL
        );
      `);
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);`);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // POST /record -> insert one row
    if (url.pathname === "/record" && request.method === "POST") {
      const record = await request.json();

      this.sql.exec(
        "INSERT OR REPLACE INTO samples (ts, boot_id, weather_json) VALUES (?, ?, ?)",
        record.ts,
        record.boot_id ?? null,
        JSON.stringify(record.weather)
      );

      // retention: keep 10 days
      const RETENTION_SEC = 10 * 24 * 60 * 60;
      const cutoff = record.ts - RETENTION_SEC;
      this.sql.exec("DELETE FROM samples WHERE ts < ?", cutoff);

      return json({ ok: true });
    }

    // GET /history?range=...
    if (url.pathname === "/history" && request.method === "GET") {
      const range = url.searchParams.get("range");
      const cfg = HISTORY_CFG[range];
      if (!cfg) return json({ error: "invalid range" }, 400);

      const BUCKET_SEC = cfg.stepSec;

      // anchor to latest real sample bucket (freeze on outage)
      const latestRow = this.sql.exec("SELECT MAX(ts) AS latest_ts FROM samples").one();
      const latestTs = latestRow?.latest_ts;

      if (typeof latestTs !== "number" || !Number.isFinite(latestTs)) {
        return json({ samples: [] });
      }

      const endBucket = Math.floor(latestTs / BUCKET_SEC) * BUCKET_SEC;
      const startBucket = endBucket - (cfg.maxSamples - 1) * BUCKET_SEC;
      const endInclusive = endBucket + (BUCKET_SEC - 1);

      // build full bucket timeline (always N buckets)
      const buckets = [];
      for (let i = 0; i < cfg.maxSamples; i++) {
        buckets.push(startBucket + i * BUCKET_SEC);
      }

      // aggregate real rows into buckets
      const aggRows = this.sql.exec(
        `
        SELECT
          (ts / ?) * ? AS bucket_ts,
          AVG(json_extract(weather_json, '$.temp'))     AS temp,
          AVG(json_extract(weather_json, '$.hum'))      AS hum,
          AVG(json_extract(weather_json, '$.pressure')) AS pressure,
          AVG(json_extract(weather_json, '$.shelly.temperature_c')) AS out_temp_c,
          AVG(json_extract(weather_json, '$.shelly.humidity_pct'))  AS out_hum_pct
        FROM samples
        WHERE ts >= ? AND ts <= ?
        GROUP BY bucket_ts
        `,
        BUCKET_SEC, BUCKET_SEC,
        startBucket, endInclusive
      ).toArray();

      const byBucket = new Map();
      for (const r of aggRows) {
        byBucket.set(r.bucket_ts, {
          temp:     (r.temp == null ? null : Number(r.temp)),
          hum:      (r.hum == null ? null : Number(r.hum)),
          pressure: (r.pressure == null ? null : Number(r.pressure)),
          shelly: {
            temperature_c: (r.out_temp_c == null ? null : Number(r.out_temp_c)),
            humidity_pct:  (r.out_hum_pct == null ? null : Number(r.out_hum_pct)),
          },
        });
      }

      const samples = buckets.map(ts => {
        const v = byBucket.get(ts) ?? {
          temp: null, hum: null, pressure: null,
          shelly: { temperature_c: null, humidity_pct: null }
        };
        return { ts, boot_id: null, weather: v };
      });

      return json({ range, samples });
    }

    return json({ error: "not found" }, 404);
  }
}

/* =============================================================================
 * Worker Entrypoint
 * ============================================================================= */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
	
	if (url.pathname === "/api/weather" && request.method === "GET") {
		return new Response(
			JSON.stringify({ test: "weather bypass" }),
			{ status: 200, headers: { "Content-Type": "application/json" } }
		);
	}

    // stubs (well-formed URLs are enough for DO internal routing) [2](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
    const liveId = env.WEATHER_DO.idFromName("default");
    const liveStub = env.WEATHER_DO.get(liveId);

    const histStub =
	env.HISTORY_ENABLED === "true"
    ? env.WEATHER_HISTORY_DO.get(env.WEATHER_HISTORY_DO.idFromName("default"))
    : null;

    // POST /api/weather
    if (url.pathname === "/api/weather" && request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      const ts = Math.floor(Date.now() / 1000);

      const record = {
        ts,
        device_id: payload.device_id ?? null,
        boot_id: payload.boot_id ?? null,
        weather: payload,
      };

      // always update latest
      const liveRes = await liveStub.fetch(new Request("https://do/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }));
      if (!liveRes.ok) return liveRes;

      // history write ONLY if enabled
      if (env.HISTORY_ENABLED === "true") {
        const histRes = await histStub.fetch(new Request("https://hist/record", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(record),
        }));
        if (!histRes.ok) return histRes;
      }

      return json({ ok: true });
    }

    // GET /api/weather
    if (url.pathname === "/api/weather" && request.method === "GET") {
      //return await liveStub.fetch(new Request("https://do/latest", { method: "GET" }));
	  return json({ weather: null, degraded: true });
    }

	// GET /api/history?range=...
	if (url.pathname === "/api/history" && request.method === "GET") {
	  const range = url.searchParams.get("range");

	  // Validate input early
	  if (!["6h", "24h", "7d"].includes(range)) {
		return json({ error: "invalid range" }, 400);
	  }

	  // MODE SWITCH (single source of truth for dev)
	  // - SIMULATED: return generated history, do NOT touch Durable Objects
	  // - REAL: return real history if enabled
	  const requestedMode =
	  url.searchParams.get("mode") === "real" ? "REAL" : "SIMULATED";

	  // SIMULATED is always allowed
	  if (requestedMode === "SIMULATED") {
	    return await getSimulatedHistory(range);
	  }

	  // REAL is still server‑gated
	  if (env.HISTORY_ENABLED !== "true") {
	    return json({ range, samples: [] }, 200);
	  }

	  // REAL path feature-flag: if history not enabled, return empty (and NO DO calls)
	  // env vars are only available inside fetch(request, env, ctx) (Worker docs) [1](https://developers.cloudflare.com/workers/configuration/environment-variables/)
	  if (env.HISTORY_ENABLED !== "true") {
		return json({ range, samples: [] }, 200);
	  }

	  // REAL path: call History DO
	  const res = await histStub.fetch(
		new Request(`https://hist/history?range=${encodeURIComponent(range)}`, { method: "GET" })
	  );

	  const data = await res.json();
	  return json({ range, samples: data.samples ?? [] });
	}


    // health check
    if (url.pathname === "/api/test") {
      return json({ status: "worker-alive" });
    }

    // static assets
    return env.ASSETS.fetch(request);
  },
};