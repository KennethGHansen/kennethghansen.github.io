let latest = null;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}


	export default {
	  async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === "/api/weather" && request.method === "POST") {
		  const payload = await request.json();   // ← your line
		  latest = payload;                        // ← your line
		  return Response.json({ ok: true });      // ← your line
		}

		if (url.pathname === "/api/weather" && request.method === "GET") {
		  if (!latest) {
			return Response.json({ error: "no data yet" }, { status: 404 });
		  }
		  return Response.json(latest);
		}

		return new Response("Not found", { status: 404 });
	  }
	};


    // ---------------------------------
    // GET /api/weather (UI → latest)
    // ---------------------------------
    if (url.pathname === "/api/weather" && request.method === "GET") {
      if (!latest) return json({ error: "no data yet" }, 404);
      return json(latest);
    }

    // ---------------------------------
    // Health check
    // ---------------------------------
    if (url.pathname === "/api/test") {
      return json({ status: "worker-alive" });
    }

    // ---------------------------------
    // Everything else: let assets serve it
    // ---------------------------------
    return env.ASSETS.fetch(request);
  },
};