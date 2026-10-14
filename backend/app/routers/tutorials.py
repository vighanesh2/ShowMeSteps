from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query, status

from app.dependencies import CurrentUser
from app.models.schemas import (
    Tutorial,
    TutorialCreate,
    TutorialListResponse,
    TutorialStatus,
    TutorialStep,
    TutorialStepCreate,
    TutorialStepUpdate,
    TutorialUpdate,
)
from app.services.share import share_url_for
from app.services.supabase import get_supabase_admin

router = APIRouter(prefix="/tutorials", tags=["tutorials"])


def _with_share_url(row: dict) -> dict:
    if row.get("share_slug"):
        row["share_url"] = share_url_for(row["share_slug"])
    return row


def _get_owned_tutorial(tutorial_id: UUID, owner_id: UUID) -> dict:
    admin = get_supabase_admin()
    try:
        result = (
            admin.table("tutorials")
            .select("*, steps:tutorial_steps(*)")
            .eq("id", str(tutorial_id))
            .eq("owner_id", str(owner_id))
            .maybe_single()
            .execute()
        )
        data = result.data
    except Exception:
        data = None

    if not data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tutorial not found",
        )
    steps = data.get("steps") or []
    data["steps"] = sorted(steps, key=lambda s: s.get("order_index", 0))
    return _with_share_url(data)


@router.get("", response_model=TutorialListResponse)
async def list_tutorials(
    current_user: CurrentUser,
    status_filter: Optional[TutorialStatus] = Query(default=None, alias="status"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> TutorialListResponse:
    admin = get_supabase_admin()
    query = (
        admin.table("tutorials")
        .select("*, steps:tutorial_steps(*)", count="exact")
        .eq("owner_id", str(current_user.id))
        .order("updated_at", desc=True)
        .range(offset, offset + limit - 1)
    )
    if status_filter is not None:
        query = query.eq("status", status_filter.value)

    result = query.execute()
    items = []
    for row in result.data or []:
        steps = row.get("steps") or []
        row["steps"] = sorted(steps, key=lambda s: s.get("order_index", 0))
        items.append(Tutorial.model_validate(_with_share_url(row)))

    return TutorialListResponse(items=items, count=result.count or len(items))


@router.post("", response_model=Tutorial, status_code=status.HTTP_201_CREATED)
async def create_tutorial(
    payload: TutorialCreate,
    current_user: CurrentUser,
) -> Tutorial:
    admin = get_supabase_admin()
    tutorial_row = {
        "title": payload.title,
        "description": payload.description,
        "status": payload.status.value,
        "owner_id": str(current_user.id),
    }
    created = admin.table("tutorials").insert(tutorial_row).execute()
    if not created.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create tutorial",
        )

    tutorial = created.data[0]
    tutorial_id = tutorial["id"]

    steps: list[dict] = []
    if payload.steps:
        step_rows = [
            {
                "tutorial_id": tutorial_id,
                "title": step.title,
                "description": step.description,
                "order_index": step.order_index,
                "screenshot_path": step.screenshot_path,
                "metadata": step.metadata,
            }
            for step in payload.steps
        ]
        steps_result = admin.table("tutorial_steps").insert(step_rows).execute()
        steps = steps_result.data or []

    tutorial["steps"] = sorted(steps, key=lambda s: s.get("order_index", 0))
    return Tutorial.model_validate(tutorial)


@router.get("/{tutorial_id}", response_model=Tutorial)
async def get_tutorial(tutorial_id: UUID, current_user: CurrentUser) -> Tutorial:
    data = _get_owned_tutorial(tutorial_id, current_user.id)
    return Tutorial.model_validate(data)


@router.patch("/{tutorial_id}", response_model=Tutorial)
async def update_tutorial(
    tutorial_id: UUID,
    payload: TutorialUpdate,
    current_user: CurrentUser,
) -> Tutorial:
    _get_owned_tutorial(tutorial_id, current_user.id)
    updates = payload.model_dump(exclude_unset=True)
    if "status" in updates and updates["status"] is not None:
        updates["status"] = updates["status"].value if hasattr(updates["status"], "value") else updates["status"]

    if not updates:
        return Tutorial.model_validate(_get_owned_tutorial(tutorial_id, current_user.id))

    admin = get_supabase_admin()
    admin.table("tutorials").update(updates).eq("id", str(tutorial_id)).execute()
    return Tutorial.model_validate(_get_owned_tutorial(tutorial_id, current_user.id))


@router.delete("/{tutorial_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tutorial(tutorial_id: UUID, current_user: CurrentUser) -> None:
    _get_owned_tutorial(tutorial_id, current_user.id)
    admin = get_supabase_admin()
    admin.table("tutorials").delete().eq("id", str(tutorial_id)).execute()


@router.post(
    "/{tutorial_id}/steps",
    response_model=TutorialStep,
    status_code=status.HTTP_201_CREATED,
)
async def add_step(
    tutorial_id: UUID,
    payload: TutorialStepCreate,
    current_user: CurrentUser,
) -> TutorialStep:
    _get_owned_tutorial(tutorial_id, current_user.id)
    admin = get_supabase_admin()
    row = {
        "tutorial_id": str(tutorial_id),
        "title": payload.title,
        "description": payload.description,
        "order_index": payload.order_index,
        "screenshot_path": payload.screenshot_path,
        "metadata": payload.metadata,
    }
    result = admin.table("tutorial_steps").insert(row).execute()
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create step",
        )
    return TutorialStep.model_validate(result.data[0])


@router.patch("/{tutorial_id}/steps/{step_id}", response_model=TutorialStep)
async def update_step(
    tutorial_id: UUID,
    step_id: UUID,
    payload: TutorialStepUpdate,
    current_user: CurrentUser,
) -> TutorialStep:
    _get_owned_tutorial(tutorial_id, current_user.id)
    updates = payload.model_dump(exclude_unset=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    admin = get_supabase_admin()
    result = (
        admin.table("tutorial_steps")
        .update(updates)
        .eq("id", str(step_id))
        .eq("tutorial_id", str(tutorial_id))
        .execute()
    )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Step not found",
        )
    return TutorialStep.model_validate(result.data[0])


@router.delete(
    "/{tutorial_id}/steps/{step_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_step(
    tutorial_id: UUID,
    step_id: UUID,
    current_user: CurrentUser,
) -> None:
    _get_owned_tutorial(tutorial_id, current_user.id)
    admin = get_supabase_admin()
    result = (
        admin.table("tutorial_steps")
        .delete()
        .eq("id", str(step_id))
        .eq("tutorial_id", str(tutorial_id))
        .execute()
    )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Step not found",
        )
