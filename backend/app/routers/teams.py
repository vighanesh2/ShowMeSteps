"""Business teams, membership, and tutorial assignments."""

from __future__ import annotations

import re
import secrets
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, EmailStr, Field

from app.dependencies import CurrentUser
from app.services.share import share_url_for
from app.services.supabase import get_supabase_admin

router = APIRouter(prefix="/teams", tags=["teams"])


class TeamPrivacySettings(BaseModel):
    hide_learner_emails_from_members: bool = True
    retain_attempts_days: int = Field(default=365, ge=30, le=3650)
    allow_ai_coaching: bool = True


class CreateTeamRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    privacy_settings: Optional[TeamPrivacySettings] = None


class TeamMemberOut(BaseModel):
    id: UUID
    email: str
    role: str
    status: str
    user_id: Optional[UUID] = None


class TeamOut(BaseModel):
    id: UUID
    name: str
    slug: str
    owner_id: UUID
    privacy_settings: dict[str, Any] = Field(default_factory=dict)
    members: list[TeamMemberOut] = Field(default_factory=list)
    my_role: Optional[str] = None


class InviteMemberRequest(BaseModel):
    email: EmailStr
    role: str = Field(default="member", pattern="^(admin|member)$")


class AssignTutorialRequest(BaseModel):
    tutorial_id: UUID
    assignee_emails: list[EmailStr] = Field(min_length=1)
    due_at: Optional[datetime] = None
    notes: Optional[str] = Field(default=None, max_length=1000)


class AssignmentOut(BaseModel):
    id: UUID
    team_id: UUID
    tutorial_id: UUID
    tutorial_title: Optional[str] = None
    share_url: Optional[str] = None
    assignee_email: str
    assignee_user_id: Optional[UUID] = None
    status: str
    due_at: Optional[datetime] = None
    notes: Optional[str] = None
    created_at: Optional[datetime] = None


def _slugify(name: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "team"
    return f"{base}-{secrets.token_hex(2)}"


def _require_team_admin(team_id: UUID, user_id: UUID) -> dict[str, Any]:
    admin = get_supabase_admin()
    team = (
        admin.table("teams")
        .select("*")
        .eq("id", str(team_id))
        .limit(1)
        .execute()
    )
    row = (team.data or [None])[0]
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Team not found")

    member = (
        admin.table("team_members")
        .select("*")
        .eq("team_id", str(team_id))
        .eq("user_id", str(user_id))
        .eq("status", "active")
        .limit(1)
        .execute()
    )
    m = (member.data or [None])[0]
    if not m or m.get("role") not in {"owner", "admin"}:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return row


def _membership(team_id: UUID, user_id: UUID) -> Optional[dict[str, Any]]:
    admin = get_supabase_admin()
    result = (
        admin.table("team_members")
        .select("*")
        .eq("team_id", str(team_id))
        .eq("user_id", str(user_id))
        .eq("status", "active")
        .limit(1)
        .execute()
    )
    return (result.data or [None])[0]


def _find_user_id_by_email(email: str) -> Optional[str]:
    admin = get_supabase_admin()
    target = email.lower()
    try:
        listed = admin.auth.admin.list_users()
        users = getattr(listed, "users", None) or listed or []
        for user in users:
            if (getattr(user, "email", None) or "").lower() == target:
                return str(user.id)
    except Exception:
        pass
    return None


def _team_out(team: dict[str, Any], current_user_id: UUID) -> TeamOut:
    admin = get_supabase_admin()
    members = (
        admin.table("team_members")
        .select("*")
        .eq("team_id", team["id"])
        .neq("status", "removed")
        .execute()
    )
    privacy = team.get("privacy_settings") or {}
    hide_emails = privacy.get("hide_learner_emails_from_members", True)
    my = _membership(UUID(team["id"]), current_user_id)
    my_role = my.get("role") if my else None
    is_admin = my_role in {"owner", "admin"}

    member_rows = []
    for m in members.data or []:
        email = m.get("email") or ""
        if hide_emails and not is_admin and m.get("user_id") != str(current_user_id):
            local, _, domain = email.partition("@")
            email = f"{local[:1]}***@{domain}" if domain else "***"
        member_rows.append(
            TeamMemberOut(
                id=m["id"],
                email=email,
                role=m.get("role") or "member",
                status=m.get("status") or "invited",
                user_id=m.get("user_id"),
            )
        )

    return TeamOut(
        id=team["id"],
        name=team["name"],
        slug=team["slug"],
        owner_id=team["owner_id"],
        privacy_settings=privacy,
        members=member_rows,
        my_role=my_role,
    )


@router.post("", response_model=TeamOut, status_code=status.HTTP_201_CREATED)
async def create_team(payload: CreateTeamRequest, current_user: CurrentUser) -> TeamOut:
    admin = get_supabase_admin()
    privacy = (payload.privacy_settings or TeamPrivacySettings()).model_dump()
    row = {
        "name": payload.name.strip(),
        "slug": _slugify(payload.name),
        "owner_id": str(current_user.id),
        "privacy_settings": privacy,
    }
    created = admin.table("teams").insert(row).execute()
    if not created.data:
        raise HTTPException(status_code=500, detail="Failed to create team")
    team = created.data[0]
    admin.table("team_members").insert(
        {
            "team_id": team["id"],
            "user_id": str(current_user.id),
            "email": current_user.email,
            "role": "owner",
            "status": "active",
            "invited_by": str(current_user.id),
        }
    ).execute()
    return _team_out(team, current_user.id)


@router.get("", response_model=list[TeamOut])
async def list_teams(current_user: CurrentUser) -> list[TeamOut]:
    admin = get_supabase_admin()
    memberships = (
        admin.table("team_members")
        .select("team_id")
        .eq("user_id", str(current_user.id))
        .eq("status", "active")
        .execute()
    )
    ids = [m["team_id"] for m in memberships.data or []]
    if not ids:
        return []
    teams = admin.table("teams").select("*").in_("id", ids).order("created_at", desc=True).execute()
    return [_team_out(t, current_user.id) for t in teams.data or []]


@router.get("/me/assignments", response_model=list[AssignmentOut])
async def my_assignments(current_user: CurrentUser) -> list[AssignmentOut]:
    admin = get_supabase_admin()
    # Activate invited memberships matching this email
    try:
        admin.table("team_members").update(
            {"user_id": str(current_user.id), "status": "active"}
        ).eq("email", current_user.email.lower()).eq("status", "invited").execute()
    except Exception:
        pass

    result = (
        admin.table("tutorial_assignments")
        .select("*")
        .or_(
            f"assignee_user_id.eq.{current_user.id},"
            f"assignee_email.eq.{current_user.email.lower()}"
        )
        .neq("status", "cancelled")
        .order("created_at", desc=True)
        .execute()
    )

    tutorial_ids = list({r["tutorial_id"] for r in result.data or []})
    titles: dict[str, dict[str, Any]] = {}
    if tutorial_ids:
        tuts = (
            admin.table("tutorials")
            .select("id, title, share_slug")
            .in_("id", tutorial_ids)
            .execute()
        )
        for t in tuts.data or []:
            titles[t["id"]] = t

    out = []
    for row in result.data or []:
        t = titles.get(row["tutorial_id"]) or {}
        out.append(
            AssignmentOut(
                id=row["id"],
                team_id=row["team_id"],
                tutorial_id=row["tutorial_id"],
                tutorial_title=t.get("title"),
                share_url=share_url_for(t["share_slug"]) if t.get("share_slug") else None,
                assignee_email=row["assignee_email"],
                assignee_user_id=row.get("assignee_user_id"),
                status=row["status"],
                due_at=row.get("due_at"),
                notes=row.get("notes"),
                created_at=row.get("created_at"),
            )
        )
    return out


@router.get("/{team_id}", response_model=TeamOut)
async def get_team(team_id: UUID, current_user: CurrentUser) -> TeamOut:
    if not _membership(team_id, current_user.id):
        raise HTTPException(status_code=404, detail="Team not found")
    admin = get_supabase_admin()
    result = admin.table("teams").select("*").eq("id", str(team_id)).limit(1).execute()
    row = (result.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Team not found")
    return _team_out(row, current_user.id)


@router.patch("/{team_id}/privacy", response_model=TeamOut)
async def update_privacy(
    team_id: UUID,
    payload: TeamPrivacySettings,
    current_user: CurrentUser,
) -> TeamOut:
    team = _require_team_admin(team_id, current_user.id)
    admin = get_supabase_admin()
    admin.table("teams").update({"privacy_settings": payload.model_dump()}).eq(
        "id", str(team_id)
    ).execute()
    team["privacy_settings"] = payload.model_dump()
    return _team_out(team, current_user.id)


@router.post("/{team_id}/members", response_model=TeamMemberOut, status_code=201)
async def invite_member(
    team_id: UUID,
    payload: InviteMemberRequest,
    current_user: CurrentUser,
) -> TeamMemberOut:
    _require_team_admin(team_id, current_user.id)
    email = str(payload.email).lower()
    user_id = _find_user_id_by_email(email)
    admin = get_supabase_admin()
    row = {
        "team_id": str(team_id),
        "email": email,
        "role": payload.role,
        "status": "active" if user_id else "invited",
        "user_id": user_id,
        "invited_by": str(current_user.id),
    }
    # Upsert-ish: delete removed then insert, or update existing
    existing = (
        admin.table("team_members")
        .select("*")
        .eq("team_id", str(team_id))
        .eq("email", email)
        .limit(1)
        .execute()
    )
    if existing.data:
        updated = (
            admin.table("team_members")
            .update(
                {
                    "role": payload.role,
                    "status": "active" if user_id else "invited",
                    "user_id": user_id,
                }
            )
            .eq("id", existing.data[0]["id"])
            .execute()
        )
        m = updated.data[0]
    else:
        created = admin.table("team_members").insert(row).execute()
        if not created.data:
            raise HTTPException(status_code=500, detail="Failed to invite member")
        m = created.data[0]
    return TeamMemberOut(
        id=m["id"],
        email=m["email"],
        role=m["role"],
        status=m["status"],
        user_id=m.get("user_id"),
    )


@router.post("/{team_id}/assignments", response_model=list[AssignmentOut], status_code=201)
async def assign_tutorial(
    team_id: UUID,
    payload: AssignTutorialRequest,
    current_user: CurrentUser,
) -> list[AssignmentOut]:
    _require_team_admin(team_id, current_user.id)
    admin = get_supabase_admin()

    tutorial = (
        admin.table("tutorials")
        .select("id, title, share_slug, owner_id, status")
        .eq("id", str(payload.tutorial_id))
        .limit(1)
        .execute()
    )
    trow = (tutorial.data or [None])[0]
    if not trow:
        raise HTTPException(status_code=404, detail="Tutorial not found")
    # Only assign tutorials owned by an admin of the team (creator)
    if trow.get("owner_id") != str(current_user.id):
        # Allow if current user is team admin and tutorial owner is on the team
        owner_member = (
            admin.table("team_members")
            .select("id")
            .eq("team_id", str(team_id))
            .eq("user_id", trow["owner_id"])
            .eq("status", "active")
            .limit(1)
            .execute()
        )
        if not owner_member.data and trow.get("owner_id") != str(current_user.id):
            raise HTTPException(
                status_code=403,
                detail="You can only assign tutorials owned by your team",
            )

    share = share_url_for(trow["share_slug"]) if trow.get("share_slug") else None
    created_rows: list[AssignmentOut] = []
    for email in payload.assignee_emails:
        email_l = str(email).lower()
        user_id = _find_user_id_by_email(email_l)
        # Ensure they are a team member (invite if needed)
        existing_member = (
            admin.table("team_members")
            .select("*")
            .eq("team_id", str(team_id))
            .eq("email", email_l)
            .limit(1)
            .execute()
        )
        if not existing_member.data:
            admin.table("team_members").insert(
                {
                    "team_id": str(team_id),
                    "email": email_l,
                    "role": "member",
                    "status": "active" if user_id else "invited",
                    "user_id": user_id,
                    "invited_by": str(current_user.id),
                }
            ).execute()

        inserted = (
            admin.table("tutorial_assignments")
            .insert(
                {
                    "team_id": str(team_id),
                    "tutorial_id": str(payload.tutorial_id),
                    "assignee_email": email_l,
                    "assignee_user_id": user_id,
                    "assigned_by": str(current_user.id),
                    "status": "assigned",
                    "due_at": payload.due_at.isoformat() if payload.due_at else None,
                    "notes": payload.notes,
                }
            )
            .execute()
        )
        if not inserted.data:
            continue
        row = inserted.data[0]
        created_rows.append(
            AssignmentOut(
                id=row["id"],
                team_id=row["team_id"],
                tutorial_id=row["tutorial_id"],
                tutorial_title=trow.get("title"),
                share_url=share,
                assignee_email=row["assignee_email"],
                assignee_user_id=row.get("assignee_user_id"),
                status=row["status"],
                due_at=row.get("due_at"),
                notes=row.get("notes"),
                created_at=row.get("created_at"),
            )
        )
    return created_rows


@router.get("/{team_id}/assignments", response_model=list[AssignmentOut])
async def list_team_assignments(
    team_id: UUID,
    current_user: CurrentUser,
) -> list[AssignmentOut]:
    _require_team_admin(team_id, current_user.id)
    admin = get_supabase_admin()
    result = (
        admin.table("tutorial_assignments")
        .select("*")
        .eq("team_id", str(team_id))
        .order("created_at", desc=True)
        .execute()
    )
    tutorial_ids = list({r["tutorial_id"] for r in result.data or []})
    titles: dict[str, dict[str, Any]] = {}
    if tutorial_ids:
        tuts = (
            admin.table("tutorials")
            .select("id, title, share_slug")
            .in_("id", tutorial_ids)
            .execute()
        )
        for t in tuts.data or []:
            titles[t["id"]] = t

    out = []
    for row in result.data or []:
        t = titles.get(row["tutorial_id"]) or {}
        out.append(
            AssignmentOut(
                id=row["id"],
                team_id=row["team_id"],
                tutorial_id=row["tutorial_id"],
                tutorial_title=t.get("title"),
                share_url=share_url_for(t["share_slug"]) if t.get("share_slug") else None,
                assignee_email=row["assignee_email"],
                assignee_user_id=row.get("assignee_user_id"),
                status=row["status"],
                due_at=row.get("due_at"),
                notes=row.get("notes"),
                created_at=row.get("created_at"),
            )
        )
    return out


@router.post("/assignments/{assignment_id}/complete", response_model=AssignmentOut)
async def mark_assignment_complete(
    assignment_id: UUID,
    current_user: CurrentUser,
) -> AssignmentOut:
    admin = get_supabase_admin()
    result = (
        admin.table("tutorial_assignments")
        .select("*")
        .eq("id", str(assignment_id))
        .limit(1)
        .execute()
    )
    row = (result.data or [None])[0]
    if not row:
        raise HTTPException(status_code=404, detail="Assignment not found")
    if row.get("assignee_user_id") not in (None, str(current_user.id)) and row.get(
        "assignee_email", ""
    ).lower() != current_user.email.lower():
        raise HTTPException(status_code=403, detail="Not your assignment")

    updated = (
        admin.table("tutorial_assignments")
        .update(
            {
                "status": "completed",
                "completed_at": datetime.now(timezone.utc).isoformat(),
                "assignee_user_id": str(current_user.id),
            }
        )
        .eq("id", str(assignment_id))
        .execute()
    )
    row = updated.data[0]
    tut = (
        admin.table("tutorials")
        .select("title, share_slug")
        .eq("id", row["tutorial_id"])
        .limit(1)
        .execute()
    )
    t = (tut.data or [{}])[0]
    return AssignmentOut(
        id=row["id"],
        team_id=row["team_id"],
        tutorial_id=row["tutorial_id"],
        tutorial_title=t.get("title"),
        share_url=share_url_for(t["share_slug"]) if t.get("share_slug") else None,
        assignee_email=row["assignee_email"],
        assignee_user_id=row.get("assignee_user_id"),
        status=row["status"],
        due_at=row.get("due_at"),
        notes=row.get("notes"),
        created_at=row.get("created_at"),
    )
