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

/* ============================================================================ */
/* SIMULATED HISTORY (FIXTURE MODE)                                             */
/* ============================================================================ */
/* (unchanged) */

function hash32(x) {
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function rand01(seed) {
  return hash32(seed) / 4294967296;
}

function randSigned(seed) {
  return rand01(seed) * 2 - 1;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function simulateBucket(bucketTs, prev) {
  const BASE_SEED = 1337;
  const dayPhase = (bucketTs % 86400) / 86400 * Math.PI * 2;

  const nTemp = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x01));
  const nHum  = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x02));
  const nPres = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x03));
  const nOutT = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x04));
  const nOutH = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x05));

  const baseTemp = prev ? prev.temp : 22.0;
  const tempStep = nTemp * 0.08;
  const tempCycle = Math.sin(dayPhase) * 0.6;

  let temp = baseTemp + tempStep;
  temp = temp + (tempCycle - (prev ? prev.tempCycle : 0));
  temp = clamp(temp, 16, 30);

  const baseHum = prev ? prev.hum : 45.0;
  const humStep = nHum * 0.5;
  const humTempCoupling = (22 - temp) * 1.2;

  let hum = baseHum + humStep + humTempCoupling * 0.05;
  hum = clamp(hum, 20, 80);

  const basePres = prev ? prev.pressure : 101300.0;
  const presStep = nPres * 8;

  let pressure = basePres + presStep;
  pressure = clamp(pressure, 98000, 105000);

  let outTemp = (temp - 1.5) + nOutT * 0.4;
  outTemp = clamp(outTemp, -10, 35);

  let outHum = (hum + 5) + nOutH * 2.0;
  outHum = clamp(outHum, 10, 100);

  return {
    temp,
    hum,
    pressure,
    tempCycle,
    shelly: {
      temperature_c: outTemp,
      humidity_pct: outHum
    }
  };
}

const SIM_HISTORY_CACHE = new Map();

async function getSimulatedHistory(range) {
  const cfg = HISTORY_CFG[range];
  if (!cfg) return json({ error: "invalid range" }, 400);

  const step = cfg.stepSec;
  const now = Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(now / step) * step;

  const cacheKey = `${range}:${endBucket}`;

  const cached = SIM_HISTORY_CACHE.get(cacheKey);
  if (cached) {
    return json(cached.payload);
  }

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

  const payload = { range, samples };
  SIM_HISTORY_CACHE.set(cacheKey, { endBucket, payload });

  for (const key of SIM_HISTORY_CACHE.keys()) {
    if (key.startsWith(`${range}:`) && key !== cacheKey) {
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

    // NEW: persistent gatekeeper timestamp (seconds)
    this.lastHistWriteTs = 0;

    this.ctx.blockConcurrencyWhile(async () => {
      this.latest = await this.ctx.storage.get("latest");
      // NEW: load gatekeeper timestamp from storage
      
    this.lastHistWriteTs = Math.min(
		(await this.ctx.storage.get("lastHistWriteTs")) ?? 0,
		Math.floor(Date.now() / 1000)
	);
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

      // NEW: gatekeeper logic (history write decision)
      // - Does NOT increase request count
      // - Only adds a tiny KV write occasionally
      const HISTORY_EVERY_SEC = 60; // <-- choose 30 or 60 (start with 60)
      const nowTs = record?.ts;

      let shouldWriteHistory = false;
      if (typeof nowTs === "number") {
        if ((nowTs - this.lastHistWriteTs) >= HISTORY_EVERY_SEC) {
          shouldWriteHistory = true;
          this.lastHistWriteTs = nowTs;
          await this.ctx.storage.put("lastHistWriteTs", nowTs);
        }
      }

      // NEW: return the decision to the Worker
      return json({ ok: true, shouldWriteHistory });
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
      const record = await request.json(); // FIX: must parse JSON before using record.*
	  
	// TEMP DEBUG — inspect what is actually stored in history
	console.log(
	  "[HIST DEBUG]",
	  "record keys:", Object.keys(record || {}),
	  "weather keys:", Object.keys(record?.weather || {}),
	  "weather payload:", JSON.stringify(record?.weather).slice(0, 500)
	);

      console.log("[REAL-HIST] WeatherHistoryDO RECORD ts =", record.ts); // (your debug) now safe

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
      // FIX: DO SQLite exec() doesn't use `.one()` reliably; use `.toArray()[0]`.
      const rows = this.sql.exec(
        "SELECT MAX(ts) AS latest_ts FROM samples"
      ).toArray();

      const latestTs = rows[0]?.latest_ts; // FIX: was latestRow?.latest_ts (undefined)

      if (typeof latestTs !== "number" || !Number.isFinite(latestTs)) {
        return json({ samples: [] });
      }

      
	  const now = Math.floor(Date.now() / 1000);
	  const endBucket = Math.floor(now / BUCKET_SEC) * BUCKET_SEC;

      const startBucket = endBucket - (cfg.maxSamples - 1) * BUCKET_SEC;
      const endInclusive = endBucket + (BUCKET_SEC - 1);

      // build full bucket timeline (always N buckets)
      const buckets = [];
      for (let i = 0; i < cfg.maxSamples; i++) {
        buckets.push(startBucket + i * BUCKET_SEC);
      }

	// aggregate real rows into buckets
	// FIXES:
	// 1) Use explicit JSON paths that match what you store: temp/hum/pressure/shelly.*
	// 2) Include out_temp_c/out_hum_pct because the JS mapping expects them
	// 3) Do NOT divide pressure here; your frontend already converts Pa->hPa when rendering
	const aggRows = this.sql.exec(
	  `
	  SELECT
		(ts / ?) * ? AS bucket_ts,

		AVG(CAST(json_extract(weather_json, '$.temp') AS REAL))     AS temp,
		AVG(CAST(json_extract(weather_json, '$.hum') AS REAL))      AS hum,
		AVG(CAST(json_extract(weather_json, '$.pressure') AS REAL)) AS pressure,

		AVG(CAST(json_extract(weather_json, '$.shelly.temperature_c') AS REAL)) AS out_temp_c,
		AVG(CAST(json_extract(weather_json, '$.shelly.humidity_pct')  AS REAL)) AS out_hum_pct

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

    // stubs (well-formed URLs are enough for DO internal routing)
    const liveId = env.WEATHER_DO.idFromName("default");
    const liveStub = env.WEATHER_DO.get(liveId);

    const histStub =
      env.HISTORY_ENABLED === "true"
        ? env.WEATHER_HISTORY_DO.get(env.WEATHER_HISTORY_DO.idFromName("default"))
        : null;

    // POST /api/weather
    if (url.pathname === "/api/weather" && request.method === "POST") {
      // FIX: ts must be defined before any logging uses it
      const ts = Math.floor(Date.now() / 1000);

      console.log(
        "[REAL-HIST]",
        "HISTORY_ENABLED =", env.HISTORY_ENABLED,
        "writing record ts =", ts
      );

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

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

	// NEW: read gatekeeper decision from WeatherDO
	let shouldWriteHistory = false;
	try {
	  const liveJson = await liveRes.json();
	  shouldWriteHistory = liveJson?.shouldWriteHistory === true;
	} catch {
	  // If parsing fails, default to NOT writing history (safe)
	  shouldWriteHistory = false;
	}

	// history write ONLY if enabled AND gatekeeper says yes
	if (env.HISTORY_ENABLED === "true" && shouldWriteHistory) {
	  // NEW: run history write in background for faster device response
	  ctx.waitUntil(
		histStub.fetch(new Request("https://hist/record", {
		  method: "POST",
		  headers: { "Content-Type": "application/json" },
		  body: JSON.stringify(record),
		}))
	  );
	}
	return json({ ok: true });
}

    // GET /api/weather
    if (url.pathname === "/api/weather" && request.method === "GET") {
      return await liveStub.fetch(new Request("https://do/latest", { method: "GET" }));
      //return json({ weather: null, degraded: true });
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