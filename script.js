// script.js — Celebra Chat UI + Gemini v2 integration
// Recommended deployment: use the provided serverless proxy on Vercel so the API key is kept server-side.
// By default this client calls the relative proxy endpoint `/api/gemini` (Vercel Serverless Function included).
// If you want to call Gemini directly from the browser (not recommended — exposes your key), set
// `USE_PROXY = false` and set `CLIENT_API_KEY` below. For Vercel deployment leave USE_PROXY=true.

const USE_PROXY = true; // true => POST to /api/gemini (server-side forwarding)
const CLIENT_API_KEY = null; // optional local client key (unsafe in production)
const DEBUG_SHOW_ERRORS = true; // when true, show proxied error messages in the UI for debugging
const PROXY_ENDPOINT = '/api/gemini';
const MODEL_ENDPOINT = USE_PROXY ? PROXY_ENDPOINT : 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-pro:generateContent';

// --- Helpers and DOM refs
const messagesEl = document.getElementById('messages');
const form = document.getElementById('composer');
const input = document.getElementById('input');
const newChatBtn = document.getElementById('newChatBtn');

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
  // Remove leading/trailing whitespace on each line
  s = s.split('\n').map(l => l.trim()).join('\n');
  // Collapse multiple blank lines
  s = s.replace(/\n{3,}/g, '\n\n');
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

async function sendMessageToGemini(message){
  try{
    const payload = {
      // the API supports messages via `contents` as shown in the prompt
      contents: [
        { role: "user", parts: [{ text: message }] }
      ]
    };

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

    if(!resp.ok){
      const txt = await resp.text();
      throw new Error(`HTTP ${resp.status} — ${txt}`);
    }

    const data = await resp.json();
    // Defensive path to find text
    const found = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if(!found) return null;
    return found;
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

  // Add user bubble
  const userBubble = createBubble('user', text);
  messagesEl.appendChild(userBubble);
  input.value = '';
  input.style.height = '';
  scrollToBottom();

  // Add bot typing bubble
  const botBubble = createBubble('bot', '', true);
  messagesEl.appendChild(botBubble);
  scrollToBottom();

  try{
    // Call Gemini
    const raw = await sendMessageToGemini(text);
    if(!raw){
      // replace typing with error message
      const content = botBubble.querySelector('div');
      content.textContent = '⚠️ No response from Gemini.';
      return;
    }

    const clean = sanitizeAIText(raw);
    const content = botBubble.querySelector('div');
    // Reveal text with typing animation
    await revealText(content, clean, 16);
  }catch(err){
    const content = botBubble.querySelector('div');
    // Provide a specific message for HTTP 405 which commonly means the host
    // (for example a static Live Server) does not support serverless functions
    // at `/api/*`. Offer actionable fixes.
    let uiMsg = '⚠️ Connection error. Try again.';
    if (err && err.message) {
      if (err.message.includes('HTTP 405')) {
        uiMsg = '⚠️ Server returned 405 — your current host (live/static server) does not run serverless functions at `/api/*`.\n\nFixes: run `vercel dev` locally, deploy to Vercel, or for quick local testing set `USE_PROXY = false` and `CLIENT_API_KEY` in `script.js` (unsafe, not for production).';
      } else if (DEBUG_SHOW_ERRORS) {
        uiMsg = `⚠️ Connection error: ${err.message}`;
      }
    }
    content.textContent = uiMsg;
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
});

// Small welcome example message
window.addEventListener('load', ()=>{
  const intro = createBubble('bot','Hello! I am Celebra — your futuristic assistant. Ask me anything.');
  messagesEl.appendChild(intro);
  scrollToBottom();
});
