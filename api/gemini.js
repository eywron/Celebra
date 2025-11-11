export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server missing GEMINI_API_KEY environment variable' });
  }

  const defaultGoogleUrl = process.env.GEMINI_API_ENDPOINT || 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  let googleUrl = defaultGoogleUrl;
  try{
    const requestedModel = req.body && req.body.metadata && req.body.metadata.model;
    if(requestedModel && typeof requestedModel === 'string'){
      googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requestedModel)}:generateContent`;
    }
  }catch(e){}

  const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS;
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS) {
    const allowed = ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) {
      console.warn(`Blocked origin: ${origin}`);
      return res.status(403).json({ error: 'Origin not allowed' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
  }

  const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '60', 10);
  const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW || '3600', 10);
  const now = Math.floor(Date.now() / 1000);
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
    const outgoing = JSON.parse(JSON.stringify(req.body || {}));

    try{
      const GLOBAL_AI_INSTRUCTION = `Always respond naturally, as if chatting with a real person.\nUse a friendly and conversational tone while staying clear and informative.\n\nKeep answers well-formatted and easy to read. Use short paragraphs with proper spacing between ideas. When appropriate, include bullet points or numbered lists to organize information neatly.\n\nIf explaining a process or a concept, present steps clearly and logically. When responding to questions with calculations or numbers, make sure to compute accurately and explain the result in a simple way.\n\nAvoid unnecessary repetition or overly long explanations. Be concise, engaging, and human-like in every response.`;
      if(!Array.isArray(outgoing.contents) || !outgoing.contents.some(c => String(c.role || '').toLowerCase() === 'system')){
        outgoing.contents = outgoing.contents || [];
        outgoing.contents.unshift({ role: 'system', parts: [{ text: GLOBAL_AI_INSTRUCTION }] });
      }
    }catch(e){}

    const isImageRequest = false;

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
        outgoing.contents = [{ role: 'user', parts: [{ text: outgoing.prompt }] }];
      }
    }catch(e){
      console.warn('Could not normalize outgoing contents', e);
    }

    try {
      if (!outgoing || typeof outgoing !== 'object') {
        return res.status(400).json({ error: 'Bad request: missing JSON body' });
      }
      if (!isImageRequest) {
        const contents = outgoing.contents;
        if (!Array.isArray(contents) || contents.length === 0 || contents.length > 10) {
          return res.status(400).json({ error: 'Bad request: invalid contents' });
        }
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

    if(outgoing && typeof outgoing === 'object' && outgoing.metadata) delete outgoing.metadata;
    if(outgoing && typeof outgoing === 'object' && outgoing.metadata && outgoing.metadata.model) delete outgoing.metadata.model;

    const r = await fetch(googleUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(outgoing)
    });

    const text = await r.text();
    const contentType = r.headers.get('content-type') || 'application/json';
    if (r.ok) {
      res.status(r.status).setHeader('Content-Type', contentType).send(text);
    } else {
      try{
        console.warn('Upstream error from Google API', { status: r.status, body: String(text).slice(0, 2000) });
      }catch(e){ console.warn('Upstream error (could not stringify body)'); }

      const EXPOSE_UPSTREAM = (process.env.EXPOSE_UPSTREAM_ERRORS === undefined) ? 'true' : String(process.env.EXPOSE_UPSTREAM_ERRORS);
      if (EXPOSE_UPSTREAM === 'true'){
        try{
          const parsed = JSON.parse(text);
          return res.status(r.status).setHeader('Content-Type', 'application/json').json(parsed);
        }catch(e){
          res.setHeader('Content-Type', contentType);
          return res.status(r.status).send(text);
        }
      }

      return res.status(r.status).json({ error: 'Upstream API error' });
    }
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Proxy request failed' });
  }
}
