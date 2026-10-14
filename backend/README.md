# ShowMeSteps API

Python FastAPI backend backed by **Supabase** (PostgreSQL, Auth, Storage).

## Features

- User signup / login via Supabase Auth
- Tutorial CRUD + nested steps
- Screenshot & recording uploads to Supabase Storage
- Media asset metadata in Postgres with signed URL access

## Setup

### 1. Create a Supabase project

1. Create a project at [supabase.com](https://supabase.com)
2. Open **SQL Editor** and run [`sql/schema.sql`](sql/schema.sql)
3. Copy keys from **Project Settings → API**:
   - Project URL
   - `anon` key
   - `service_role` key
   - JWT Secret

For local signup without email confirmation: **Authentication → Providers → Email → disable “Confirm email”**.

### 2. Configure environment

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env with your Supabase values
```

### 3. Run the API

```bash
uvicorn app.main:app --reload --port 8000
```

- Health: http://localhost:8000/health  
- Docs: http://localhost:8000/docs  

## API overview

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/signup` | — | Create account |
| `POST` | `/api/auth/login` | — | Get JWT |
| `GET` | `/api/auth/me` | Bearer | Current user |
| `POST` | `/api/auth/logout` | Bearer | Logout |
| `GET` | `/api/tutorials` | Bearer | List tutorials |
| `POST` | `/api/tutorials` | Bearer | Create tutorial (+ optional steps) |
| `GET` | `/api/tutorials/{id}` | Bearer | Get tutorial |
| `PATCH` | `/api/tutorials/{id}` | Bearer | Update tutorial |
| `DELETE` | `/api/tutorials/{id}` | Bearer | Delete tutorial |
| `POST` | `/api/tutorials/{id}/steps` | Bearer | Add step |
| `PATCH` | `/api/tutorials/{id}/steps/{step_id}` | Bearer | Update step |
| `DELETE` | `/api/tutorials/{id}/steps/{step_id}` | Bearer | Delete step |
| `POST` | `/api/media/upload` | Bearer | Upload screenshot/recording (`multipart/form-data`) |
| `GET` | `/api/media/tutorial/{id}` | Bearer | List media for tutorial |
| `GET` | `/api/media/{asset_id}/signed-url` | Bearer | Temporary download URL |
| `DELETE` | `/api/media/{asset_id}` | Bearer | Delete media |

### Upload example

```bash
TOKEN=eyJ...
curl -X POST http://localhost:8000/api/media/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "tutorial_id=<uuid>" \
  -F "media_type=screenshot" \
  -F "file=@shot.png" \
  -F 'metadata={"step":1}'
```

Recording data (JSON event streams, video, etc.) uses `media_type=recording`.

## AI tutorial generation (Groq)

1. Add `GROQ_API_KEY` to `.env` from [console.groq.com/keys](https://console.groq.com/keys). Default model is `openai/gpt-oss-120b` (`llama-3.3-70b-versatile` was retired for free/developer plans).
2. Record with the Chrome extension (or upload a recording JSON)
3. `POST /api/tutorials/{id}/generate` — Groq writes plain-language steps and attaches screenshots
4. Open `/review/?tutorial_id=…` — edit the draft, then **Save draft** or **Save & publish**
5. `PUT /api/tutorials/{id}/save` — persists the finished tutorial in Postgres

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tutorials/{id}/generate` | Generate steps with Groq |
| `PUT` | `/api/tutorials/{id}/save` | Save reviewed steps (+ optional publish) |
| `GET` | `/review/?tutorial_id=` | Creator review UI |
| `GET` | `/t/{slug}` | Learner page (shareable link) |
| `GET` | `/api/public/tutorials/{slug}` | Public tutorial JSON |
| `GET` | `/api/public/tutorials/{slug}/launch` | Open site + start extension guide |
| `POST` | `/api/public/help/mistake` | Explain a wrong click / missed step |
| `POST` | `/api/public/help/ask` | Answer a learner question about the step |
| `POST` | `/api/public/help/recover` | Coach how to return to the workflow |
| `PUT` | `/api/tutorials/{id}/completion` | Define success / verification criteria |
| `POST` | `/api/tutorials/{id}/completion/autofill` | Infer criteria from final step |
| `GET` | `/api/tutorials/{id}/attempts` | List learner attempts |
| `PATCH` | `/api/tutorials/{id}/attempts/{attempt_id}` | Manual pass / retry review |
| `POST` | `/api/public/tutorials/{slug}/attempts` | Start a learner attempt |
| `POST` | `/api/public/tutorials/{slug}/attempts/{id}/complete` | Verify & save result |
| `POST` | `/api/public/tutorials/{slug}/attempts/{id}/evidence` | Upload evidence file |

### Verification

1. Run `sql/migration_verification.sql` in Supabase
2. On publish, success criteria are auto-filled (also editable in `/review`)
3. Modes: `steps_only`, `page_check`, `api`, `file`, or always `manual`
4. Failed auto-checks can fall back to **pending_review**
5. Creators mark attempts **passed** or **needs_retry** in the review UI

### Teams (business)

1. Run `sql/migration_teams.sql` in Supabase
2. Open **http://localhost:8000/teams**
3. Create a team → invite employees by email → assign a tutorial

Employees see assignments under **Assigned to me** (and can open the share link).

### Production

See [PRODUCTION.md](PRODUCTION.md) for Docker/Render deploy, Sentry, and privacy controls.

### Creator dashboard

Open **http://localhost:8000/dashboard**

- All tutorials with edit / publish / share
- Starts, finishes, pass rate
- Problem steps (where learners get stuck or make mistakes)
- Recent verification results and progress

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/dashboard` | Tutorials + analytics |
| `POST` | `/api/dashboard/tutorials/{id}/publish` | Publish + share link |
| `POST` | `/api/dashboard/tutorials/{id}/unpublish` | Revert to draft |

### Interactive guiding

1. Run `sql/migration_share_slug.sql` in Supabase (once)
2. Publish a tutorial from `/review` — you get a share URL like `/t/my-task-ab12cd`
3. Learner opens the link → **Start guided tutorial**
4. Chrome extension highlights the target control, shows an instruction box, detects the action, and advances automatically

## Architecture

```
Extension → FastAPI → Supabase Auth / Postgres / Storage
                    → Groq (llama) → draft tutorial steps
Creator  → /review UI → edit → save/publish in DB
```

The API uses the **service role** key for trusted server-side reads/writes after verifying the user JWT. RLS policies in `schema.sql` still protect direct client access.
