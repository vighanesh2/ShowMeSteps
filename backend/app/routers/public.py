"""Public learner endpoints for published tutorials (no auth)."""

from __future__ import annotations

from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import RedirectResponse

from app.models.schemas import PublicTutorial, PublicTutorialStep
from app.services.share import is_valid_slug, share_url_for, start_url_from_tutorial
from app.services.supabase import get_supabase_admin
from app.services.verification import (
    default_criteria_from_tutorial,
    public_criteria_view,
)

router = APIRouter(prefix="/public", tags=["public"])


def _get_published_by_slug(slug: str) -> dict[str, Any]:
    if not is_valid_slug(slug):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tutorial not found")

    admin = get_supabase_admin()
    try:
        result = (
            admin.table("tutorials")
            .select("*, steps:tutorial_steps(*)")
            .eq("share_slug", slug)
            .eq("status", "published")
            .maybe_single()
            .execute()
        )
        data = result.data
    except Exception:
        data = None

    if not data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Published tutorial not found",
        )

    steps = data.get("steps") or []
    data["steps"] = sorted(steps, key=lambda s: s.get("order_index", 0))
    return data


def _to_public(data: dict[str, Any]) -> PublicTutorial:
    slug = data["share_slug"]
    steps = [
        PublicTutorialStep(
            id=s["id"],
            title=s["title"],
            description=s.get("description"),
            order_index=s.get("order_index", 0),
            screenshot_path=s.get("screenshot_path"),
            metadata=s.get("metadata") or {},
        )
        for s in data.get("steps") or []
    ]
    raw_criteria = data.get("completion_criteria") or {}
    if not raw_criteria:
        raw_criteria = default_criteria_from_tutorial(data)

    return PublicTutorial(
        id=data["id"],
        title=data["title"],
        description=data.get("description"),
        share_slug=slug,
        share_url=share_url_for(slug),
        start_url=start_url_from_tutorial(data),
        step_count=len(steps),
        steps=steps,
        completion_criteria=public_criteria_view(raw_criteria),
    )


def with_guide_params(url: str, slug: str, step: int = 0) -> str:
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query["sms_guide"] = slug
    query["sms_step"] = str(step)
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment)
    )


@router.get("/tutorials/{slug}", response_model=PublicTutorial)
async def get_public_tutorial(slug: str) -> PublicTutorial:
    return _to_public(_get_published_by_slug(slug))


@router.get("/tutorials/{slug}/launch")
async def launch_public_tutorial(slug: str, step: int = 0):
    """Redirect to the tutorial start URL with extension guide query params."""
    data = _get_published_by_slug(slug)
    start = start_url_from_tutorial(data)
    if not start:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "This tutorial has no launch URL. Re-record including the starting page, "
                "or open the target site and start the guide from the extension popup."
            ),
        )
    safe_step = max(0, step)
    return RedirectResponse(
        url=with_guide_params(start, slug, safe_step),
        status_code=status.HTTP_302_FOUND,
    )
