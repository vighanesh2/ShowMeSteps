"""AI tutorial generation (Groq) and creator review/save."""

from __future__ import annotations

import json
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Body, HTTPException, status

from app.config import get_settings
from app.dependencies import CurrentUser
from app.models.schemas import (
    GenerateTutorialRequest,
    GenerateTutorialResponse,
    GeneratedStepDraft,
    SaveTutorialRequest,
    SaveTutorialResponse,
    Tutorial,
    TutorialStatus,
)
from app.routers.tutorials import _get_owned_tutorial
from app.services.groq_tutorial import generate_tutorial_from_actions
from app.services.share import ensure_share_slug, share_url_for
from app.services.supabase import get_supabase_admin
from app.services.verification import default_criteria_from_tutorial

router = APIRouter(prefix="/tutorials", tags=["generate"])


def _download_recording_json(bucket: str, path: str) -> dict[str, Any]:
    admin = get_supabase_admin()
    try:
        raw = admin.storage.from_(bucket).download(path)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not download recording: {exc}",
        ) from exc

    if isinstance(raw, bytes):
        text = raw.decode("utf-8")
    else:
        text = str(raw)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Recording file is not valid JSON",
        ) from exc


def _latest_recording(tutorial_id: UUID, owner_id: UUID) -> Optional[dict[str, Any]]:
    admin = get_supabase_admin()
    result = (
        admin.table("media_assets")
        .select("*")
        .eq("tutorial_id", str(tutorial_id))
        .eq("owner_id", str(owner_id))
        .eq("media_type", "recording")
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    rows = result.data or []
    return rows[0] if rows else None


def _screenshot_map(tutorial_id: UUID, owner_id: UUID) -> dict[int, dict[str, Any]]:
    """Map source action_index -> media asset row."""
    admin = get_supabase_admin()
    result = (
        admin.table("media_assets")
        .select("*")
        .eq("tutorial_id", str(tutorial_id))
        .eq("owner_id", str(owner_id))
        .eq("media_type", "screenshot")
        .order("created_at", desc=False)
        .execute()
    )
    mapping: dict[int, dict[str, Any]] = {}
    for row in result.data or []:
        meta = row.get("metadata") or {}
        idx = meta.get("actionIndex", meta.get("action_index"))
        try:
            key = int(idx)
        except (TypeError, ValueError):
            continue
        # Keep first screenshot for each action index
        mapping.setdefault(key, row)
    return mapping


def _signed_or_public_url(bucket: str, path: str) -> Optional[str]:
    admin = get_supabase_admin()
    try:
        signed = admin.storage.from_(bucket).create_signed_url(path, 3600 * 24)
        return signed.get("signedURL") or signed.get("signed_url")
    except Exception:
        try:
            return admin.storage.from_(bucket).get_public_url(path)
        except Exception:
            return None


def _nearest_screenshot(
    source_index: Optional[int],
    screenshots: dict[int, dict[str, Any]],
) -> Optional[dict[str, Any]]:
    if source_index is None or not screenshots:
        return None
    if source_index in screenshots:
        return screenshots[source_index]
    # Prefer closest earlier screenshot (visual state before/at the action)
    earlier = [i for i in screenshots if i <= source_index]
    if earlier:
        return screenshots[max(earlier)]
    return screenshots[min(screenshots.keys())]


@router.post(
    "/{tutorial_id}/generate",
    response_model=GenerateTutorialResponse,
)
async def generate_tutorial(
    tutorial_id: UUID,
    current_user: CurrentUser,
    payload: GenerateTutorialRequest = Body(default_factory=GenerateTutorialRequest),
) -> GenerateTutorialResponse:
    tutorial = _get_owned_tutorial(tutorial_id, current_user.id)
    settings = get_settings()

    actions: list[dict[str, Any]] = list(payload.actions or [])
    if not actions:
        recording = _latest_recording(tutorial_id, current_user.id)
        if not recording:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No recording found for this tutorial. Upload a recording first.",
            )
        data = _download_recording_json(recording["bucket"], recording["file_path"])
        actions = list(data.get("actions") or [])

    if not actions:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Recording has no actions",
        )

    screenshots = _screenshot_map(tutorial_id, current_user.id)

    try:
        generated = generate_tutorial_from_actions(
            actions=actions,
            tutorial_title=tutorial.get("title"),
            available_screenshot_indexes=sorted(screenshots.keys()),
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Groq generation failed: {exc}",
        ) from exc

    admin = get_supabase_admin()

    new_title = tutorial.get("title") or "Untitled tutorial"
    if payload.update_title and generated.get("title"):
        new_title = generated["title"][:200]
        admin.table("tutorials").update(
            {
                "title": new_title,
                "description": generated.get("summary") or tutorial.get("description"),
                "status": TutorialStatus.draft.value,
            }
        ).eq("id", str(tutorial_id)).execute()
    elif generated.get("summary"):
        admin.table("tutorials").update(
            {
                "description": generated["summary"],
                "status": TutorialStatus.draft.value,
            }
        ).eq("id", str(tutorial_id)).execute()

    if payload.replace_existing_steps:
        admin.table("tutorial_steps").delete().eq(
            "tutorial_id", str(tutorial_id)
        ).execute()

    draft_steps: list[GeneratedStepDraft] = []
    rows_to_insert: list[dict[str, Any]] = []

    for step in generated["steps"]:
        source_index = step.get("source_action_index")
        shot = _nearest_screenshot(source_index, screenshots)
        screenshot_path = shot["file_path"] if shot else None
        screenshot_url = None
        if shot:
            screenshot_url = _signed_or_public_url(shot["bucket"], shot["file_path"])

        source_action = None
        if isinstance(source_index, int) and 0 <= source_index < len(actions):
            source_action = actions[source_index]

        meta = {
            "generated_by": "groq",
            "model": generated.get("model"),
            "source_action_index": source_index,
            "element_hint": step.get("element_hint"),
            "element": (source_action or {}).get("element"),
            "kind": (source_action or {}).get("kind"),
            "url": (source_action or {}).get("url"),
        }

        rows_to_insert.append(
            {
                "tutorial_id": str(tutorial_id),
                "title": step["title"],
                "description": step.get("explanation") or "",
                "order_index": step["order_index"],
                "screenshot_path": screenshot_path,
                "metadata": meta,
            }
        )
        draft_steps.append(
            GeneratedStepDraft(
                order_index=step["order_index"],
                title=step["title"],
                explanation=step.get("explanation") or "",
                source_action_index=source_index,
                screenshot_path=screenshot_path,
                screenshot_url=screenshot_url,
                element_hint=step.get("element_hint"),
                metadata=meta,
            )
        )

    if rows_to_insert:
        admin.table("tutorial_steps").insert(rows_to_insert).execute()

    review_url = (
        f"{settings.public_app_url.rstrip('/')}/review/"
        f"?tutorial_id={tutorial_id}"
    )

    return GenerateTutorialResponse(
        tutorial_id=tutorial_id,
        title=new_title,
        summary=generated.get("summary"),
        model=generated.get("model") or settings.groq_model,
        steps=draft_steps,
        review_url=review_url,
    )


@router.put("/{tutorial_id}/save", response_model=SaveTutorialResponse)
async def save_reviewed_tutorial(
    tutorial_id: UUID,
    payload: SaveTutorialRequest,
    current_user: CurrentUser,
) -> SaveTutorialResponse:
    """Replace steps with the creator's edited version and optionally publish."""
    _get_owned_tutorial(tutorial_id, current_user.id)
    admin = get_supabase_admin()

    updates: dict[str, Any] = {}
    if payload.title is not None:
        updates["title"] = payload.title
    if payload.description is not None:
        updates["description"] = payload.description
    if payload.publish:
        updates["status"] = TutorialStatus.published.value
    else:
        updates["status"] = TutorialStatus.draft.value

    if updates:
        admin.table("tutorials").update(updates).eq("id", str(tutorial_id)).execute()

    admin.table("tutorial_steps").delete().eq("tutorial_id", str(tutorial_id)).execute()

    if payload.steps:
        rows = [
            {
                "tutorial_id": str(tutorial_id),
                "title": step.title,
                "description": step.description,
                "order_index": step.order_index,
                "screenshot_path": step.screenshot_path,
                "metadata": {
                    **(step.metadata or {}),
                    "reviewed": True,
                },
            }
            for step in sorted(payload.steps, key=lambda s: s.order_index)
        ]
        # Normalize order_index to contiguous
        for i, row in enumerate(rows):
            row["order_index"] = i
        admin.table("tutorial_steps").insert(rows).execute()

    share_slug = None
    share_url = None
    if payload.publish:
        owned = _get_owned_tutorial(tutorial_id, current_user.id)
        share_slug = ensure_share_slug(tutorial_id, owned.get("title"))
        share_url = share_url_for(share_slug)
        # Ensure success criteria exist when publishing
        existing_criteria = owned.get("completion_criteria") or {}
        if not existing_criteria:
            admin.table("tutorials").update(
                {"completion_criteria": default_criteria_from_tutorial(owned)}
            ).eq("id", str(tutorial_id)).execute()

    data = _get_owned_tutorial(tutorial_id, current_user.id)
    if data.get("share_slug"):
        data["share_url"] = share_url_for(data["share_slug"])
        share_slug = data["share_slug"]
        share_url = data["share_url"]

    tutorial = Tutorial.model_validate(data)
    message = (
        f"Tutorial published. Share link: {share_url}"
        if payload.publish and share_url
        else (
            "Tutorial published."
            if payload.publish
            else "Draft saved. You can keep editing or publish later."
        )
    )
    return SaveTutorialResponse(
        tutorial=tutorial,
        message=message,
        share_url=share_url,
        share_slug=share_slug,
    )
