"""Completion criteria, learner attempts, and verification."""

from __future__ import annotations

import uuid
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from app.config import get_settings
from app.dependencies import CurrentUser
from app.models.schemas import (
    Attempt,
    AttemptListResponse,
    AttemptStatus,
    CompleteAttemptRequest,
    CompleteAttemptResponse,
    CompletionCriteriaUpdate,
    ManualReviewRequest,
    StartAttemptRequest,
    Tutorial,
)
from app.routers.public import _get_published_by_slug
from app.routers.tutorials import _get_owned_tutorial
from app.services.share import share_url_for
from app.services.supabase import get_supabase_admin
from app.services.verification import (
    default_criteria_from_tutorial,
    evaluate_attempt,
    normalize_criteria,
    public_criteria_view,
)

router = APIRouter(tags=["verify"])


def _parse_attempt(row: dict[str, Any]) -> Attempt:
    indexes = row.get("completed_step_indexes") or []
    if not isinstance(indexes, list):
        indexes = []
    row = {**row, "completed_step_indexes": indexes}
    return Attempt.model_validate(row)


def _get_attempt(attempt_id: UUID, tutorial_id: Optional[UUID] = None) -> dict[str, Any]:
    admin = get_supabase_admin()
    query = admin.table("tutorial_attempts").select("*").eq("id", str(attempt_id))
    if tutorial_id:
        query = query.eq("tutorial_id", str(tutorial_id))
    try:
        result = query.maybe_single().execute()
        data = result.data
    except Exception:
        data = None
    if not data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attempt not found")
    return data


# --- Creator: completion criteria ---


@router.put("/tutorials/{tutorial_id}/completion", response_model=Tutorial)
async def update_completion_criteria(
    tutorial_id: UUID,
    payload: CompletionCriteriaUpdate,
    current_user: CurrentUser,
) -> Tutorial:
    _get_owned_tutorial(tutorial_id, current_user.id)
    criteria = normalize_criteria(payload.model_dump())
    admin = get_supabase_admin()
    admin.table("tutorials").update({"completion_criteria": criteria}).eq(
        "id", str(tutorial_id)
    ).execute()
    data = _get_owned_tutorial(tutorial_id, current_user.id)
    if data.get("share_slug"):
        data["share_url"] = share_url_for(data["share_slug"])
    return Tutorial.model_validate(data)


@router.post("/tutorials/{tutorial_id}/completion/autofill", response_model=Tutorial)
async def autofill_completion_criteria(
    tutorial_id: UUID,
    current_user: CurrentUser,
) -> Tutorial:
    data = _get_owned_tutorial(tutorial_id, current_user.id)
    criteria = default_criteria_from_tutorial(data)
    admin = get_supabase_admin()
    admin.table("tutorials").update({"completion_criteria": criteria}).eq(
        "id", str(tutorial_id)
    ).execute()
    data = _get_owned_tutorial(tutorial_id, current_user.id)
    if data.get("share_slug"):
        data["share_url"] = share_url_for(data["share_slug"])
    return Tutorial.model_validate(data)


@router.get("/tutorials/{tutorial_id}/attempts", response_model=AttemptListResponse)
async def list_attempts(
    tutorial_id: UUID,
    current_user: CurrentUser,
) -> AttemptListResponse:
    _get_owned_tutorial(tutorial_id, current_user.id)
    admin = get_supabase_admin()
    result = (
        admin.table("tutorial_attempts")
        .select("*", count="exact")
        .eq("tutorial_id", str(tutorial_id))
        .order("created_at", desc=True)
        .execute()
    )
    items = [_parse_attempt(row) for row in (result.data or [])]
    return AttemptListResponse(items=items, count=result.count or len(items))


@router.patch(
    "/tutorials/{tutorial_id}/attempts/{attempt_id}",
    response_model=Attempt,
)
async def manual_review_attempt(
    tutorial_id: UUID,
    attempt_id: UUID,
    payload: ManualReviewRequest,
    current_user: CurrentUser,
) -> Attempt:
    _get_owned_tutorial(tutorial_id, current_user.id)
    if payload.status not in {
        AttemptStatus.passed,
        AttemptStatus.needs_retry,
        AttemptStatus.failed,
        AttemptStatus.pending_review,
    }:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Manual review status must be passed, needs_retry, failed, or pending_review",
        )

    row = _get_attempt(attempt_id, tutorial_id)
    verification = dict(row.get("verification_result") or {})
    verification["manual_review"] = {
        "status": payload.status.value,
        "notes": payload.reviewer_notes,
        "reviewed_by": str(current_user.id),
    }

    from datetime import datetime, timezone

    updates = {
        "status": payload.status.value,
        "reviewer_notes": payload.reviewer_notes,
        "reviewed_by": str(current_user.id),
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "verification_result": verification,
        "verification_method": "manual",
    }
    admin = get_supabase_admin()
    admin.table("tutorial_attempts").update(updates).eq("id", str(attempt_id)).execute()
    return _parse_attempt(_get_attempt(attempt_id, tutorial_id))


# --- Public learner attempts ---


@router.post(
    "/public/tutorials/{slug}/attempts",
    response_model=Attempt,
    status_code=status.HTTP_201_CREATED,
)
async def start_attempt(slug: str, payload: StartAttemptRequest) -> Attempt:
    tutorial = _get_published_by_slug(slug)
    steps_total = len(tutorial.get("steps") or [])
    admin = get_supabase_admin()
    row = {
        "tutorial_id": tutorial["id"],
        "learner_key": payload.learner_key,
        "learner_label": payload.learner_label,
        "status": AttemptStatus.in_progress.value,
        "steps_completed": 0,
        "steps_total": steps_total,
        "completed_step_indexes": [],
        "verification_result": {},
        "evidence": {},
    }
    created = admin.table("tutorial_attempts").insert(row).execute()
    if not created.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to start attempt",
        )
    return _parse_attempt(created.data[0])


@router.post(
    "/public/tutorials/{slug}/attempts/{attempt_id}/complete",
    response_model=CompleteAttemptResponse,
)
async def complete_attempt(
    slug: str,
    attempt_id: UUID,
    payload: CompleteAttemptRequest,
) -> CompleteAttemptResponse:
    tutorial = _get_published_by_slug(slug)
    row = _get_attempt(attempt_id, UUID(tutorial["id"]))
    if row.get("learner_key") is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Attempt not found")

    criteria = tutorial.get("completion_criteria") or {}
    if not criteria or criteria == {}:
        criteria = default_criteria_from_tutorial(tutorial)

    steps_total = len(tutorial.get("steps") or [])
    completed = sorted(set(int(i) for i in payload.completed_step_indexes))

    file_evidence = {
        "file_path": row.get("evidence_file_path"),
        "file_uploaded": bool(row.get("evidence_file_path")),
        **((row.get("evidence") or {}).get("file") or {}),
    }

    if payload.request_manual_review:
        verification = {
            "passed": False,
            "status": AttemptStatus.pending_review.value,
            "summary": "Learner requested manual review",
            "success_definition": normalize_criteria(criteria)["success_definition"],
            "mode": "manual",
            "checks": [],
            "notes": payload.notes,
        }
        status_value = AttemptStatus.pending_review.value
        method = "manual"
    else:
        verification = await evaluate_attempt(
            criteria=criteria,
            steps_total=steps_total,
            completed_indexes=completed,
            page_evidence=payload.page_evidence or {},
            file_evidence=file_evidence,
        )
        status_value = verification["status"]
        method = verification.get("mode")

    evidence = dict(row.get("evidence") or {})
    if payload.page_evidence:
        evidence["page"] = payload.page_evidence
    if payload.notes:
        evidence["notes"] = payload.notes

    updates = {
        "status": status_value,
        "steps_completed": len(completed),
        "steps_total": steps_total,
        "completed_step_indexes": completed,
        "verification_method": method,
        "verification_result": verification,
        "evidence": evidence,
    }
    admin = get_supabase_admin()
    admin.table("tutorial_attempts").update(updates).eq("id", str(attempt_id)).execute()
    attempt = _parse_attempt(_get_attempt(attempt_id))

    message = {
        AttemptStatus.passed.value: "Passed — task complete.",
        AttemptStatus.needs_retry.value: "Not quite — try again.",
        AttemptStatus.pending_review.value: "Submitted for manual review.",
        AttemptStatus.failed.value: "Failed verification.",
    }.get(status_value, "Attempt saved.")

    return CompleteAttemptResponse(
        attempt=attempt,
        verification=verification,
        message=message,
    )


class FrictionEventRequest(BaseModel):
    learner_key: str = Field(min_length=4, max_length=120)
    step_index: int = Field(ge=0)
    mistake_type: Optional[str] = None
    clicked_summary: Optional[str] = None


@router.post(
    "/public/tutorials/{slug}/attempts/{attempt_id}/friction",
    response_model=Attempt,
)
async def log_friction_event(
    slug: str,
    attempt_id: UUID,
    payload: FrictionEventRequest,
) -> Attempt:
    """Record a mistake/friction signal for dashboard problem-step analytics."""
    tutorial = _get_published_by_slug(slug)
    row = _get_attempt(attempt_id, UUID(tutorial["id"]))
    if row.get("learner_key") != payload.learner_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Learner key mismatch")

    evidence = dict(row.get("evidence") or {})
    friction = list(evidence.get("friction_steps") or [])
    friction.append(
        {
            "step_index": payload.step_index,
            "mistake_type": payload.mistake_type,
            "clicked_summary": payload.clicked_summary,
        }
    )
    evidence["friction_steps"] = friction[-50:]
    admin = get_supabase_admin()
    admin.table("tutorial_attempts").update({"evidence": evidence}).eq(
        "id", str(attempt_id)
    ).execute()
    return _parse_attempt(_get_attempt(attempt_id))


@router.post(
    "/public/tutorials/{slug}/attempts/{attempt_id}/evidence",
    response_model=Attempt,
)
async def upload_attempt_evidence(
    slug: str,
    attempt_id: UUID,
    file: UploadFile = File(...),
    learner_key: str = Form(...),
) -> Attempt:
    tutorial = _get_published_by_slug(slug)
    row = _get_attempt(attempt_id, UUID(tutorial["id"]))
    if row.get("learner_key") != learner_key:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Learner key mismatch")

    criteria = normalize_criteria(tutorial.get("completion_criteria") or {})
    file_cfg = (criteria.get("verification") or {}).get("file") or {}
    content_type = file.content_type or "application/octet-stream"
    data = await file.read()
    if not data:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Empty file")

    max_bytes = int(file_cfg.get("max_bytes") or 10 * 1024 * 1024)
    if len(data) > max_bytes:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="File too large")

    allowed = file_cfg.get("allowed_types")
    if allowed and content_type not in allowed:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported file type {content_type}",
        )

    settings = get_settings()
    bucket = settings.recordings_bucket
    ext = ""
    if file.filename and "." in file.filename:
        ext = "." + file.filename.rsplit(".", 1)[-1].lower()
    path = f"attempts/{tutorial['id']}/{attempt_id}/{uuid.uuid4()}{ext}"

    admin = get_supabase_admin()
    try:
        admin.storage.from_(bucket).upload(
            path=path,
            file=data,
            file_options={"content-type": content_type, "upsert": "false"},
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Evidence upload failed: {exc}",
        ) from exc

    evidence = dict(row.get("evidence") or {})
    evidence["file"] = {
        "file_path": path,
        "file_name": file.filename,
        "content_type": content_type,
        "size_bytes": len(data),
        "bucket": bucket,
        "file_uploaded": True,
    }
    admin.table("tutorial_attempts").update(
        {
            "evidence_file_path": path,
            "evidence": evidence,
        }
    ).eq("id", str(attempt_id)).execute()

    return _parse_attempt(_get_attempt(attempt_id))
