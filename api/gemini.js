// api/gemini.js — Vercel serverless proxy for Gemini v2
// This function forwards the client's request to Google's Generative Language API
// using a server-side API key stored in the environment variable `GEMINI_API_KEY`.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Read the API key from the environment. Set GEMINI_API_KEY in Vercel (or your host).
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server missing GEMINI_API_KEY environment variable' });
  }

  // Allow overriding the exact Google endpoint in case you need a different model/version.
  // Example: set GEMINI_API_ENDPOINT to
  // "https://generativelanguage.googleapis.com/v1/models/gemini-2.1:generate" or similar.
  // Default to the gemini-2.5-flash endpoint provided by the user; can be overridden by GEMINI_API_ENDPOINT.
  // If the client includes `metadata.model` in the request body, route to that specific model endpoint.
  const defaultGoogleUrl = process.env.GEMINI_API_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  let googleUrl = defaultGoogleUrl;
  try{
    const requestedModel = req.body && req.body.metadata && req.body.metadata.model;
    if(requestedModel && typeof requestedModel === 'string'){
      // Route to the requested model's generateContent endpoint
      googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requestedModel)}:generateContent`;
    }
  }catch(e){/* ignore and fall back to default */}

  // --- Basic protections: allowed origins and simple rate limiting
  const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS; // comma-separated list
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS) {
    const allowed = ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) {
      console.warn(`Blocked origin: ${origin}`);
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    // set CORS header for successful responses
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  // Simple in-memory rate limiter (per IP). For production use a shared store (Redis/Upstash)
  const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '60', 10); // default 60 requests
  const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || '3600', 10); // seconds
  const now = Math.floor(Date.now() / 1000);
  // keep map across lambda warm instances
  const map = global.__celebraRateLimitMap = global.__celebraRateLimitMap || new Map();
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';
  let entry = map.get(ip);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + RATE_LIMIT_WINDOW };
  }
  entry.count++;
  map.set(ip, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = entry.reset - now;
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Rate limit exceeded', retry_after_seconds: retryAfter });
  }

  try {
    // Basic payload validation to avoid forwarding huge requests
    try {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Bad request: missing JSON body' });
      }
      // Expect `contents` array similar to client payload shape
      const contents = body.contents;
      if (!Array.isArray(contents) || contents.length === 0 || contents.length > 10) {
        return res.status(400).json({ error: 'Bad request: invalid contents' });
      }
      // limit text length to reasonable size
      for (const c of contents) {
        if (!c.parts || !Array.isArray(c.parts)) continue;
        for (const p of c.parts) {
          if (String(p.text || '').length > 8000) {
            return res.status(400).json({ error: 'Bad request: message too long' });
          }
        }
      }
    } catch (e) {
      console.warn('Validation error', e);
      return res.status(400).json({ error: 'Bad request' });
    }

    // If this is an image generation request, route to the images endpoint and
    // normalize response to a predictable shape when possible.
    if (req.body && (req.body.mode === 'image' || req.body.imagePrompt || req.body.prompt && req.body.mode === 'image')) {
      const imageEndpoint = process.env.GEMINI_IMAGE_ENDPOINT || 'https://generativelanguage.googleapis.com/v1/images:generate';
      // Prepare a simple payload. If the client sent a full body, forward it.
      const imagePayload = (req.body && Object.keys(req.body).length > 0) ? req.body : { prompt: req.body.prompt || req.body.imagePrompt };
      const rImg = await fetch(imageEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(imagePayload)
      });

      const text = await rImg.text();
      let parsed = null;
      try{ parsed = JSON.parse(text); } catch(e){ parsed = null; }

      // Try to normalize a few common image response shapes to { images: [{url}|{b64}] }
      const normalized = { images: [] };
      if(parsed){
        // Walk parsed object for urls or base64 fields
        const walk = (o) => {
          if(!o || typeof o !== 'object') return;
          if(Array.isArray(o)) return o.forEach(walk);
          if(o.url && typeof o.url === 'string') normalized.images.push({ url: o.url });
          if(o.b64 || o.b64_json || o.b64_image) normalized.images.push({ b64: o.b64 || o.b64_json || o.b64_image });
          for(const k of Object.keys(o)) walk(o[k]);
        };
        walk(parsed);
      }

      // If we found nothing, return raw parsed response (or text)
      if(normalized.images.length === 0){
        return res.status(rImg.status).setHeader('Content-Type', rImg.headers.get('content-type') || 'application/json').send(text);
      }

      return res.status(200).json(normalized);
    }

    // Otherwise handle text generation as before
    const r = await fetch(googleUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(req.body)
    });

    const text = await r.text();
    // Mirror status, content-type and body for successful responses
    const contentType = r.headers.get('content-type') || 'application/json';
    if (r.ok) {
      res.status(r.status).setHeader('Content-Type', contentType).send(text);
    } else {
      // Log upstream error but return a generic message to the client to avoid leaking details
      console.warn('Upstream error from Google API', { status: r.status, body: text.slice(0, 2000) });
      return res.status(r.status).json({ error: 'Upstream API error' });
    }
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Proxy request failed' });
  }
}
