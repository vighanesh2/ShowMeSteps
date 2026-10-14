"""Creator dashboard: tutorials + learner analytics."""

from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.dependencies import CurrentUser
from app.services.share import ensure_share_slug, share_url_for
from app.services.supabase import get_supabase_admin

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


class ProblemStep(BaseModel):
    order_index: int
    title: str
    stuck_count: int
    friction_count: int = 0


class VerificationBreakdown(BaseModel):
    in_progress: int = 0
    passed: int = 0
    needs_retry: int = 0
    pending_review: int = 0
    failed: int = 0


class LearnerProgressRow(BaseModel):
    attempt_id: UUID
    learner_key: str
    learner_label: Optional[str] = None
    status: str
    steps_completed: int
    steps_total: int
    verification_summary: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class TutorialDashboardCard(BaseModel):
    id: UUID
    title: str
    description: Optional[str] = None
    status: str
    share_slug: Optional[str] = None
    share_url: Optional[str] = None
    step_count: int
    updated_at: Optional[str] = None
    started: int = 0
    finished: int = 0
    passed: int = 0
    completion_rate: float = 0.0
    verification: VerificationBreakdown
    problem_steps: list[ProblemStep] = Field(default_factory=list)
    recent_attempts: list[LearnerProgressRow] = Field(default_factory=list)


class DashboardResponse(BaseModel):
    tutorials: list[TutorialDashboardCard]
    totals: dict[str, Any]


def _indexes(value: Any) -> list[int]:
    if not isinstance(value, list):
        return []
    out = []
    for item in value:
        try:
            out.append(int(item))
        except (TypeError, ValueError):
            continue
    return out


def _stuck_step(completed: list[int], steps_total: int) -> Optional[int]:
    if steps_total <= 0:
        return None
    done = set(completed)
    for i in range(steps_total):
        if i not in done:
            return i
    return None


def _friction_counts(evidence: Any) -> Counter:
    counts: Counter = Counter()
    if not isinstance(evidence, dict):
        return counts
    friction = evidence.get("friction_steps") or evidence.get("mistakes") or []
    if isinstance(friction, list):
        for item in friction:
            try:
                if isinstance(item, dict):
                    counts[int(item.get("step_index"))] += 1
                else:
                    counts[int(item)] += 1
            except (TypeError, ValueError):
                continue
    return counts


@router.get("", response_model=DashboardResponse)
async def get_dashboard(current_user: CurrentUser) -> DashboardResponse:
    admin = get_supabase_admin()
    tutorials_result = (
        admin.table("tutorials")
        .select("*, steps:tutorial_steps(id, title, order_index)")
        .eq("owner_id", str(current_user.id))
        .order("updated_at", desc=True)
        .execute()
    )
    tutorials = tutorials_result.data or []
    tutorial_ids = [t["id"] for t in tutorials]

    attempts_by_tutorial: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if tutorial_ids:
        attempts_result = (
            admin.table("tutorial_attempts")
            .select("*")
            .in_("tutorial_id", tutorial_ids)
            .order("created_at", desc=True)
            .execute()
        )
        for row in attempts_result.data or []:
            attempts_by_tutorial[row["tutorial_id"]].append(row)

    cards: list[TutorialDashboardCard] = []
    total_started = total_finished = total_passed = 0

    for tutorial in tutorials:
        steps = sorted(tutorial.get("steps") or [], key=lambda s: s.get("order_index", 0))
        step_titles = {
            int(s.get("order_index", idx)): s.get("title") or f"Step {idx + 1}"
            for idx, s in enumerate(steps)
        }
        steps_total = len(steps)
        attempts = attempts_by_tutorial.get(tutorial["id"], [])

        verification = VerificationBreakdown()
        stuck_counter: Counter = Counter()
        friction_counter: Counter = Counter()
        recent: list[LearnerProgressRow] = []

        started = len(attempts)
        finished = 0
        passed = 0

        for attempt in attempts:
            status = attempt.get("status") or "in_progress"
            if hasattr(verification, status):
                setattr(verification, status, getattr(verification, status) + 1)
            elif status == "in_progress":
                verification.in_progress += 1

            completed = _indexes(attempt.get("completed_step_indexes"))
            if status in {"passed", "needs_retry", "pending_review", "failed"}:
                finished += 1
            if status == "passed":
                passed += 1

            friction_counter.update(_friction_counts(attempt.get("evidence")))

            if status in {"in_progress", "needs_retry", "failed"}:
                stuck = _stuck_step(completed, steps_total or int(attempt.get("steps_total") or 0))
                if stuck is not None:
                    stuck_counter[stuck] += 1

            if len(recent) < 8:
                vr = attempt.get("verification_result") or {}
                recent.append(
                    LearnerProgressRow(
                        attempt_id=attempt["id"],
                        learner_key=attempt.get("learner_key") or "",
                        learner_label=attempt.get("learner_label"),
                        status=status,
                        steps_completed=int(attempt.get("steps_completed") or len(completed)),
                        steps_total=int(attempt.get("steps_total") or steps_total),
                        verification_summary=vr.get("summary") or vr.get("message"),
                        created_at=attempt.get("created_at"),
                        updated_at=attempt.get("updated_at"),
                    )
                )

        problem_steps = []
        all_problem_indexes = set(stuck_counter) | set(friction_counter)
        for idx in sorted(all_problem_indexes):
            problem_steps.append(
                ProblemStep(
                    order_index=idx,
                    title=step_titles.get(idx, f"Step {idx + 1}"),
                    stuck_count=int(stuck_counter.get(idx, 0)),
                    friction_count=int(friction_counter.get(idx, 0)),
                )
            )
        problem_steps.sort(
            key=lambda p: (p.stuck_count + p.friction_count, p.order_index),
            reverse=True,
        )

        slug = tutorial.get("share_slug")
        share = share_url_for(slug) if slug else None
        completion_rate = round((passed / started) * 100, 1) if started else 0.0

        total_started += started
        total_finished += finished
        total_passed += passed

        cards.append(
            TutorialDashboardCard(
                id=tutorial["id"],
                title=tutorial.get("title") or "Untitled",
                description=tutorial.get("description"),
                status=tutorial.get("status") or "draft",
                share_slug=slug,
                share_url=share,
                step_count=steps_total,
                updated_at=tutorial.get("updated_at"),
                started=started,
                finished=finished,
                passed=passed,
                completion_rate=completion_rate,
                verification=verification,
                problem_steps=problem_steps[:5],
                recent_attempts=recent,
            )
        )

    return DashboardResponse(
        tutorials=cards,
        totals={
            "tutorial_count": len(cards),
            "started": total_started,
            "finished": total_finished,
            "passed": total_passed,
            "published": sum(1 for c in cards if c.status == "published"),
            "drafts": sum(1 for c in cards if c.status == "draft"),
        },
    )


class PublishActionResponse(BaseModel):
    id: UUID
    status: str
    share_slug: Optional[str] = None
    share_url: Optional[str] = None
    message: str


@router.post("/tutorials/{tutorial_id}/publish", response_model=PublishActionResponse)
async def publish_from_dashboard(
    tutorial_id: UUID,
    current_user: CurrentUser,
) -> PublishActionResponse:
    admin = get_supabase_admin()
    owned = (
        admin.table("tutorials")
        .select("id, title, owner_id, status, share_slug")
        .eq("id", str(tutorial_id))
        .eq("owner_id", str(current_user.id))
        .limit(1)
        .execute()
    )
    row = (owned.data or [None])[0]
    if not row:
        from fastapi import HTTPException, status

        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tutorial not found")

    admin.table("tutorials").update({"status": "published"}).eq(
        "id", str(tutorial_id)
    ).execute()
    slug = ensure_share_slug(tutorial_id, row.get("title"))
    url = share_url_for(slug)
    return PublishActionResponse(
        id=tutorial_id,
        status="published",
        share_slug=slug,
        share_url=url,
        message="Tutorial published.",
    )


@router.post("/tutorials/{tutorial_id}/unpublish", response_model=PublishActionResponse)
async def unpublish_from_dashboard(
    tutorial_id: UUID,
    current_user: CurrentUser,
) -> PublishActionResponse:
    admin = get_supabase_admin()
    owned = (
        admin.table("tutorials")
        .select("id, share_slug")
        .eq("id", str(tutorial_id))
        .eq("owner_id", str(current_user.id))
        .limit(1)
        .execute()
    )
    row = (owned.data or [None])[0]
    if not row:
        from fastapi import HTTPException, status

        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tutorial not found")

    admin.table("tutorials").update({"status": "draft"}).eq("id", str(tutorial_id)).execute()
    slug = row.get("share_slug")
    return PublishActionResponse(
        id=tutorial_id,
        status="draft",
        share_slug=slug,
        share_url=share_url_for(slug) if slug else None,
        message="Tutorial unpublished (draft).",
    )
