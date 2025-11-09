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

// Image generation model choice: use Gemini 2.0 Flash Preview for image generation
// Image generation removed from client

// --- Helpers and DOM refs
const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const newChatBtn = document.getElementById('newChatBtn');
const sendBtn = document.getElementById('sendBtn');
const presetsEl = document.querySelectorAll('.chip');

// Controller for the in-flight request so we can cancel generation
let currentAbortController = null;

// preserve a simple preset setting for response style (kept as a hidden internal option)
let selectedPreset = 'balanced';

// Model choices: full Gemini options per user request
const modelChoices = [
  { id: 'gemini-2.5-pro', alias: '2.5 Pro' },
  { id: 'gemini-2.5-flash', alias: '2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', alias: '2.5 Flash-Lite' },
  { id: 'gemini-2.0-flash', alias: '2.0 Flash' },
  { id: 'gemini-2.0-flash-lite', alias: '2.0 Flash-Lite' }
];

// selectedModelIndex indicates which model from modelChoices is active (0 = highest tier)
// default to gemini-2.5-flash-lite — keep the previous default behaviour (index 2)
let selectedModelIndex = 2;

// Conversation history settings
const HISTORY_KEY = 'celebra_conversation_history_v1';
const HISTORY_MAX_MESSAGES = 16; // keep last N messages (user+assistant)
const HISTORY_MAX_CHARS = 8000; // also cap by characters
// Conversation history is disabled. To remove localStorage usage we
// implement the history helpers as no-ops and clear any existing key.
function loadHistory(){ return []; }
function saveHistory(){ /* no-op */ }
function addMessageToHistory(){ /* no-op */ }
function clearHistory(){ try{ localStorage.removeItem(HISTORY_KEY); }catch(e){} }

// Clear any pre-existing stored history on load (best-effort)
try{ localStorage.removeItem(HISTORY_KEY); }catch(e){}

// Compose actions: plus button and quick actions menu (image UI removed)
// Model selector element (populated dynamically)
const modelSelectEl = document.getElementById('modelSelect');
const modelBadgeEl = document.getElementById('modelBadge');
const modelModalEl = document.getElementById('modelModal');
const modelListEl = document.getElementById('modelList');
const modelModalClose = document.getElementById('modelModalClose');

// Toggle menu visibility
// removed image UI and quick actions

// Generate image action: prefix input with '/image ' and focus it
// image quick-action removed
// (no image model)

// Focus input on load
input.focus();

// NOTE: the long assistant persona was removed from outgoing messages to
// avoid the model echoing the persona text back as a reply. If you want
// to reintroduce a guiding system message, use a short, focused instruction
// or configure it server-side in the proxy.

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

    const fetchOpts = {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    };
    // Support aborting from the caller
    if(opts.signal) fetchOpts.signal = opts.signal;

    const resp = await fetch(MODEL_ENDPOINT, fetchOpts);

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

// Robust extractor: normalize different Gemini response shapes and return
// the best plaintext reply (or null). Handles candidates[].content.parts[],
// candidates[].content.text, output arrays, and falls back to a shallow
// walk for the first `text` property found.
function extractTextFromResponse(raw){
  if(!raw) return null;
  if(typeof raw === 'string') return raw;

  try{
    // New-style candidates with content.parts
    if(Array.isArray(raw.candidates) && raw.candidates.length){
      const cand = raw.candidates[0];
      if(cand && cand.content){
        if(Array.isArray(cand.content.parts) && cand.content.parts.length && cand.content.parts[0].text) return String(cand.content.parts[0].text);
        if(typeof cand.content.text === 'string') return cand.content.text;
      }
      if(typeof cand.text === 'string') return cand.text;
    }

    // Older output shape
    if(Array.isArray(raw.output) && raw.output.length){
      const out = raw.output[0];
      if(out){
        if(typeof out.content === 'string') return out.content;
        if(Array.isArray(out.content) && out.content.length && out.content[0].text) return out.content[0].text;
      }
    }

    // Common nested shapes
    if(raw?.candidates?.[0]?.content?.parts?.[0]?.text) return raw.candidates[0].content.parts[0].text;

    // Generic walker: find the first non-empty 'text' property
    const seen = new Set();
    function walk(o){
      if(!o || typeof o !== 'object' || seen.has(o)) return null;
      seen.add(o);
      if(typeof o.text === 'string' && o.text.trim()) return o.text;
      if(typeof o.content === 'string' && o.content.trim()) return o.content;
      if(Array.isArray(o)){
        for(const it of o){
          const r = walk(it);
          if(r) return r;
        }
      } else {
        for(const k of Object.keys(o)){
          const r = walk(o[k]);
          if(r) return r;
        }
      }
      return null;
    }
    const found = walk(raw);
    if(found) return found;
  }catch(e){ /* ignore and fallback */ }

  // Last resort: stringify
  try{ return JSON.stringify(raw); }catch(e){ return String(raw); }
}

// Organize plain text into a clean numbered structure.
// Strategy:
// - Split into paragraphs. Each paragraph becomes a top-level numbered item.
// - If a paragraph contains multiple sentences, the first sentence becomes the
//   top-level line and the remaining sentences become 1.1, 1.2... subpoints.
// - Preserve existing numbering if the text already appears structured.
function organizeTextIntoNumberedSections(text){
  if(!text) return '';
  // If the text already contains lines that start with a digit + punctuation,
  // assume it's already organized and return as-is.
  const lines = String(text).split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const looksOrganized = lines.some(l => /^\d+\s*[\.)\-]/.test(l) || /^\d+\.\d+/.test(l));
  if(looksOrganized) return text;

  const paragraphs = String(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = [];
  for(let i=0;i<paragraphs.length;i++){
    const p = paragraphs[i];
    // Split into sentences using a simple heuristic (period/question/exclaim + space)
    const sentences = p.match(/[^.!?]+[.!?]?/g) || [p];
    const top = sentences[0] ? sentences[0].trim() : p;
    out.push(`${i+1}. ${top}`);
    if(sentences.length > 1){
      for(let j=1;j<sentences.length;j++){
        const s = sentences[j].trim();
        if(!s) continue;
        out.push(`${i+1}.${j} ${s}`);
      }
    }
    // add a blank line between top-level sections for readability
    out.push('');
  }
  return out.join('\n').trim();
}

// Handle sending flow: add user message, show typing, call API, reveal sanitized text
form.addEventListener('submit', async (ev) =>{
  ev.preventDefault();
  const text = input.value.trim();
  if(!text) return;

  // Add user bubble
  const userBubble = createBubble('user', text);
  messagesEl.appendChild(userBubble);
  addMessageToHistory('user', text);
  input.value = '';
  input.style.height = '';
  scrollToBottom();

  // Add bot typing bubble
  const botBubble = createBubble('bot', '', true);
  messagesEl.appendChild(botBubble);
  scrollToBottom();

  try{
  // indicate sending state on the send button like ChatGPT
  if(sendBtn) sendBtn.classList.add('sending');
  // create an AbortController so the generation can be cancelled
  try{
    // If a previous generation is still running, abort it before starting a new one
    if(currentAbortController){
      try{ currentAbortController.abort(); }catch(_){/* ignore */}
      currentAbortController = null;
    }
  }catch(e){/* ignore */}
  const controller = new AbortController();
  currentAbortController = controller;
    // Build payload including recent history so the model sees conversation context
    const hist = loadHistory();
      const contents = [];
      // NOTE: system persona injection removed to avoid the model echoing the
      // persona text back as a normal assistant reply.
    for(const m of hist){
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] });
    }
    contents.push({ role: 'user', parts: [{ text }] });

  const raw = await sendMessageToGemini(null, { preset: selectedPreset, rawBody: { contents, metadata: { model: modelChoices[selectedModelIndex].id, preset: selectedPreset } }, signal: controller.signal });
    if(!raw){
      const content = botBubble.querySelector('div');
      content.textContent = '⚠️ No response from Gemini.';
      return;
    }

    // Extract text using a robust helper that handles multiple Gemini shapes
    let aiText = extractTextFromResponse(raw);

      // Fallback: if extractor found nothing but `candidates` exists, join any
      // candidate content.parts text fields (covers some variant shapes).
      if(!aiText && raw && Array.isArray(raw.candidates) && raw.candidates.length){
        const parts = [];
        for(const c of raw.candidates){
          try{
            if(c && c.content){
              if(Array.isArray(c.content.parts)){
                for(const p of c.content.parts){ if(p && p.text) parts.push(String(p.text)); }
              } else if(typeof c.content.text === 'string'){
                parts.push(c.content.text);
              }
            }
          }catch(e){/* ignore malformed candidate */}
        }
        if(parts.length) aiText = parts.join('\n\n');
      }

      if(!aiText && DEBUG_SHOW_ERRORS){
        console.warn('No textual reply extracted from Gemini response; showing raw JSON. Response object:', raw);
      }

  const clean = sanitizeAIText(aiText);
  // Organize the AI reply into numbered sections for clearer output
  const organized = organizeTextIntoNumberedSections(clean);
  const content = botBubble.querySelector('div');
      // Reveal text organized into paragraphs
      // control reveal speed by model tier: higher-tier models reveal a bit slower for readability
      const speed = (selectedModelIndex === 0) ? 18 : (selectedModelIndex === 1) ? 14 : (selectedModelIndex === 2) ? 12 : 10;
      await revealParagraphs(content, clean, speed);

      // After the assistant finished revealing, enter a focused full-browser view
      // so the AI reply fills the browser for easier reading. Clicking the reply
      // dismisses the focused view. This is reversible and non-destructive.
      try{
        // small delay so layout/scroll settles
        setTimeout(()=>{
          try{
            document.body.classList.add('focused');
            const removeFocus = (e)=>{
              document.body.classList.remove('focused');
              botBubble.removeEventListener('click', removeFocus);
            };
            // dismiss when the user clicks/taps the expanded reply
            botBubble.addEventListener('click', removeFocus);
          }catch(_){/* ignore environment issues */}
        }, 120);
      }catch(e){/* ignore if DOM not available */}

  // After reveal, add a small copy button to the assistant bubble
  try{
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-btn';
    copyBtn.title = 'Copy reply';
    copyBtn.textContent = 'Copy';
    actions.appendChild(copyBtn);
    botBubble.appendChild(actions);

    copyBtn.addEventListener('click', async ()=>{
      try{
        await navigator.clipboard.writeText(clean || '');
        copyBtn.textContent = 'Copied';
        setTimeout(()=>{ copyBtn.textContent = 'Copy'; }, 1500);
      }catch(e){
        const ta = document.createElement('textarea');
        ta.value = clean || '';
        document.body.appendChild(ta);
        ta.select();
        try{ document.execCommand('copy'); copyBtn.textContent = 'Copied'; }catch(err){ copyBtn.textContent = 'Copy'; }
        document.body.removeChild(ta);
        setTimeout(()=>{ copyBtn.textContent = 'Copy'; }, 1500);
      }
    });
  }catch(e){/* ignore if clipboard not available */}

  // Save assistant reply to history (store the cleaned plain text)
  addMessageToHistory('assistant', clean);
  }catch(err){
    const content = botBubble.querySelector('div');
    // Provide a specific message for HTTP 405 which commonly means the host
    // (for example a static Live Server) does not support serverless functions
    // at `/api/*`. Offer actionable fixes.
    // Detect rate-limit / quota errors and show actionable modal
    const msg = err && err.message ? err.message : '';
    // Aborted by user
    if(err && (err.name === 'AbortError' || msg.toLowerCase().includes('abort'))){
      content.textContent = '⚠️ Generation stopped.';
      // clear controller
      currentAbortController = null;
      return;
    }
    // Detect common rate-limit / quota / overload patterns from proxied errors
    if(msg.includes('HTTP 429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('resource_exhausted') || msg.toLowerCase().includes('resource exhausted') || msg.toLowerCase().includes('overload') || msg.toLowerCase().includes('overloaded')){
      // Auto-fallback to the next lower-tier model if available, then retry once.
      const current = selectedModelIndex;
      const next = Math.min(modelChoices.length - 1, current + 1);
      if(next !== current){
        const fromAlias = modelChoices[current].alias;
        const toAlias = modelChoices[next].alias;
        // switch to the lower-tier model and update the UI badge/select
        selectedModelIndex = next;
        try{ updateModelBadge(); }catch(_){/* ignore */}
        // Inform the user clearly about the transfer
        content.textContent = `⚠️ "${fromAlias}" is overloaded or reached its limit. You've been transferred to "${toAlias}" and we'll retry now.`;
        // Avoid infinite retry loops: only retry once per assistant bubble
        try{
          if(!botBubble.dataset.retried){
            botBubble.dataset.retried = '1';
            // restore the user's input text so form.requestSubmit will resend it
            try{ input.value = text; }catch(_){/* ignore */}
            // auto-retry once after a short delay
            setTimeout(()=>{
              try{ scrollToBottom(); form.requestSubmit(); }catch(_){/* ignore */}
            }, 700);
          } else {
            content.textContent = `⚠️ "${fromAlias}" hit its limit and fallback to "${toAlias}" already attempted. Please try again or select a different model.`;
          }
        }catch(e){ /* ignore retry errors */ }
      } else {
        // no lower model available
        showLimitModal('All available model tiers have reached their limits. Please try again later or choose a different model.', ()=>{});
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
    // remove sending indicator
    if(sendBtn) sendBtn.classList.remove('sending');
    // clear any controller reference after finalizing
    currentAbortController = null;
    scrollToBottom();
  }
});

// Clicking the send button while a generation is in progress should cancel it.
if(sendBtn){
  sendBtn.addEventListener('click', (e)=>{
    // if currently sending, abort instead of submitting
    if(sendBtn.classList.contains('sending')){
      e.preventDefault();
      if(currentAbortController){
        try{ currentAbortController.abort(); }catch(_){/* ignore */}
        currentAbortController = null;
      }
      // update UI state immediately so spinner/states reflect the cancellation
      try{ sendBtn.classList.remove('sending'); }catch(_){/* ignore */}
    }
  });
}

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


// Populate model select dropdown and wire selection
try{
  if(modelSelectEl){
    modelChoices.forEach((m, idx) => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.alias;
      if(idx === selectedModelIndex) opt.selected = true;
      modelSelectEl.appendChild(opt);
    });
    modelSelectEl.addEventListener('change', ()=>{
      const id = modelSelectEl.value;
      const idx = modelChoices.findIndex(c => c.id === id);
      if(idx >= 0) selectedModelIndex = idx;
    });
  }
}catch(e){/* ignore DOM quirks */}

// Initialize compact badge and mobile modal
function updateModelBadge(){
  if(modelBadgeEl) modelBadgeEl.textContent = modelChoices[selectedModelIndex].alias;
  if(modelSelectEl) modelSelectEl.value = modelChoices[selectedModelIndex].id;
}

function showModelModal(){
  if(!modelModalEl || !modelListEl) return;
  modelModalEl.setAttribute('aria-hidden','false');
  modelListEl.innerHTML = '';
  modelChoices.forEach((m, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.style.textAlign = 'left';
    btn.style.width = '100%';
    btn.textContent = m.alias;
    btn.addEventListener('click', ()=>{
      selectedModelIndex = idx;
      updateModelBadge();
      modelModalEl.setAttribute('aria-hidden','true');
    });
    modelListEl.appendChild(btn);
  });
}

function hideModelModal(){ if(modelModalEl) modelModalEl.setAttribute('aria-hidden','true'); }

if(modelBadgeEl){ modelBadgeEl.addEventListener('click', showModelModal); }
if(modelModalClose){ modelModalClose.addEventListener('click', hideModelModal); }
updateModelBadge();


// Small welcome example message
// Removed the automatic welcome message to avoid starting the chat with a prefilled bot bubble.
