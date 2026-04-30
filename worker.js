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

      return json({ samples });
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
      if (!["6h", "24h", "7d"].includes(range)) {
        return json({ error: "invalid range" }, 400);
      }

      // history read ONLY if enabled (avoids SQLite rows_read)
      if (env.HISTORY_ENABLED !== "true") {
        return json({ range, samples: [] }, 200);
      }

      const res = await histStub.fetch(new Request(
        `https://hist/history?range=${encodeURIComponent(range)}`,
        { method: "GET" }
      ));

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