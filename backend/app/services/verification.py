"""Evaluate tutorial completion criteria and build default definitions."""

from __future__ import annotations

import re
from typing import Any, Optional
from urllib.parse import urlsplit

import httpx

DEFAULT_CRITERIA = {
    "success_definition": "Complete every guided step",
    "require_all_steps": True,
    "required_step_indexes": None,
    "verification": {
        "mode": "steps_only",
        "manual_review_fallback": True,
        "page_check": None,
        "api": None,
        "file": None,
    },
}


def default_criteria_from_tutorial(tutorial: dict[str, Any]) -> dict[str, Any]:
    """Infer a sensible success definition from the last step."""
    steps = sorted(tutorial.get("steps") or [], key=lambda s: s.get("order_index", 0))
    criteria = {
        "success_definition": f"Finish “{tutorial.get('title') or 'the tutorial'}” by completing all steps",
        "require_all_steps": True,
        "required_step_indexes": None,
        "verification": {
            "mode": "steps_only",
            "manual_review_fallback": True,
            "page_check": None,
            "api": None,
            "file": None,
        },
    }
    if not steps:
        return criteria

    last = steps[-1]
    meta = last.get("metadata") or {}
    url = meta.get("to") or meta.get("url")
    el = meta.get("element") or {}
    page_check: dict[str, Any] = {}

    if isinstance(url, str) and url.startswith("http"):
        parts = urlsplit(url)
        # Prefer a stable path fragment over full query strings
        if parts.path and parts.path not in ("", "/"):
            page_check["url_contains"] = parts.path
        else:
            page_check["url_contains"] = parts.netloc

    text = (el.get("text") or el.get("ariaLabel") or "").strip()
    if text:
        page_check["selector_text_contains"] = text[:80]
        if el.get("cssSelector"):
            page_check["selector_exists"] = el["cssSelector"]

    if page_check:
        criteria["verification"]["mode"] = "page_check"
        criteria["verification"]["page_check"] = page_check
        criteria["success_definition"] = (
            f"Complete all steps and end on the correct page"
            + (f" (URL contains “{page_check.get('url_contains')}”)" if page_check.get("url_contains") else "")
        )
    else:
        criteria["success_definition"] = (
            f"Complete all steps, ending with: {last.get('title') or 'the final step'}"
        )
    return criteria


def normalize_criteria(raw: Optional[dict[str, Any]]) -> dict[str, Any]:
    base = {
        "success_definition": DEFAULT_CRITERIA["success_definition"],
        "require_all_steps": True,
        "required_step_indexes": None,
        "verification": {
            "mode": "steps_only",
            "manual_review_fallback": True,
            "page_check": None,
            "api": None,
            "file": None,
        },
    }
    if not raw:
        return base
    base["success_definition"] = str(
        raw.get("success_definition") or base["success_definition"]
    )[:500]
    base["require_all_steps"] = bool(raw.get("require_all_steps", True))
    req = raw.get("required_step_indexes")
    if isinstance(req, list):
        base["required_step_indexes"] = [int(i) for i in req]
    ver_in = raw.get("verification") or {}
    mode = str(ver_in.get("mode") or "steps_only")
    if mode not in {"steps_only", "page_check", "api", "file", "manual"}:
        mode = "steps_only"
    base["verification"]["mode"] = mode
    base["verification"]["manual_review_fallback"] = bool(
        ver_in.get("manual_review_fallback", True)
    )
    if isinstance(ver_in.get("page_check"), dict):
        base["verification"]["page_check"] = ver_in["page_check"]
    if isinstance(ver_in.get("api"), dict):
        # Do not expose secrets in public responses — stored server-side only
        base["verification"]["api"] = ver_in["api"]
    if isinstance(ver_in.get("file"), dict):
        base["verification"]["file"] = ver_in["file"]
    return base


def public_criteria_view(criteria: dict[str, Any]) -> dict[str, Any]:
    """Strip secrets before sending criteria to the extension / learners."""
    normalized = normalize_criteria(criteria)
    ver = normalized["verification"]
    api = ver.get("api")
    safe_api = None
    if isinstance(api, dict):
        safe_api = {
            "configured": True,
            "method": api.get("method") or "GET",
        }
    return {
        "success_definition": normalized["success_definition"],
        "require_all_steps": normalized["require_all_steps"],
        "required_step_indexes": normalized["required_step_indexes"],
        "verification": {
            "mode": ver["mode"],
            "manual_review_fallback": ver["manual_review_fallback"],
            "page_check": ver.get("page_check"),
            "api": safe_api,
            "file": ver.get("file"),
        },
    }


def steps_satisfied(
    *,
    criteria: dict[str, Any],
    completed_indexes: list[int],
    steps_total: int,
) -> tuple[bool, str]:
    crit = normalize_criteria(criteria)
    completed = set(int(i) for i in completed_indexes)
    if crit["require_all_steps"] or not crit.get("required_step_indexes"):
        needed = set(range(steps_total))
    else:
        needed = set(int(i) for i in crit["required_step_indexes"])
    missing = sorted(needed - completed)
    if missing:
        return False, f"Missing required step(s): {', '.join(str(i + 1) for i in missing)}"
    return True, "All required steps completed"


def evaluate_page_check(
    page_check: Optional[dict[str, Any]],
    evidence: dict[str, Any],
) -> tuple[bool, str]:
    if not page_check:
        return True, "No page check configured"
    url = evidence.get("url") or ""
    if contains := page_check.get("url_contains"):
        if str(contains) not in url:
            return False, f"URL does not contain “{contains}”"
    if regex := page_check.get("url_regex"):
        try:
            if not re.search(str(regex), url):
                return False, "URL did not match the expected pattern"
        except re.error:
            return False, "Invalid URL regex in completion criteria"
    if page_check.get("selector_exists"):
        if not evidence.get("selector_exists"):
            return False, "Expected page element was not found"
    if text := page_check.get("selector_text_contains"):
        hay = (evidence.get("selector_text") or "").lower()
        if str(text).lower() not in hay:
            return False, f"Page text did not include “{text}”"
    return True, "Page checks passed"


async def evaluate_api_check(api_cfg: Optional[dict[str, Any]]) -> tuple[bool, str, dict[str, Any]]:
    if not api_cfg or not api_cfg.get("url"):
        return True, "No API check configured", {}
    method = str(api_cfg.get("method") or "GET").upper()
    headers = api_cfg.get("headers") if isinstance(api_cfg.get("headers"), dict) else {}
    timeout = float(api_cfg.get("timeout_seconds") or 10)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method,
                api_cfg["url"],
                headers=headers,
                json=api_cfg.get("json_body"),
            )
    except Exception as exc:
        return False, f"API check failed to run: {exc}", {}

    detail = {
        "status_code": response.status_code,
        "ok_http": 200 <= response.status_code < 300,
    }
    expect_status = api_cfg.get("expect_status")
    if expect_status is not None and response.status_code != int(expect_status):
        return False, f"API returned status {response.status_code}", detail

    success_contains = api_cfg.get("response_contains")
    body_text = response.text or ""
    if success_contains and str(success_contains) not in body_text:
        return False, "API response missing expected text", detail

    if not detail["ok_http"] and expect_status is None:
        return False, f"API returned status {response.status_code}", detail

    return True, "API check passed", detail


def evaluate_file_check(
    file_cfg: Optional[dict[str, Any]],
    evidence: dict[str, Any],
) -> tuple[bool, str]:
    if not file_cfg or not file_cfg.get("required", True):
        return True, "No file required"
    if not evidence.get("file_path") and not evidence.get("file_uploaded"):
        return False, "Required evidence file was not uploaded"
    allowed = file_cfg.get("allowed_types")
    content_type = evidence.get("content_type")
    if allowed and content_type and content_type not in allowed:
        return False, f"File type {content_type} is not allowed"
    max_bytes = file_cfg.get("max_bytes")
    size = evidence.get("size_bytes")
    if max_bytes and size and int(size) > int(max_bytes):
        return False, "Uploaded file is too large"
    return True, "File evidence accepted"


async def evaluate_attempt(
    *,
    criteria: dict[str, Any],
    steps_total: int,
    completed_indexes: list[int],
    page_evidence: Optional[dict[str, Any]] = None,
    file_evidence: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    crit = normalize_criteria(criteria)
    ver = crit["verification"]
    mode = ver["mode"]
    checks: list[dict[str, Any]] = []

    steps_ok, steps_msg = steps_satisfied(
        criteria=crit,
        completed_indexes=completed_indexes,
        steps_total=steps_total,
    )
    checks.append({"name": "steps", "passed": steps_ok, "detail": steps_msg})

    page_ok, page_msg = True, "Skipped"
    if mode == "page_check":
        page_ok, page_msg = evaluate_page_check(ver.get("page_check"), page_evidence or {})
        checks.append({"name": "page_check", "passed": page_ok, "detail": page_msg})

    api_ok, api_msg, api_detail = True, "Skipped", {}
    if mode == "api":
        api_ok, api_msg, api_detail = await evaluate_api_check(ver.get("api"))
        checks.append(
            {"name": "api", "passed": api_ok, "detail": api_msg, "meta": api_detail}
        )

    file_ok, file_msg = True, "Skipped"
    if mode == "file":
        file_ok, file_msg = evaluate_file_check(ver.get("file"), file_evidence or {})
        checks.append({"name": "file", "passed": file_ok, "detail": file_msg})

    if mode == "manual":
        status = "pending_review"
        summary = "Submitted for manual review"
        passed = False
    else:
        auto_ok = steps_ok and page_ok and api_ok and file_ok
        if auto_ok:
            status = "passed"
            summary = "Verification passed"
            passed = True
        elif ver.get("manual_review_fallback"):
            status = "pending_review"
            summary = "Automatic checks failed or incomplete — queued for manual review"
            passed = False
        else:
            status = "needs_retry"
            summary = "Verification failed — try again"
            passed = False

    return {
        "passed": passed,
        "status": status,
        "summary": summary,
        "success_definition": crit["success_definition"],
        "mode": mode,
        "checks": checks,
    }
