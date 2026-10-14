# Production deployment

## Checklist

1. Run SQL migrations in Supabase:
   - `sql/schema.sql` (fresh) **or** incremental:
   - `sql/migration_share_slug.sql`
   - `sql/migration_verification.sql`
   - `sql/migration_teams.sql`
2. Set production env vars (never commit secrets):
   - `ENVIRONMENT=production`
   - `DEBUG=false`
   - `PUBLIC_APP_URL=https://your-api.example.com`
   - `CORS_ORIGINS=https://your-frontend.example.com`
   - Supabase + Groq keys
   - Optional: `SENTRY_DSN=...`
3. Deploy with Docker (local smoke test):

```bash
cd backend
docker compose up --build
curl https://localhost:8000/health   # or http://localhost:8000/health
```

4. Or deploy `render.yaml` / any Docker host (Fly, Railway, Cloud Run).

## Privacy controls

- Sentry is configured with `send_default_pii=False`
- Team privacy settings: hide member emails from non-admins, retention days, AI coaching toggle
- API: `GET/PUT /api/privacy/preferences`, `DELETE /api/privacy/me/attempts`, `POST /api/privacy/purge-expired`
- Static policy page: `/privacy`

## Monitoring

- `SENTRY_DSN` enables Sentry for FastAPI
- Every response includes `X-Request-Id`
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, HSTS in production

## Extension

Point the extension API URL at your production `PUBLIC_APP_URL`. Reload after deploy.
