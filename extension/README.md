# ShowMeSteps Chrome Extension

Records someone completing a task in the browser, then uploads actions + screenshots to the FastAPI backend to build a tutorial.

## What it captures

| Event | Details |
|--------|---------|
| Clicks | Target element selector, text, bounds |
| Form change / select | Safe values only |
| Typing (debounced) | Non-sensitive fields only |
| Form submit | Field list with redaction |
| Navigation | SPA + full page loads |

**Never stored:** password fields, hidden inputs, credit-card / SSN / OTP-style fields (by `type`, `autocomplete`, and name heuristics). Screenshots temporarily mask those fields before capture.

## Load in Chrome

1. Start the backend (`uvicorn` on port 8000).
2. Create a user via `/docs` → `POST /api/auth/signup` (or your UI).
3. Open `chrome://extensions` → enable **Developer mode**.
4. **Load unpacked** → select this `extension/` folder.
5. Pin **ShowMeSteps**, log in with your API URL + credentials.
6. Open the site you want to demo → **Start Recording** → do the task → **Stop Recording**.

On stop, the extension:

1. Creates a draft tutorial
2. Uploads the full action JSON (`media_type=recording`)
3. Uploads PNG screenshots (`media_type=screenshot`)
4. Calls `POST /api/tutorials/{id}/generate` (Groq) for plain-language steps
5. Opens `/review/?tutorial_id=…` so you can edit and save/publish

## Guided learning

1. Creator publishes from `/review` → gets share URL `/t/<slug>`
2. Learner opens the link → **Start guided tutorial** (or paste the link in the extension popup)
3. Extension highlights the target control, shows an instruction box, detects the click/change/nav, and advances
4. Wrong clicks get a simple AI explanation + re-highlight; **Ask AI** answers step questions; **Get me back** returns to the right page

## Permissions

- `tabs` / `scripting` / `webNavigation` — inject recorder/guide & capture screenshots
- Host access — record/guide on http(s) pages and call `localhost:8000`

## Files

```
extension/
  manifest.json
  popup/           Start / Stop UI + login
  background/      Session, screenshots, upload
  content/         Page event capture + redaction
  lib/             API client + helpers
  icons/
```
