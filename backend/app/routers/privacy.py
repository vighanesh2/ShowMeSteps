"""Privacy controls for creators and learners."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.config import get_settings
from app.dependencies import CurrentUser
from app.services.supabase import get_supabase_admin

router = APIRouter(prefix="/privacy", tags=["privacy"])


class PrivacyPreferences(BaseModel):
    retain_attempts_days: int = Field(default=365, ge=30, le=3650)
    allow_ai_coaching: bool = True
    share_analytics_with_team_admins: bool = True


class PrivacyPreferencesResponse(BaseModel):
    preferences: PrivacyPreferences
    message: str = "Privacy preferences"


class DeleteDataResponse(BaseModel):
    deleted_attempts: int
    message: str


# In-memory prefs keyed by user id for MVP (also stored in user_metadata when possible)
_PREFS: dict[str, dict[str, Any]] = {}


@router.get("/preferences", response_model=PrivacyPreferencesResponse)
async def get_preferences(current_user: CurrentUser) -> PrivacyPreferencesResponse:
    settings = get_settings()
    stored = _PREFS.get(str(current_user.id)) or {}
    prefs = PrivacyPreferences(
        retain_attempts_days=int(
            stored.get("retain_attempts_days", settings.privacy_retain_attempts_days)
        ),
        allow_ai_coaching=bool(
            stored.get("allow_ai_coaching", settings.privacy_allow_ai_coaching_default)
        ),
        share_analytics_with_team_admins=bool(
            stored.get("share_analytics_with_team_admins", True)
        ),
    )
    return PrivacyPreferencesResponse(preferences=prefs)


@router.put("/preferences", response_model=PrivacyPreferencesResponse)
async def update_preferences(
    payload: PrivacyPreferences,
    current_user: CurrentUser,
) -> PrivacyPreferencesResponse:
    _PREFS[str(current_user.id)] = payload.model_dump()
    # Best-effort persist on auth user metadata
    try:
        admin = get_supabase_admin()
        admin.auth.admin.update_user_by_id(
            str(current_user.id),
            {"user_metadata": {"privacy": payload.model_dump()}},
        )
    except Exception:
        pass
    return PrivacyPreferencesResponse(
        preferences=payload,
        message="Privacy preferences saved.",
    )


@router.delete("/me/attempts", response_model=DeleteDataResponse)
async def delete_my_attempt_data(current_user: CurrentUser) -> DeleteDataResponse:
    """Delete learner attempts associated with this user's email/key prefix."""
    admin = get_supabase_admin()
    # Attempts use anonymous learner_key; also match evidence notes with email if present
    # Delete attempts where learner_label equals email (if they set it) — limited MVP
    result = (
        admin.table("tutorial_attempts")
        .delete()
        .eq("learner_label", current_user.email)
        .execute()
    )
    deleted = len(result.data or [])
    return DeleteDataResponse(
        deleted_attempts=deleted,
        message=f"Deleted {deleted} attempt(s) labeled with your email.",
    )


@router.post("/purge-expired", response_model=dict)
async def purge_expired_attempts(current_user: CurrentUser) -> dict:
    """Owner utility: purge old attempts for tutorials you own (retention policy)."""
    settings = get_settings()
    prefs = _PREFS.get(str(current_user.id)) or {}
    days = int(prefs.get("retain_attempts_days", settings.privacy_retain_attempts_days))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)

    admin = get_supabase_admin()
    tutorials = (
        admin.table("tutorials")
        .select("id")
        .eq("owner_id", str(current_user.id))
        .execute()
    )
    ids = [t["id"] for t in tutorials.data or []]
    if not ids:
        return {"deleted": 0, "cutoff": cutoff.isoformat()}

    deleted = 0
    for tid in ids:
        result = (
            admin.table("tutorial_attempts")
            .delete()
            .eq("tutorial_id", tid)
            .lt("created_at", cutoff.isoformat())
            .execute()
        )
        deleted += len(result.data or [])

    return {
        "deleted": deleted,
        "cutoff": cutoff.isoformat(),
        "retain_attempts_days": days,
        "message": f"Purged {deleted} attempt(s) older than {days} days.",
    }
