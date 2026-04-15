// IMPORTANT: In production (your Worker), use same-origin so CORS is not involved.
const API_BASE = ""; // same origin

async function load() {
  try {
    const r = await fetch(`${API_BASE}/api/weather?nocache=${Date.now()}`, {
      cache: "no-store",
    });

    // Fix A: 404 means "no data yet" (not a real error)
    if (r.status === 404) {
      let data = null;
      try {
        data = await r.json();
      } catch (_) {
        // ignore JSON parse errors
      }
      const msg = data?.error ? `Waiting: ${data.error}` : "Waiting for first reading...";
      document.getElementById("weather").textContent = msg;
      return;
    }

    // Other non-OK statuses are real errors
    if (!r.ok) {
      document.getElementById("weather").textContent = `API error: HTTP ${r.status}`;
      return;
    }

    const data = await r.json();
    document.getElementById("weather").textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    document.getElementById("weather").textContent = `Fetch failed: ${e.message}`;
  }
}

load();
setInterval(load, 5000);