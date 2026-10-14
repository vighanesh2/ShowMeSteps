from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.config import get_settings
from app.monitoring import (
    RequestIdMiddleware,
    SecurityHeadersMiddleware,
    configure_logging,
    init_sentry,
)
from app.routers import (
    auth,
    dashboard,
    generate,
    help,
    media,
    privacy,
    public,
    teams,
    tutorials,
    verify,
)

settings = get_settings()
STATIC_DIR = Path(__file__).resolve().parent / "static"

configure_logging()

app = FastAPI(
    title=settings.app_name,
    description="ShowMeSteps API — teams, assignments, guide, verify, and production-ready ops",
    version="0.7.0",
    debug=settings.debug and not settings.is_production,
)

init_sentry(app)

app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestIdMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list + [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router, prefix="/api")
app.include_router(tutorials.router, prefix="/api")
app.include_router(media.router, prefix="/api")
app.include_router(generate.router, prefix="/api")
app.include_router(public.router, prefix="/api")
app.include_router(help.router, prefix="/api")
app.include_router(verify.router, prefix="/api")
app.include_router(dashboard.router, prefix="/api")
app.include_router(teams.router, prefix="/api")
app.include_router(privacy.router, prefix="/api")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "app": settings.app_name,
        "environment": settings.environment,
    }


@app.get("/dashboard")
@app.get("/dashboard/")
async def dashboard_page():
    return FileResponse(STATIC_DIR / "dashboard" / "index.html")


@app.get("/teams")
@app.get("/teams/")
async def teams_page():
    return FileResponse(STATIC_DIR / "teams" / "index.html")


@app.get("/review")
@app.get("/review/")
async def review_page():
    return FileResponse(STATIC_DIR / "review" / "index.html")


@app.get("/privacy")
@app.get("/privacy/")
async def privacy_page():
    return FileResponse(STATIC_DIR / "privacy" / "index.html")


@app.get("/t/{slug}")
@app.get("/t/{slug}/")
async def learner_page(slug: str):
    return FileResponse(STATIC_DIR / "learn" / "index.html")


@app.get("/")
async def root():
    return RedirectResponse(url="/dashboard")
