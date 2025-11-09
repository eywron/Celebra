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
    // Clone incoming body early and normalize it before validation. This
    // allows the proxy to repair common client-side shape problems (bad
    // role names, string parts, etc.) rather than rejecting the request.
    const outgoing = JSON.parse(JSON.stringify(req.body || {}));

    // Inject a global conversational instruction so all model responses
    // follow the same friendly, concise, human-like style. This keeps the
    // instruction server-side (not exposed to the client source) and ensures
    // consistent behavior across clients.
    try{
      const GLOBAL_AI_INSTRUCTION = `Always respond naturally, as if chatting with a real person.\nUse a friendly and conversational tone while staying clear and informative.\n\nKeep answers well-formatted and easy to read. Use short paragraphs with proper spacing between ideas. When appropriate, include bullet points or numbered lists to organize information neatly.\n\nIf explaining a process or a concept, present steps clearly and logically. When responding to questions with calculations or numbers, make sure to compute accurately and explain the result in a simple way.\n\nAvoid unnecessary repetition or overly long explanations. Be concise, engaging, and human-like in every response.`;
      // Only add if there's no system-level content already present
      if(!Array.isArray(outgoing.contents) || !outgoing.contents.some(c => String(c.role || '').toLowerCase() === 'system')){
        outgoing.contents = outgoing.contents || [];
        outgoing.contents.unshift({ role: 'system', parts: [{ text: GLOBAL_AI_INSTRUCTION }] });
      }
    }catch(e){ /* ignore injection errors */ }

  // Image generation has been removed — always treat as text request
  const isImageRequest = false;

    // Normalize contents (coerce roles, ensure parts are objects, synthesize
    // contents from prompt/text fields) so validation below works on a clean
    // shape. This mirrors the later normalization but runs earlier to avoid
    // pre-validation 400s.
    try{
      if(outgoing && Array.isArray(outgoing.contents)){
        const normContents = [];
        for(const c of outgoing.contents){
          if(!c || typeof c !== 'object') continue;
          const role = (String(c.role || '').toLowerCase() === 'model') ? 'model' : 'user';
          if(Array.isArray(c.parts)){
            const parts = c.parts.map(p=>{
              if(!p) return null;
              if(typeof p.text === 'string') return { text: String(p.text) };
              if(typeof p === 'string') return { text: p };
              return null;
            }).filter(Boolean);
            if(parts.length) normContents.push({ role, parts });
            continue;
          }
          if(typeof c.text === 'string' && c.text.trim()){
            normContents.push({ role, parts: [{ text: c.text }] });
            continue;
          }
        }
        if(normContents.length === 0){
          if(typeof outgoing.prompt === 'string' && outgoing.prompt.trim()){
            normContents.push({ role: 'user', parts: [{ text: outgoing.prompt }] });
          } else {
            const collected = [];
            for(const k of Object.keys(outgoing)){
              const v = outgoing[k];
              if(typeof v === 'string' && v.trim()) collected.push(v.trim());
            }
            if(collected.length) normContents.push({ role: 'user', parts: [{ text: collected.join('\n\n') }] });
          }
        }
        if(normContents.length) outgoing.contents = normContents;
      } else if(!Array.isArray(outgoing.contents) && (typeof outgoing.prompt === 'string' && outgoing.prompt.trim())){
        // If no contents but there is a prompt, synthesize a single user content entry
        outgoing.contents = [{ role: 'user', parts: [{ text: outgoing.prompt }] }];
      }
    }catch(e){
      console.warn('Could not normalize outgoing contents', e);
    }

    // Basic payload validation to avoid forwarding huge requests for text
    try {
      if (!outgoing || typeof outgoing !== 'object') {
        return res.status(400).json({ error: 'Bad request: missing JSON body' });
      }

      // If this is NOT an image request, expect a `contents` array similar to client payload shape
      if (!isImageRequest) {
        const contents = outgoing.contents;
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

    // image generation removed — nothing to do here

  // Ensure proxy-only fields aren't forwarded. Remove `metadata` if present.
  if(outgoing && typeof outgoing === 'object' && outgoing.metadata) delete outgoing.metadata;
  if(outgoing && typeof outgoing === 'object' && outgoing.metadata && outgoing.metadata.model) delete outgoing.metadata.model;

  // Otherwise handle text generation as before. We normalized `outgoing`
  // earlier, so reuse that normalized object for the upstream request below.

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
