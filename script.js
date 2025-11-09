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

// (Previously had a flag to suppress duplicate user bubbles on automatic
// retries. We now allow retries to add bubbles so users can see/resend.)

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

// Persist conversation history in localStorage. Implement simple helpers
// with caps for number of messages and total characters. Use try/catch to
// gracefully degrade when localStorage isn't available.
function loadHistory(){
  try{
    const raw = localStorage.getItem(HISTORY_KEY);
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    if(!Array.isArray(parsed)) return [];
    // Ensure it's trimmed to the most recent messages and legal shape
    const trimmed = parsed.slice(-HISTORY_MAX_MESSAGES).map(m => ({ role: m.role, text: String(m.text || '') }));
    return trimmed;
  }catch(e){
    // localStorage unavailable or corrupted data
    return [];
  }
}

function saveHistory(hist){
  try{
    if(!Array.isArray(hist)) return;
    // Trim to max messages first
    let out = hist.slice(-HISTORY_MAX_MESSAGES);
    // Enforce max characters: drop oldest messages until under limit
    let total = out.reduce((s,m)=> s + (m.text ? m.text.length : 0), 0);
    while(out.length > 1 && total > HISTORY_MAX_CHARS){
      const removed = out.shift();
      total -= (removed && removed.text) ? removed.text.length : 0;
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(out));
  }catch(e){ /* ignore storage errors */ }
}

function addMessageToHistory(role, text){
  try{
    if(!role || typeof text === 'undefined' || text === null) return;
    const cur = loadHistory();
    cur.push({ role: role === 'assistant' ? 'assistant' : 'user', text: String(text) });
    saveHistory(cur);
  }catch(e){ /* ignore */ }
}

function clearHistory(){ try{ localStorage.removeItem(HISTORY_KEY); }catch(e){} }

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

// Handle sending flow: use internal cascading retries with a single user bubble
// and a single assistant bubble. Show a short toast when automatic transfers
// occur so the user isn't surprised. This keeps the transcript clean.
// lightweight transient toast used when automatic transfer happens
function showToast(msg, ms = 2000){
  try{
    const t = document.createElement('div');
    t.className = 'celebra-toast';
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed',
      right: '16px',
      bottom: '20px',
      padding: '8px 12px',
      background: 'rgba(0,0,0,0.78)',
      color: '#fff',
      borderRadius: '8px',
      zIndex: 99999,
      fontSize: '13px',
      opacity: '1',
      transition: 'opacity 220ms ease'
    });
    document.body.appendChild(t);
    setTimeout(()=>{ t.style.opacity = '0'; setTimeout(()=>{ try{ t.remove(); }catch(_){/*ignore*/} }, 260); }, ms);
  }catch(e){/* ignore */}
}

form.addEventListener('submit', async (ev) =>{
  ev.preventDefault();
  const text = input.value.trim();
  if(!text) return;

  // single user bubble for this submit
  const userBubble = createBubble('user', text);
  messagesEl.appendChild(userBubble);
  addMessageToHistory('user', text);
  input.value = '';
  input.style.height = '';
  scrollToBottom();

  // single bot bubble we will update for retries / success / final error
  const botBubble = createBubble('bot', '', true);
  messagesEl.appendChild(botBubble);
  scrollToBottom();

  // Build base contents from history + this user message
  const baseHist = loadHistory();
  const baseContents = [];
  for(const m of baseHist){
    baseContents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] });
  }
  baseContents.push({ role: 'user', parts: [{ text }] });

  // Attempt models starting at selectedModelIndex and cascading down
  const attempted = new Set();
  let attemptIndex = selectedModelIndex;
  let succeeded = false;

  try{
    if(sendBtn) sendBtn.classList.add('sending');

    // Abort any previous request
    if(currentAbortController){ try{ currentAbortController.abort(); }catch(_){/*ignore*/} currentAbortController = null; }

    // Loop until success or no models left
    while(true){
      attempted.add(attemptIndex);
      // update visible selection if we switched
      if(attemptIndex !== selectedModelIndex){
        selectedModelIndex = attemptIndex;
        try{ updateModelBadge(); }catch(_){/* ignore */}
      }

      // new abort controller for this attempt
      const controller = new AbortController();
      currentAbortController = controller;

      // rawBody for this attempt (explicit model id)
      const rawBody = { contents: baseContents, metadata: { model: modelChoices[attemptIndex].id, preset: selectedPreset } };

      try{
        const raw = await sendMessageToGemini(null, { rawBody, preset: selectedPreset, signal: controller.signal });
        if(!raw) throw new Error('No response from model');

        let aiText = extractTextFromResponse(raw);
        // extra fallback join of candidate parts if needed
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
            }catch(e){/* ignore malformed */}
          }
          if(parts.length) aiText = parts.join('\n\n');
        }

        const clean = sanitizeAIText(aiText);
        const contentEl = botBubble.querySelector('div');
        const speed = (attemptIndex === 0) ? 18 : (attemptIndex === 1) ? 14 : (attemptIndex === 2) ? 12 : 10;
        await revealParagraphs(contentEl, clean, speed);

        // Save assistant reply and finish
        addMessageToHistory('assistant', clean);
        succeeded = true;
        break;
      }catch(err){
        const msg = err && err.message ? String(err.message) : '';

        // aborted by user
        if(err && (err.name === 'AbortError' || msg.toLowerCase().includes('abort'))){
          botBubble.querySelector('div').textContent = '⚠️ Generation stopped.';
          currentAbortController = null;
          break;
        }

        // detect rate-limit / overload patterns -> cascade
        const isLimit = msg.includes('HTTP 429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota')
          || msg.toLowerCase().includes('resource_exhausted') || msg.toLowerCase().includes('resource exhausted')
          || msg.toLowerCase().includes('overload') || msg.toLowerCase().includes('overloaded');

        if(isLimit){
          // find next lower-tier model index that hasn't been attempted
          let found = -1;
          for(let cand = attemptIndex + 1; cand < modelChoices.length; cand++){
            if(!attempted.has(cand)){ found = cand; break; }
          }
          if(found >= 0){
            // notify user briefly and retry internally
            try{ showToast(`Switched to ${modelChoices[found].alias}`); }catch(_){/*ignore*/}
            attemptIndex = found;
            // small delay before retry to avoid immediate hammering
            await new Promise(r => setTimeout(r, 600));
            continue;
          } else {
            // no lower models left
            botBubble.querySelector('div').textContent = '⚠️ All available model tiers have failed. Please try again later or select a different model.';
            showLimitModal('All available model tiers have reached their limits. Please try again later or choose a different model.', ()=>{});
            break;
          }
        } else {
          // other errors -> show single in-chat message (respect DEBUG_SHOW_ERRORS)
          let uiMsg = '⚠️ Connection error. Try again.';
          if (err && err.message){
            if (err.message.includes('HTTP 405')){
              uiMsg = '⚠️ Server returned 405 — your host does not run serverless functions at `/api/*`.';
            } else if (DEBUG_SHOW_ERRORS){
              uiMsg = `⚠️ Connection error: ${err.message}`;
            }
          }
          botBubble.querySelector('div').textContent = uiMsg;
          break;
        }
      }finally{
        currentAbortController = null;
        scrollToBottom();
      }
    }
  }catch(e){
    try{ botBubble.querySelector('div').textContent = '⚠️ Unexpected error. Try again.'; }catch(_){/*ignore*/}
  }finally{
    if(sendBtn) sendBtn.classList.remove('sending');
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
  try{
    if(modelBadgeEl) modelBadgeEl.textContent = modelChoices[selectedModelIndex].alias;
  }catch(_){/* ignore */}
  try{
    if(modelSelectEl){
      // Prefer setting value; also ensure the selectedIndex is accurate for
      // non-standard select implementations.
      modelSelectEl.value = modelChoices[selectedModelIndex].id;
      // If setting value didn't update (older browsers/custom widgets), set selectedIndex
      const opts = Array.from(modelSelectEl.options || []);
      const idx = opts.findIndex(o => o.value === modelChoices[selectedModelIndex].id);
      if(idx >= 0) modelSelectEl.selectedIndex = idx;
    }
  }catch(_){/* ignore */}
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
    if(idx === selectedModelIndex) btn.classList.add('active');
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

// Replay saved conversation history (if any) so the last chat appears on load
try{
  const hist = loadHistory();
  if(Array.isArray(hist) && hist.length){
    for(const m of hist){
      try{
        const role = (m.role === 'assistant') ? 'assistant' : 'user';
        const bubble = createBubble(role, m.text || '');
        messagesEl.appendChild(bubble);
      }catch(_){/* ignore malformed message */}
    }
    scrollToBottom();
  }
}catch(e){/* ignore replay errors */}


// Small welcome example message
// Removed the automatic welcome message to avoid starting the chat with a prefilled bot bubble.
