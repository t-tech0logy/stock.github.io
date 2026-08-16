const requestBuckets = new Map();

const MARKET_PATHS = [
  /^\/v2\/aggs\/ticker\/[A-Z0-9.:-]+\/range\/1\/day\/\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/i,
  /^\/v3\/reference\/tickers(?:\/[A-Z0-9.:-]+)?$/i,
  /^\/v2\/reference\/news$/i,
  /^\/stocks\/v1\/dividends$/i,
  /^\/stocks\/filings\/vX\/risk-factors$/i,
  /^\/futures\/v1\/contracts$/i,
  /^\/futures\/v1\/aggs\/[A-Z0-9:._-]+$/i
];

const ALLOWED_MARKET_PARAMETERS = new Set([
  "adjusted", "sort", "order", "limit", "search", "active", "market", "ticker",
  "ex_dividend_date.gte", "ex_dividend_date.lte", "filing_date.gte", "filing_date.lte",
  "product_code", "type", "date", "resolution"
]);

function decodeBase64Secret(value) {
  const encoded = String(value || "").trim();
  if (!encoded) return "";
  try {
    const decoded = atob(encoded);
    if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) return "";
    return decoded;
  } catch {
    return "";
  }
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedOrigins(env);
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : "",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function json(request, env, body, status = 200, extraHeaders = {}) {
  const headers = corsHeaders(request, env);
  if (!headers["Access-Control-Allow-Origin"]) delete headers["Access-Control-Allow-Origin"];
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers, ...extraHeaders }
  });
}

function originIsAllowed(request, env) {
  const origin = request.headers.get("Origin");
  return Boolean(origin && allowedOrigins(env).includes(origin));
}

function withinRateLimit(request, route, limit, windowMs = 60_000) {
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `${route}:${address}`;
  const now = Date.now();
  const recent = (requestBuckets.get(key) || []).filter((time) => now - time < windowMs);
  if (recent.length >= limit) return false;
  recent.push(now);
  requestBuckets.set(key, recent);
  if (requestBuckets.size > 5000) {
    const first = requestBuckets.keys().next().value;
    requestBuckets.delete(first);
  }
  return true;
}

function safeMarketUrl(requestUrl, env, marketApiKey) {
  const path = requestUrl.searchParams.get("path") || "";
  if (!MARKET_PATHS.some((pattern) => pattern.test(path))) return null;
  const provider = new URL(`${String(env.MARKET_API_ROOT || "https://api.massive.com").replace(/\/$/, "")}${path}`);
  for (const [name, value] of requestUrl.searchParams) {
    if (name === "path") continue;
    if (!ALLOWED_MARKET_PARAMETERS.has(name)) return null;
    if (value.length > 100) return null;
    provider.searchParams.append(name, value);
  }
  provider.searchParams.set("apiKey", marketApiKey);
  return provider;
}

async function marketResponse(request, env) {
  const marketApiKey = decodeBase64Secret(env.MARKET_API_KEY_BASE64);
  if (!marketApiKey) return json(request, env, { error: "Market data is not configured." }, 503);
  if (!withinRateLimit(request, "market", 30)) return json(request, env, { error: "Too many requests. Try again shortly." }, 429);
  const providerUrl = safeMarketUrl(new URL(request.url), env, marketApiKey);
  if (!providerUrl) return json(request, env, { error: "Unsupported market-data request." }, 400);

  const cache = caches.default;
  const publicUrl = new URL(request.url);
  const cacheKey = new Request(publicUrl.toString(), { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const upstream = await fetch(providerUrl, { headers: { Accept: "application/json" } });
  const payload = await upstream.text();
  const response = new Response(payload, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
      "Cache-Control": upstream.ok ? "public, max-age=120" : "no-store",
      ...corsHeaders(request, env)
    }
  });
  if (upstream.ok) await cache.put(cacheKey, response.clone());
  return response;
}

function requestTextSize(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

async function assistantResponse(request, env) {
  const geminiApiKey = decodeBase64Secret(env.GEMINI_API_KEY_BASE64);
  if (!geminiApiKey) return json(request, env, { error: "Assistant service is not configured." }, 503);
  if (!withinRateLimit(request, "assistant", 20)) return json(request, env, { error: "Assistant limit reached. Try again shortly." }, 429);
  if (Number(request.headers.get("Content-Length") || 0) > 80_000) return json(request, env, { error: "Request is too large." }, 413);

  let input;
  try {
    input = await request.json();
  } catch {
    return json(request, env, { error: "Invalid request body." }, 400);
  }
  if (requestTextSize(input) > 80_000) return json(request, env, { error: "Request is too large." }, 413);

  const allowedModels = String(env.GEMINI_MODELS || "gemini-2.5-flash-lite")
    .split(",").map((model) => model.trim()).filter(Boolean);
  const model = String(input.model || "");
  if (!allowedModels.includes(model)) return json(request, env, { error: "Unsupported assistant model." }, 400);
  if (!input.request || !Array.isArray(input.request.contents)) return json(request, env, { error: "Invalid assistant request." }, 400);

  input.request.generationConfig = {
    ...(input.request.generationConfig || {}),
    maxOutputTokens: Math.min(1400, Math.max(100, Number(input.request.generationConfig?.maxOutputTokens) || 900))
  };
  if (Array.isArray(input.request.tools)) input.request.tools = input.request.tools.slice(0, 1);

  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": geminiApiKey },
    body: JSON.stringify(input.request)
  });
  const payload = await upstream.text();
  return new Response(payload, {
    status: upstream.status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(request, env) }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      if (!originIsAllowed(request, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    if (!originIsAllowed(request, env)) return json(request, env, { error: "Origin is not allowed." }, 403);
    if (request.method === "GET" && url.pathname === "/market") return marketResponse(request, env);
    if (request.method === "POST" && url.pathname === "/assistant") return assistantResponse(request, env);
    if (request.method === "GET" && url.pathname === "/health") return json(request, env, { status: "ok" });
    return json(request, env, { error: "Not found." }, 404);
  }
};
