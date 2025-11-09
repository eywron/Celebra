# Celebra — Futuristic AI Chat (Gemini v2)

This is a lightweight frontend chat app (HTML/CSS/JS) that calls the Gemini v2 Free API.
It includes a Vercel serverless proxy so your API key stays on the server (recommended).

## Files
- `index.html` — UI shell
- `style.css` — Neon/futuristic styling
- `script.js` — Client logic; by default calls `/api/gemini` (server proxy)
- `api/gemini.js` — Vercel serverless function that forwards requests to Gemini using `GEMINI_API_KEY`

## Deploy to Vercel (recommended)

1. Install the Vercel CLI (optional) and log in, or use the Vercel dashboard.

   ```powershell
   npm i -g vercel
   vercel login
   ```

2. In your Vercel project settings, add an Environment Variable named `GEMINI_API_KEY` with your Gemini/Generative Language API key.
   - Make sure to add it for the correct environment (Production/Preview/Development) as required.

3. Deploy the project folder (the folder that contains `index.html` and the `api` directory):

   ```powershell
   vercel --prod
   ```

4. The client will call `/api/gemini` (serverless), which forwards requests to Google using the server-side env var.

## Local testing

- Simple static server (no proxy):

  ```powershell
  # from project root
  python -m http.server 5500
  # open http://localhost:5500
  ```

- To test the serverless proxy locally you can use `vercel dev` (recommended):

  ```powershell
  vercel dev
  ```

  `vercel dev` will run the `api/` serverless functions locally and you can set environment variables in a `.env` file or via `vercel env`.

## Setting your API key (safe options)

Important: do NOT put your real API key directly into any committed file (for example, don't replace values inside `api/gemini.js`). Instead use environment variables.

1) Vercel dashboard (recommended)
   - Open your Vercel project → Settings → Environment Variables.
   - Add a new variable: `GEMINI_API_KEY` with the key value. Deploy or redeploy.

2) Vercel CLI (interactive)
   ```powershell
   # install/login once
   npm i -g vercel
   vercel login

   # add your key for production (it will prompt interactively for the value)
   vercel env add GEMINI_API_KEY production
   ```

3) Local dev with `vercel dev` (use a local env file)
   - Copy `.env.example` to `.env.local` (or simply create a `.env.local`) and set the real key there. Do NOT commit it.
   ```powershell
   copy .env.example .env.local
   # then edit .env.local and replace YOUR_REAL_GEMINI_API_KEY_HERE with your real key
   notepad .env.local
   vercel dev
   ```

4) Git safety
   - Add `.env.local` to your `.gitignore` so the key is not committed.

## Endpoint override
If your key requires a different endpoint or model name, set `GEMINI_API_ENDPOINT` in your environment (Vercel settings or `.env.local`). Example:

GEMINI_API_ENDPOINT = https://generativelanguage.googleapis.com/v1/models/gemini-2.1:generate

## Image generation
This project includes basic support for image generation via the proxy. The serverless function will check for a request with `mode: 'image'` or an `imagePrompt`/`prompt` field and forward it to the configured image endpoint.

- Default image endpoint: `https://generativelanguage.googleapis.com/v1/images:generate`
- To override, set `GEMINI_IMAGE_ENDPOINT` in Vercel or your `.env.local`.

Usage from the UI:
- In the chat input, start a message with `/image ` or `image:` followed by your prompt. For example:
   - `/image A purple city skyline at night with neon lights` or
   - `image: An astronaut riding a horse, cinematic`.

The proxy will try to normalize common image response shapes to a JSON object `{ images: [{ url }|{ b64 }] }`. The client will render the first found image (either by URL or base64). If no recognizable image was found, the raw response will be shown.

## Quick debugging tips
- If the UI shows `⚠️ Connection error: ...`, open the browser DevTools Network tab and inspect the POST to `/api/gemini` and the response body.
- Check your Vercel function logs (Deployments → Logs → Functions) for any server-side errors.
- Common causes: missing `GEMINI_API_KEY`, invalid key, wrong endpoint, or Google API access not enabled for that key.

## Notes and Security
- Do NOT store your Gemini API key in client-side JS for production — it will be public.
- The included `api/gemini.js` expects `process.env.GEMINI_API_KEY` to be set on the server (Vercel Project > Settings > Environment Variables).
- If you must call the API directly from the browser for testing, you can set `USE_PROXY = false` and `CLIENT_API_KEY` in `script.js`, but this is insecure.

## Troubleshooting
- If you receive CORS errors when calling Google's endpoint from the browser, it's because the Google API may not allow direct browser requests — use the server proxy.
- If the serverless function reports `Server missing GEMINI_API_KEY`, ensure the environment variable was added and redeploy.

---
If you want, I can also add a tiny Node/Express proxy version (for self-hosting) or set up Git + Vercel link automatically. Which would you prefer next?
