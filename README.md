# ShowMeSteps

Capture and share step-by-step tutorials with screenshots and recordings.

## Project layout

```
backend/          FastAPI + Supabase (Auth, Postgres, Storage)
  app/            Application code
  sql/schema.sql  Database + storage setup for Supabase
extension/        Chrome extension — record tasks + screenshots
```

## Quick start

1. Backend — see [backend/README.md](backend/README.md) (set `GROQ_API_KEY` for AI drafts)
2. Extension — see [extension/README.md](extension/README.md) (Load unpacked in Chrome)
3. After recording stops, review the AI draft at `/review/?tutorial_id=…`
4. Publish → share `/t/<slug>` → learners click **Start guided tutorial**
5. Creator dashboard → http://localhost:8000/dashboard
