"""Share slug helpers for published tutorials."""

from __future__ import annotations

import re
import secrets
from typing import Any, Optional
from uuid import UUID

from app.config import get_settings
from app.services.supabase import get_supabase_admin

_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def make_share_slug(title: Optional[str] = None) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (title or "tutorial").lower()).strip("-")
    base = (base[:24] or "tutorial").rstrip("-")
    suffix = secrets.token_urlsafe(4).lower().replace("_", "").replace("-", "")[:6]
    return f"{base}-{suffix}"


def share_url_for(slug: str) -> str:
    settings = get_settings()
    return f"{settings.public_app_url.rstrip('/')}/t/{slug}"


def ensure_share_slug(tutorial_id: UUID, title: Optional[str] = None) -> str:
    admin = get_supabase_admin()
    existing = (
        admin.table("tutorials")
        .select("share_slug, title")
        .eq("id", str(tutorial_id))
        .limit(1)
        .execute()
    )
    row = (existing.data or [None])[0] or {}
    if row.get("share_slug"):
        return row["share_slug"]

    for _ in range(5):
        slug = make_share_slug(title or row.get("title"))
        try:
            admin.table("tutorials").update({"share_slug": slug}).eq(
                "id", str(tutorial_id)
            ).execute()
            return slug
        except Exception:
            continue

    slug = f"tutorial-{secrets.token_hex(4)}"
    admin.table("tutorials").update({"share_slug": slug}).eq(
        "id", str(tutorial_id)
    ).execute()
    return slug


def start_url_from_tutorial(tutorial: dict[str, Any]) -> Optional[str]:
    """Pick a launch URL from the first step that has one."""
    steps = sorted(tutorial.get("steps") or [], key=lambda s: s.get("order_index", 0))
    candidates: list[str] = []
    for step in steps:
        meta = step.get("metadata") or {}
        for key in ("url", "from", "to"):
            value = meta.get(key)
            if isinstance(value, str) and value.startswith("http"):
                candidates.append(value)
        el = meta.get("element") or {}
        href = el.get("href")
        if isinstance(href, str) and href.startswith("http"):
            candidates.append(href)

    if not candidates:
        return None

    # Prefer a site home/search page over a deep profile URL when the flow
    # later visits results/search (common for YouTube-style tutorials).
    later = " ".join(candidates[1:]).lower()
    first = candidates[0]
    if any(token in later for token in ("/results", "search_query", "/search")):
        try:
            from urllib.parse import urlsplit

            parts = urlsplit(first)
            if parts.netloc:
                return f"{parts.scheme}://{parts.netloc}/"
        except Exception:
            pass
    return first


def is_valid_slug(slug: str) -> bool:
    return bool(slug) and len(slug) <= 64 and bool(_SLUG_RE.match(slug) or re.match(r"^[\w-]+$", slug))
