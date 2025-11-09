// script.js — Celebra Chat UI + Gemini v2 integration
// Recommended deployment: use the provided serverless proxy on Vercel so the API key is kept server-side.
// By default this client calls the relative proxy endpoint `/api/gemini` (Vercel Serverless Function included).
// If you want to call Gemini directly from the browser (not recommended — exposes your key), set
// `USE_PROXY = false` and set `CLIENT_API_KEY` below. For Vercel deployment leave USE_PROXY=true.

const USE_PROXY = true; // true => POST to /api/gemini (server-side forwarding)
const CLIENT_API_KEY = null; // optional local client key (unsafe in production)
const DEBUG_SHOW_ERRORS = true; // when true, show proxied error messages in the UI for debugging
const PROXY_ENDPOINT = '/api/gemini';
const MODEL_ENDPOINT = USE_PROXY ? PROXY_ENDPOINT : 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// --- Helpers and DOM refs
const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const newChatBtn = document.getElementById('newChatBtn');
const presetsEl = document.querySelectorAll('.chip');

// preserve a simple preset setting for response style (kept as a hidden internal option)
let selectedPreset = 'balanced';

// Model choices: map real model ids to friendly alias names (we avoid using original model display names)
const modelChoices = [
  { id: 'gemini-2.5-pro', alias: 'Nova Pro' },
  { id: 'gemini-2.5-flash', alias: 'Neon Flash' },
  { id: 'gemini-2.5-flash-preview', alias: 'Neon Preview' },
  { id: 'gemini-2.5-flash-lite', alias: 'Neon Lite' },
  { id: 'gemini-2.5-flash-lite-preview', alias: 'Neon Lite Preview' },
  { id: 'gemini-2.0-flash', alias: 'Pulse Flash' },
  { id: 'gemini-2.0-flash-lite', alias: 'Pulse Lite' }
];

// selectedModelIndex indicates which model from modelChoices is active (0 = highest tier)
let selectedModelIndex = 1; // default to gemini-2.5-flash (Neon Flash)

// Conversation history settings
const HISTORY_KEY = 'celebra_conversation_history_v1';
const HISTORY_MAX_MESSAGES = 16; // keep last N messages (user+assistant)
const HISTORY_MAX_CHARS = 8000; // also cap by characters

// load/save simple history stored as [{role:'user'|'assistant', text: '...'}]
function loadHistory(){
  try{
    const raw = localStorage.getItem(HISTORY_KEY);
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    if(Array.isArray(parsed)) return parsed;
  }catch(e){}
  return [];
}

function saveHistory(hist){
  try{
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist || []));
  }catch(e){/* ignore */}
}

function addMessageToHistory(role, text){
  if(!text) return;
  const h = loadHistory();
  h.push({ role, text });
  // Trim by messages
  while(h.length > HISTORY_MAX_MESSAGES) h.shift();
  // Trim by chars (remove oldest until under limit)
  let total = h.reduce((s,m)=> s + (m.text ? m.text.length : 0), 0);
  while(total > HISTORY_MAX_CHARS && h.length){
    h.shift();
    total = h.reduce((s,m)=> s + (m.text ? m.text.length : 0), 0);
  }
  saveHistory(h);
}

function clearHistory(){
  try{ localStorage.removeItem(HISTORY_KEY); }catch(e){}
}

// Compose actions: plus button and quick actions menu (Generate image)
const plusBtn = document.getElementById('plusBtn');
const plusMenu = document.getElementById('plusMenu');
const generateImageBtn = document.getElementById('generateImageBtn');

// Toggle menu visibility
if(plusBtn && plusMenu){
  plusBtn.addEventListener('click', (e)=>{
    const expanded = plusBtn.getAttribute('aria-expanded') === 'true';
    plusBtn.setAttribute('aria-expanded', String(!expanded));
    plusMenu.setAttribute('aria-hidden', String(expanded));
  });

  // Close menu when clicking outside
  document.addEventListener('click', (ev)=>{
    if(!plusMenu) return;
    const path = ev.composedPath ? ev.composedPath() : (ev.path || []);
    if(!path.includes(plusMenu) && !path.includes(plusBtn)){
      plusMenu.setAttribute('aria-hidden', 'true');
      if(plusBtn) plusBtn.setAttribute('aria-expanded','false');
    }
  });
}

// Generate image action: prefix input with '/image ' and focus it
if(generateImageBtn){
  generateImageBtn.addEventListener('click', (e)=>{
    e.preventDefault();
    // close menu
    if(plusMenu) plusMenu.setAttribute('aria-hidden','true');
    if(plusBtn) plusBtn.setAttribute('aria-expanded','false');
    const cur = input.value || '';
    // if already an image command, just focus
    if(cur.trim().toLowerCase().startsWith('/image')){
      input.focus();
      return;
    }
    // prefix with /image and keep existing text as the prompt
    input.value = '/image ' + cur.trim();
    input.focus();
    // place cursor at end
    input.selectionStart = input.selectionEnd = input.value.length;
  });
}

// Focus input on load
input.focus();

function createBubble(role, text, isTyping=false){
  const wrap = document.createElement('div');
  wrap.className = 'bubble ' + (role === 'user' ? 'user' : 'bot');

  // Optional small meta line (hidden visually on simple UIs)
  const content = document.createElement('div');
  if(isTyping){
    const dots = document.createElement('div');
    dots.className = 'typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';
    content.appendChild(dots);
  } else {
    content.textContent = text;
  }

  wrap.appendChild(content);
  return wrap;
}

function scrollToBottom(){
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
}

// Basic sanitizer: remove common markdown delimiters and code fences so bot replies appear as plain text
function sanitizeAIText(raw){
  if(!raw) return '';
  // Remove fenced code blocks
  let s = raw.replace(/```[\s\S]*?```/g, '');
  // Remove inline backticks
  s = s.replace(/`+/g, '');
  // Remove asterisks, tildes and underscores often used for bold/italic/strike
  s = s.replace(/[\*_~]{1,3}/g, '');
  // Remove HTML tags
  s = s.replace(/<[^>]*>/g, '');
  // Decode basic HTML entities by using a DOM element (browser only)
  try{
    const txt = document.createElement('textarea');
    txt.innerHTML = s;
    s = txt.value;
  }catch(e){/* ignore */}
  // Normalize line endings and collapse multiple blank lines
  s = s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  // Trim each line and overall
  s = s.split('\n').map(l => l.trim()).join('\n');
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim();
}

// Typing reveal: reveal characters sequentially
function revealText(el, text, speed=18){
  el.textContent = '';
  let i = 0;
  return new Promise(resolve => {
    const t = setInterval(()=>{
      el.textContent += text.charAt(i);
      i++;
      scrollToBottom();
      if(i >= text.length){
        clearInterval(t);
        resolve();
      }
    }, speed);
  });
}

// Reveal by paragraphs: split on double newlines and reveal each paragraph
async function revealParagraphs(el, text, speed=18){
  el.textContent = '';
  const parts = String(text).split(/\n{2,}/).map(p=>p.trim()).filter(Boolean);
  for(const p of parts){
    await revealText(el, (el.textContent ? el.textContent + '\n\n' : '') + p, speed);
    // small pause between paragraphs
    await new Promise(r => setTimeout(r, 180));
  }
}

// sendMessageToGemini: accepts message (string) and optional opts object.
// opts: { mode: 'text'|'image', preset: 'balanced'|'fast'|'super_fast', rawBody: {...} }
async function sendMessageToGemini(message, opts = {}){
  try{
    const mode = opts.mode || 'text';
    const payload = opts.rawBody || (
      mode === 'image' ? { mode: 'image', prompt: message } : {
        // the API supports messages via `contents`
        contents: [ { role: 'user', parts: [{ text: message }] } ],
        // include model id and preset as metadata so proxy can route to the correct model
        metadata: { model: modelChoices[selectedModelIndex].id, preset: opts.preset || 'balanced' }
      }
    );

    const headers = { 'Content-Type': 'application/json' };
    if(!USE_PROXY){
      if(!CLIENT_API_KEY) throw new Error('CLIENT_API_KEY is not set. Set CLIENT_API_KEY to use direct browser calls.');
      headers['x-goog-api-key'] = CLIENT_API_KEY;
    }

    const resp = await fetch(MODEL_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const txt = await resp.text();
    if(!resp.ok){
      throw new Error(`HTTP ${resp.status} — ${txt}`);
    }

    // Try parse JSON, otherwise return raw text
    try{
      return JSON.parse(txt);
    }catch(e){
      return txt;
    }
  }catch(err){
    console.error('Gemini request error:', err);
    throw err;
  }
}

// Handle sending flow: add user message, show typing, call API, reveal sanitized text
form.addEventListener('submit', async (ev) =>{
  ev.preventDefault();
  const text = input.value.trim();
  if(!text) return;
  // Detect image command: start with "/image " or "image:"
  let isImage = false;
  let imagePrompt = null;
  if(text.toLowerCase().startsWith('/image ')){
    isImage = true;
    imagePrompt = text.slice(7).trim();
  } else if(text.toLowerCase().startsWith('image:')){
    isImage = true;
    imagePrompt = text.slice(6).trim();
  }

  // Add user bubble
  const userBubble = createBubble('user', text);
  messagesEl.appendChild(userBubble);
  // Save user message to history so subsequent requests include context
  addMessageToHistory('user', text);
  input.value = '';
  input.style.height = '';
  scrollToBottom();

  // Add bot typing bubble
  const botBubble = createBubble('bot', '', true);
  messagesEl.appendChild(botBubble);
  scrollToBottom();

    try{
  if(isImage){
      // Build payload including recent history so the model sees conversation context for image requests
      const hist = loadHistory();
      const contents = [];
      for(const m of hist){
        contents.push({ role: m.role === 'assistant' ? 'assistant' : 'user', parts: [{ text: m.text }] });
      }
      // Add current image prompt as the latest user message
      contents.push({ role: 'user', parts: [{ text: imagePrompt }] });

      // Call image generation via proxy (include preset as metadata)
      const raw = await sendMessageToGemini(null, { mode: 'image', prompt: imagePrompt, preset: selectedPreset, rawBody: { contents, metadata: { model: modelChoices[selectedModelIndex].id, preset: selectedPreset }, mode: 'image', prompt: imagePrompt } });
      const content = botBubble.querySelector('div');
      if(!raw){
        content.textContent = '⚠️ No response from Gemini (image).';
        return;
      }
      // Try to parse JSON response for image data (accept either already-parsed objects or JSON strings)
      let parsed;
      if(typeof raw === 'object'){
        parsed = raw;
      } else {
        try{ parsed = JSON.parse(raw); } catch(e){ parsed = null; }
      }

  // Try to find an image URL or base64 in the parsed response
      let shown = false;
      if(parsed){
        // Common shapes: { images: [{ url }] } or { data: [{ url }] } or { images: [{ b64 }]} etc.
        const findImages = (obj) => {
          const out = [];
          const walk = (o) => {
            if(!o || typeof o !== 'object') return;
            if(Array.isArray(o)) return o.forEach(walk);
            if(o.url && typeof o.url === 'string') out.push({ url: o.url });
            if(o.b64 || o.b64_json || o.b64_image) out.push({ b64: o.b64 || o.b64_json || o.b64_image });
            for(const k of Object.keys(o)) walk(o[k]);
          };
          walk(obj);
          return out;
        };

        const imgs = findImages(parsed);
        if(imgs.length){
          // Render the first image inline
          const first = imgs[0];
          const container = document.createElement('div');
          container.style.display = 'flex';
          container.style.flexDirection = 'column';
          container.style.gap = '8px';
          if(first.url){
            const img = document.createElement('img');
            img.src = first.url;
            img.alt = 'Generated image';
            img.style.maxWidth = '320px';
            img.style.borderRadius = '10px';
            container.appendChild(img);
            content.appendChild(container);
            shown = true;
          } else if(first.b64){
            const img = document.createElement('img');
            img.src = 'data:image/png;base64,' + first.b64;
            img.alt = 'Generated image';
            img.style.maxWidth = '320px';
            img.style.borderRadius = '10px';
            container.appendChild(img);
            content.appendChild(container);
            shown = true;
          }
        }
      }

      if(!shown){
        // fallback: show raw JSON text
        const textFallback = typeof raw === 'string' ? raw : JSON.stringify(raw);
        content.textContent = sanitizeAIText(textFallback);
      }

      // Save assistant response (image placeholder) to history
      addMessageToHistory('assistant', '[image]');

      scrollToBottom();
      return;
    } else {
      // Build payload including recent history so the model sees conversation context
      const hist = loadHistory();
      const contents = [];
      for(const m of hist){
        contents.push({ role: m.role === 'assistant' ? 'assistant' : 'user', parts: [{ text: m.text }] });
      }
      // Add current user message
      contents.push({ role: 'user', parts: [{ text }] });

      // Call Gemini for text (include selected preset)
      const raw = await sendMessageToGemini(null, { preset: selectedPreset, rawBody: { contents, metadata: { model: modelChoices[selectedModelIndex].id, preset: selectedPreset } } });
      if(!raw){
        const content = botBubble.querySelector('div');
        content.textContent = '⚠️ No response from Gemini.';
        return;
      }

      // Extract text if response is JSON-like
      let aiText = null;
      if(typeof raw === 'string'){
        aiText = raw;
      } else if(typeof raw === 'object'){
        aiText = raw?.candidates?.[0]?.content?.parts?.[0]?.text || raw?.candidates?.[0]?.content?.text || raw?.output?.[0]?.content || JSON.stringify(raw);
      } else {
        aiText = String(raw);
      }

  const clean = sanitizeAIText(aiText);
      const content = botBubble.querySelector('div');
      // Reveal text organized into paragraphs
      // control reveal speed by model tier: higher-tier models reveal a bit slower for readability
      const speed = (selectedModelIndex === 0) ? 18 : (selectedModelIndex === 1) ? 14 : (selectedModelIndex === 2) ? 12 : 10;
      await revealParagraphs(content, clean, speed);

      // Save assistant reply to history
      addMessageToHistory('assistant', clean);
    }
  }catch(err){
    const content = botBubble.querySelector('div');
    // Provide a specific message for HTTP 405 which commonly means the host
    // (for example a static Live Server) does not support serverless functions
    // at `/api/*`. Offer actionable fixes.
    // Detect rate-limit / quota errors and show actionable modal
    const msg = err && err.message ? err.message : '';
    if(msg.includes('HTTP 429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota')){
      // Auto-fallback to the next lower-tier model if available, then retry once.
      const current = selectedModelIndex;
      const next = Math.min(modelChoices.length - 1, current + 1);
      if(next !== current){
        const fromAlias = modelChoices[current].alias;
        const toAlias = modelChoices[next].alias;
  // switch silently to the lower-tier model
  selectedModelIndex = next;
        content.textContent = `⚠️ Model "${fromAlias}" hit its limit. Switched to ${toAlias} and retrying...`;
        // auto-retry once after a short delay
        setTimeout(()=> form.requestSubmit(), 700);
      } else {
        // no lower model available
        showLimitModal('All available model tiers have reached their limits. Please try again later.', ()=>{});
        content.textContent = '⚠️ Rate limit reached. No lower-tier model available.';
      }
    } else {
      let uiMsg = '⚠️ Connection error. Try again.';
      if (err && err.message) {
        if (err.message.includes('HTTP 405')) {
          uiMsg = '⚠️ Server returned 405 — your current host (live/static server) does not run serverless functions at `/api/*`.\n\nFixes: run `vercel dev` locally, deploy to Vercel, or for quick local testing set `USE_PROXY = false` and `CLIENT_API_KEY` in `script.js` (unsafe, not for production).';
        } else if (DEBUG_SHOW_ERRORS) {
          uiMsg = `⚠️ Connection error: ${err.message}`;
        }
      }
      content.textContent = uiMsg;
    }
  }finally{
    scrollToBottom();
  }
});

// Resize textarea to content
input.addEventListener('input', () =>{
  input.style.height = 'auto';
  input.style.height = (input.scrollHeight) + 'px';
});

// Send message on Enter, allow Shift+Enter for newline
input.addEventListener('keydown', (e) =>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    form.requestSubmit();
  }
});

// New chat resets conversation
newChatBtn.addEventListener('click', ()=>{
  messagesEl.innerHTML = '';
  input.value = '';
  input.focus();
  // Clear stored conversation history
  clearHistory();
});

// Modal helpers
const aboutBtn = document.getElementById('aboutBtn');
const aboutModal = document.getElementById('aboutModal');
const aboutClose = document.getElementById('aboutClose');
const limitModal = document.getElementById('limitModal');
const limitTitle = document.getElementById('limitTitle');
const limitMsg = document.getElementById('limitMsg');
const limitCancel = document.getElementById('limitCancel');
const limitSwitch = document.getElementById('limitSwitch');

function showAbout(){
  if(aboutModal) aboutModal.setAttribute('aria-hidden','false');
}
function hideAbout(){
  if(aboutModal) aboutModal.setAttribute('aria-hidden','true');
}
function showLimitModal(message, onSwitch){
  if(limitModal){
    limitModal.setAttribute('aria-hidden','false');
    limitMsg.textContent = message;
    // attach handlers once
    limitCancel.onclick = ()=>{ limitModal.setAttribute('aria-hidden','true'); };
    limitSwitch.onclick = ()=>{ limitModal.setAttribute('aria-hidden','true'); if(onSwitch) onSwitch(); };
  }
}

if(aboutBtn) aboutBtn.addEventListener('click', showAbout);
if(aboutClose) aboutClose.addEventListener('click', hideAbout);


// Small welcome example message
// Removed the automatic welcome message to avoid starting the chat with a prefilled bot bubble.
