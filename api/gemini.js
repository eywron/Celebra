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
    // Detect image requests early. Image payloads may use a `prompt`/`mode` shape
    // rather than the strict `contents` array used for text messages. If this
    // is an image request, relax the `contents` validation below and allow
    // forwarding to the image endpoint.
    const isImageRequest = Boolean(req.body && (req.body.mode === 'image' || req.body.imagePrompt));

    // Basic payload validation to avoid forwarding huge requests for text
    try {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ error: 'Bad request: missing JSON body' });
      }

      // If this is NOT an image request, expect a `contents` array similar to client payload shape
      if (!isImageRequest) {
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
    // Clone the incoming body and remove any proxy-only fields that the
    // Generative Language API does not accept (for example `metadata`).
    // Clients may include `metadata.model` to tell the proxy which model to
    // route to; the upstream API doesn't know this field and will return
    // INVALID_ARGUMENT if we forward it.
    const outgoing = JSON.parse(JSON.stringify(req.body || {}));
    if (outgoing && typeof outgoing === 'object' && outgoing.metadata) {
      delete outgoing.metadata;
    }

    // Normalize `contents` shape to avoid upstream INVALID_ARGUMENT errors
    // caused by unexpected role names or malformed parts. We coerce common
    // variants into the expected shape: { contents: [ { role: 'user'|'model', parts: [{text}] } ] }
    try{
      if(outgoing && Array.isArray(outgoing.contents)){
        const normContents = [];
        for(const c of outgoing.contents){
          if(!c || typeof c !== 'object') continue;
          // map role: accept 'model' or 'user' only, otherwise coerce to 'user'
          const role = (String(c.role || '').toLowerCase() === 'model') ? 'model' : 'user';
          // collect text parts
          if(Array.isArray(c.parts)){
            const parts = c.parts.map(p=>{
              if(!p) return null;
              if(typeof p.text === 'string') return { text: String(p.text) };
              // sometimes clients may include raw strings
              if(typeof p === 'string') return { text: p };
              return null;
            }).filter(Boolean);
            if(parts.length) normContents.push({ role, parts });
            continue;
          }
          // some payloads may use c.text directly
          if(typeof c.text === 'string' && c.text.trim()){
            normContents.push({ role, parts: [{ text: c.text }] });
            continue;
          }
        }

        // If nothing valid was found, try to synthesize from other fields
        if(normContents.length === 0){
          // prefer outgoing.prompt (image/text) if present
          if(typeof outgoing.prompt === 'string' && outgoing.prompt.trim()){
            normContents.push({ role: 'user', parts: [{ text: outgoing.prompt }] });
          } else {
            // gather any string fields from the body to form a single user message
            const collected = [];
            for(const k of Object.keys(outgoing)){
              const v = outgoing[k];
              if(typeof v === 'string' && v.trim()) collected.push(v.trim());
            }
            if(collected.length) normContents.push({ role: 'user', parts: [{ text: collected.join('\n\n') }] });
          }
        }

        if(normContents.length) outgoing.contents = normContents;
      }
    }catch(e){
      console.warn('Could not normalize outgoing contents', e);
    }

    const r = await fetch(googleUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(outgoing)
    });

    const text = await r.text();
    // Mirror status, content-type and body for successful responses
    const contentType = r.headers.get('content-type') || 'application/json';
    if (r.ok) {
      res.status(r.status).setHeader('Content-Type', contentType).send(text);
    } else {
      // Log upstream error (truncated)
      try{
        console.warn('Upstream error from Google API', { status: r.status, body: String(text).slice(0, 2000) });
      }catch(e){ console.warn('Upstream error (could not stringify body)'); }

      // If EXPOSE_UPSTREAM_ERRORS=true in env, forward upstream body (useful for temporary debugging).
      // WARNING: enabling this may leak upstream error details to clients. Use only for debugging.
        // Upstream error forwarding toggle.
        // By default we enable forwarding to help debugging in deployments where env vars weren't set.
        // To disable forwarding set EXPOSE_UPSTREAM_ERRORS to 'false' in your environment.
        const EXPOSE_UPSTREAM = (process.env.EXPOSE_UPSTREAM_ERRORS === undefined) ? 'true' : String(process.env.EXPOSE_UPSTREAM_ERRORS);
        if (EXPOSE_UPSTREAM === 'true'){
        // Try to parse and return JSON, otherwise return raw text with upstream content-type
        try{
          const parsed = JSON.parse(text);
          return res.status(r.status).setHeader('Content-Type', 'application/json').json(parsed);
        }catch(e){
          res.setHeader('Content-Type', contentType);
          return res.status(r.status).send(text);
        }
      }

      // Default: return a generic error to avoid leaking upstream details
      return res.status(r.status).json({ error: 'Upstream API error' });
    }
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Proxy request failed' });
  }
}
