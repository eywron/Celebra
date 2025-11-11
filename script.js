const USE_PROXY = true;
const CLIENT_API_KEY = null;
const DEBUG_SHOW_ERRORS = true;
const PROXY_ENDPOINT = '/api/gemini';
const MODEL_ENDPOINT = USE_PROXY ? PROXY_ENDPOINT : 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const newChatBtn = document.getElementById('newChatBtn');
const sendBtn = document.getElementById('sendBtn');
const presetsEl = document.querySelectorAll('.chip');

let currentAbortController = null;

let selectedPreset = 'balanced';

const modelChoices = [
  { id: 'gemini-2.5-pro', alias: '2.5 Pro' },
  { id: 'gemini-2.5-flash', alias: '2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', alias: '2.5 Flash-Lite' },
  { id: 'gemini-2.0-flash', alias: '2.0 Flash' },
  { id: 'gemini-2.0-flash-lite', alias: '2.0 Flash-Lite' }
];

let selectedModelIndex = 2;

const HISTORY_KEY = 'celebra_conversation_history_v1';
const HISTORY_MAX_MESSAGES = 16;
const HISTORY_MAX_CHARS = 8000;
let _updateMessagesPaddingTimer = null;
let _lastAllowedHeight = null;
let _lastCompTop = null;

function loadHistory(){
  try{
    const raw = localStorage.getItem(HISTORY_KEY);
    if(!raw) return [];
    const parsed = JSON.parse(raw);
    if(!Array.isArray(parsed)) return [];
    const trimmed = parsed.slice(-HISTORY_MAX_MESSAGES).map(m => ({ role: m.role, text: String(m.text || '') }));
    return trimmed;
  }catch(e){
    return [];
  }
}

function saveHistory(hist){
  try{
    if(!Array.isArray(hist)) return;
    let out = hist.slice(-HISTORY_MAX_MESSAGES);
    let total = out.reduce((s,m)=> s + (m.text ? m.text.length : 0), 0);
    while(out.length > 1 && total > HISTORY_MAX_CHARS){
      const removed = out.shift();
      total -= (removed && removed.text) ? removed.text.length : 0;
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(out));
  }catch(e){}
}

function addMessageToHistory(role, text){
  try{
    if(!role || typeof text === 'undefined' || text === null) return;
    const cur = loadHistory();
    cur.push({ role: role === 'assistant' ? 'assistant' : 'user', text: String(text) });
    saveHistory(cur);
  }catch(e){}
}

function clearHistory(){ try{ localStorage.removeItem(HISTORY_KEY); }catch(e){} }

const modelSelectEl = document.getElementById('modelSelect');
const modelBadgeEl = document.getElementById('modelBadge');
const modelModalEl = document.getElementById('modelModal');
const modelListEl = document.getElementById('modelList');
const modelModalClose = document.getElementById('modelModalClose');

input.focus();

function createBubble(role, text, isTyping=false){
  const wrap = document.createElement('div');
  wrap.className = 'bubble ' + (role === 'user' ? 'user' : 'bot');
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
  try{
    const composerEl = document.getElementById('composer');
    let extra = 0;
    if (composerEl && window.matchMedia && window.matchMedia('(max-width:520px)').matches) {
      try{ extra = composerEl.getBoundingClientRect().height || 0; }catch(_){ extra = 0; }
    }
    const target = Math.max(0, messagesEl.scrollHeight - messagesEl.clientHeight + extra);
    messagesEl.scrollTo({ top: target, behavior: 'smooth' });
  }catch(e){ try{ messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' }); }catch(_){ } }
}

function ensureVisible(elem){
  try{
    if(!elem) return;
    const composerEl = document.getElementById('composer');
    const compHeight = (composerEl && window.matchMedia && window.matchMedia('(max-width:520px)').matches) ? (composerEl.getBoundingClientRect().height || 0) : 0;
    const safe = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-bottom')) || 0;
    const margin = 12 + (safe || 0);
    const allowedBottom = window.innerHeight - compHeight - margin;
    const rect = elem.getBoundingClientRect();
    const delta = rect.bottom - allowedBottom;
    if(delta > 0 && messagesEl){
      try{
        messagesEl.scrollTo({ top: Math.max(0, messagesEl.scrollTop + delta + 8), behavior: 'smooth' });
      }catch(e){ messagesEl.scrollTop = Math.max(0, messagesEl.scrollTop + delta + 8); }
    }
  }catch(e){}
}

function updateMessagesPadding(){
  try{
    const composerEl = document.getElementById('composer');
    if(!messagesEl || !composerEl) return;
    if(window.matchMedia && window.matchMedia('(max-width:520px)').matches){
      const compRect = composerEl.getBoundingClientRect();
      const compHeight = Math.max(0, Math.round(compRect.height || 0));
  const extra = 20;
      messagesEl.style.paddingBottom = `${compHeight + extra}px`;
      messagesEl.style.scrollPaddingBottom = `${compHeight + extra}px`;
       try{
         const messagesRect = messagesEl.getBoundingClientRect();
         const allowedHeight = Math.max(0, Math.floor(compRect.top - messagesRect.top - 8));
         const compTop = Math.floor(compRect.top || 0);
         const prev = _lastAllowedHeight || 0;
         const prevTop = _lastCompTop || 0;
         const changed = Math.abs(allowedHeight - prev);
         const topChanged = Math.abs(compTop - prevTop);
         if(_lastAllowedHeight === null || changed > 40 || topChanged > 40){
           messagesEl.style.maxHeight = `${allowedHeight}px`;
           _lastAllowedHeight = allowedHeight;
           _lastCompTop = compTop;
         }
         messagesEl.style.overflowY = 'auto';
       }catch(e){}
    } else {
      messagesEl.style.paddingBottom = '';
      messagesEl.style.scrollPaddingBottom = '';
       messagesEl.style.maxHeight = '';
       messagesEl.style.overflowY = '';
    }
  }catch(e){}
}

try{
  function scheduleUpdateMessagesPadding(){
    try{ if(_updateMessagesPaddingTimer) clearTimeout(_updateMessagesPaddingTimer); }catch(e){}
    _updateMessagesPaddingTimer = setTimeout(()=>{ try{ updateMessagesPadding(); }catch(e){} }, 180);
  }
  window.addEventListener('resize', scheduleUpdateMessagesPadding);
  if(window.visualViewport){
    window.visualViewport.addEventListener('resize', scheduleUpdateMessagesPadding);
    window.visualViewport.addEventListener('scroll', scheduleUpdateMessagesPadding);
  }
  if(input){ input.addEventListener('input', scheduleUpdateMessagesPadding); }
  try{ updateMessagesPadding(); }catch(e){}
}catch(e){}

function sanitizeAIText(raw){
  if(!raw) return '';
  let s = raw.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/`+/g, '');
  s = s.replace(/[\*_~]{1,3}/g, '');
  s = s.replace(/<[^>]*>/g, '');
  try{
    const txt = document.createElement('textarea');
    txt.innerHTML = s;
    s = txt.value;
  }catch(e){}
  s = s.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  s = s.split('\n').map(l => l.trim()).join('\n');
  s = s.replace(/\s{2,}/g, ' ');
  return s.trim();
}

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

async function revealParagraphs(el, text, speed=18){
  el.textContent = '';
  const parts = String(text).split(/\n{2,}/).map(p=>p.trim()).filter(Boolean);
  for(const p of parts){
    await revealText(el, (el.textContent ? el.textContent + '\n\n' : '') + p, speed);
    await new Promise(r => setTimeout(r, 180));
  }
}

async function sendMessageToGemini(message, opts = {}){
  try{
    const mode = opts.mode || 'text';
    const payload = opts.rawBody || (
      mode === 'image' ? { mode: 'image', prompt: message } : {
        contents: [ { role: 'user', parts: [{ text: message }] } ],
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
    if(opts.signal) fetchOpts.signal = opts.signal;

    const resp = await fetch(MODEL_ENDPOINT, fetchOpts);
    const txt = await resp.text();
    if(!resp.ok){
      throw new Error(`HTTP ${resp.status} — ${txt}`);
    }
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

function extractTextFromResponse(raw){
  if(!raw) return null;
  if(typeof raw === 'string') return raw;
  try{
    if(Array.isArray(raw.candidates) && raw.candidates.length){
      const cand = raw.candidates[0];
      if(cand && cand.content){
        if(Array.isArray(cand.content.parts) && cand.content.parts.length && cand.content.parts[0].text) return String(cand.content.parts[0].text);
        if(typeof cand.content.text === 'string') return cand.content.text;
      }
      if(typeof cand.text === 'string') return cand.text;
    }
    if(Array.isArray(raw.output) && raw.output.length){
      const out = raw.output[0];
      if(out){
        if(typeof out.content === 'string') return out.content;
        if(Array.isArray(out.content) && out.content.length && out.content[0].text) return out.content[0].text;
      }
    }
    if(raw?.candidates?.[0]?.content?.parts?.[0]?.text) return raw.candidates[0].content.parts[0].text;
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
  }catch(e){}
  try{ return JSON.stringify(raw); }catch(e){ return String(raw); }
}

function organizeTextIntoNumberedSections(text){
  if(!text) return '';
  const lines = String(text).split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  const looksOrganized = lines.some(l => /^\d+\s*[\.)\-]/.test(l) || /^\d+\.\d+/.test(l));
  if(looksOrganized) return text;
  const paragraphs = String(text).split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const out = [];
  for(let i=0;i<paragraphs.length;i++){
    const p = paragraphs[i];
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
    out.push('');
  }
  return out.join('\n').trim();
}

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
    setTimeout(()=>{ t.style.opacity = '0'; setTimeout(()=>{ try{ t.remove(); }catch(_){ } }, 260); }, ms);
  }catch(e){}
}

form.addEventListener('submit', async (ev) =>{
  ev.preventDefault();
  const text = input.value.trim();
  if(!text) return;
  const userBubble = createBubble('user', text);
  messagesEl.appendChild(userBubble);
  try{ ensureVisible(userBubble); }catch(_){ }
  input.value = '';
  input.style.height = '';
  scrollToBottom();
  const botBubble = createBubble('bot', '', true);
  messagesEl.appendChild(botBubble);
  try{ ensureVisible(botBubble); }catch(_){ scrollToBottom(); }
  const baseHist = loadHistory();
  const baseContents = [];
  for(const m of baseHist){
    baseContents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text }] });
  }
  baseContents.push({ role: 'user', parts: [{ text }] });
  try{ addMessageToHistory('user', text); }catch(e){}
  const attempted = new Set();
  let attemptIndex = selectedModelIndex;
  let succeeded = false;
  try{
    if(sendBtn) sendBtn.classList.add('sending');
    if(currentAbortController){ try{ currentAbortController.abort(); }catch(_){ } currentAbortController = null; }
    while(true){
      attempted.add(attemptIndex);
      if(attemptIndex !== selectedModelIndex){
        selectedModelIndex = attemptIndex;
        try{ updateModelBadge(); }catch(_){ }
      }
      const controller = new AbortController();
      currentAbortController = controller;
      const rawBody = { contents: baseContents, metadata: { model: modelChoices[attemptIndex].id, preset: selectedPreset } };
      try{
        const raw = await sendMessageToGemini(null, { rawBody, preset: selectedPreset, signal: controller.signal });
        if(!raw) throw new Error('No response from model');
        let aiText = extractTextFromResponse(raw);
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
            }catch(e){}
          }
          if(parts.length) aiText = parts.join('\n\n');
        }
        const clean = sanitizeAIText(aiText);
        const contentEl = botBubble.querySelector('div');
        const speed = (attemptIndex === 0) ? 18 : (attemptIndex === 1) ? 14 : (attemptIndex === 2) ? 12 : 10;
  await revealParagraphs(contentEl, clean, speed);
  try{ ensureVisible(botBubble); }catch(_){ }
        try{
          const actions = document.createElement('div');
          actions.className = 'msg-actions';
          actions.style.cssText = 'margin-top:8px;display:flex;gap:8px;justify-content:flex-end;align-items:center;flex-shrink:0;';
          const copyBtn = document.createElement('button');
          copyBtn.type = 'button';
          copyBtn.className = 'copy-btn';
          copyBtn.setAttribute('aria-label', 'Copy reply');
          copyBtn.textContent = 'Copy';
          copyBtn.addEventListener('click', async ()=>{
            try{
              if(navigator.clipboard && navigator.clipboard.writeText){
                await navigator.clipboard.writeText(clean);
              } else {
                const ta = document.createElement('textarea');
                ta.value = clean;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
              }
              copyBtn.textContent = 'Copied';
              setTimeout(()=>{ try{ copyBtn.textContent = 'Copy'; }catch(_){ } }, 1400);
            }catch(e){ try{ showToast('Copy failed'); }catch(_){ } }
          });
          actions.appendChild(copyBtn);
          botBubble.appendChild(actions);

          
        }catch(e){}
        addMessageToHistory('assistant', clean);
        succeeded = true;
        break;
      }catch(err){
        const msg = err && err.message ? String(err.message) : '';
        if(err && (err.name === 'AbortError' || msg.toLowerCase().includes('abort'))){
          botBubble.querySelector('div').textContent = '⚠️ Generation stopped.';
          currentAbortController = null;
          break;
        }
        const isLimit = msg.includes('HTTP 429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('quota')
          || msg.toLowerCase().includes('resource_exhausted') || msg.toLowerCase().includes('resource exhausted')
          || msg.toLowerCase().includes('overload') || msg.toLowerCase().includes('overloaded');
        if(isLimit){
          let found = -1;
          for(let cand = attemptIndex + 1; cand < modelChoices.length; cand++){
            if(!attempted.has(cand)){ found = cand; break; }
          }
          if(found >= 0){
            try{ showToast(`Switched to ${modelChoices[found].alias}`); }catch(_){ }
            attemptIndex = found;
            await new Promise(r => setTimeout(r, 600));
            continue;
          } else {
            botBubble.querySelector('div').textContent = '⚠️ All available model tiers have failed. Please try again later or select a different model.';
            showLimitModal('All available model tiers have reached their limits. Please try again later or choose a different model.', ()=>{});
            break;
          }
        } else {
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
  }catch(e){ try{ botBubble.querySelector('div').textContent = '⚠️ Unexpected error. Try again.'; }catch(_){ } }
  finally{ if(sendBtn) sendBtn.classList.remove('sending'); currentAbortController = null; scrollToBottom(); }
});

if(sendBtn){
  sendBtn.addEventListener('click', (e)=>{
    if(sendBtn.classList.contains('sending')){
      e.preventDefault();
      if(currentAbortController){ try{ currentAbortController.abort(); }catch(_){ } currentAbortController = null; }
      try{ sendBtn.classList.remove('sending'); }catch(_){ }
    }
  });
}

input.addEventListener('input', () =>{
  input.style.height = 'auto';
  input.style.height = (input.scrollHeight) + 'px';
});

input.addEventListener('keydown', (e) =>{
  if(e.key === 'Enter' && !e.shiftKey){
    e.preventDefault();
    form.requestSubmit();
  }
});

newChatBtn.addEventListener('click', ()=>{
  messagesEl.innerHTML = '';
  input.value = '';
  input.focus();
  clearHistory();
});

const aboutBtn = document.getElementById('aboutBtn');
const aboutModal = document.getElementById('aboutModal');
const aboutClose = document.getElementById('aboutClose');
const limitModal = document.getElementById('limitModal');
const limitTitle = document.getElementById('limitTitle');
const limitMsg = document.getElementById('limitMsg');
const limitCancel = document.getElementById('limitCancel');
const limitSwitch = document.getElementById('limitSwitch');

function showAbout(){ if(aboutModal) aboutModal.setAttribute('aria-hidden','false'); }
function hideAbout(){ if(aboutModal) aboutModal.setAttribute('aria-hidden','true'); }
function showLimitModal(message, onSwitch){
  if(limitModal){
    limitModal.setAttribute('aria-hidden','false');
    limitMsg.textContent = message;
    limitCancel.onclick = ()=>{ limitModal.setAttribute('aria-hidden','true'); };
    limitSwitch.onclick = ()=>{ limitModal.setAttribute('aria-hidden','true'); if(onSwitch) onSwitch(); };
  }
}

if(aboutBtn) aboutBtn.addEventListener('click', showAbout);
if(aboutClose) aboutClose.addEventListener('click', hideAbout);

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
}catch(e){}

function updateModelBadge(){
  try{ if(modelBadgeEl) modelBadgeEl.textContent = modelChoices[selectedModelIndex].alias; }catch(_){ }
  try{
    if(modelSelectEl){
      modelSelectEl.value = modelChoices[selectedModelIndex].id;
      const opts = Array.from(modelSelectEl.options || []);
      const idx = opts.findIndex(o => o.value === modelChoices[selectedModelIndex].id);
      if(idx >= 0) modelSelectEl.selectedIndex = idx;
    }
  }catch(_){ }
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

try{
  const hist = loadHistory();
  if(Array.isArray(hist) && hist.length){
    for(const m of hist){
      try{
        const role = (m.role === 'assistant') ? 'assistant' : 'user';
        const bubble = createBubble(role, m.text || '');
        messagesEl.appendChild(bubble);
      }catch(_){ }
    }
    scrollToBottom();
  }
}catch(e){}
