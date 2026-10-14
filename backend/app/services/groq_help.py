"""Groq helpers for learner mistakes, Q&A, and recovery coaching."""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from groq import Groq

from app.config import get_settings

MISTAKE_SYSTEM = """You help beginners follow an interactive browser tutorial (ShowMeSteps).
The learner clicked or did something unexpected. Explain what went wrong in simple language,
tell them what to do instead, and reassure them. Keep it short (2–4 sentences). No jargon.
Never ask for passwords or secrets. Return ONLY JSON."""

ASK_SYSTEM = """You are a patient tutor helping someone complete one step of a browser tutorial.
Answer their question about the current step in simple language. Be concise (2–5 sentences).
If you are unsure of the exact UI, give best-effort guidance based on the step description.
Never ask for passwords or secrets. Return ONLY JSON."""

RECOVER_SYSTEM = """You help a learner get back on track in a browser tutorial.
They may be on the wrong page or stuck. Give a short recovery plan in simple language:
where they should be, what to look for, and the next action. Return ONLY JSON."""


def _client() -> Groq:
    settings = get_settings()
    if not settings.groq_api_key:
        raise RuntimeError("GROQ_API_KEY is not set")
    return Groq(api_key=settings.groq_api_key)


def _extract_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            return {"message": text}
        return json.loads(match.group(0))


def _step_context(step: dict[str, Any], tutorial_title: Optional[str] = None) -> dict[str, Any]:
    meta = step.get("metadata") or {}
    el = meta.get("element") or {}
    return {
        "tutorial_title": tutorial_title,
        "step_title": step.get("title"),
        "step_description": step.get("description"),
        "kind": meta.get("kind"),
        "expected_url": meta.get("url") or meta.get("to"),
        "element_hint": meta.get("element_hint")
        or el.get("ariaLabel")
        or el.get("text")
        or el.get("placeholder")
        or el.get("name"),
        "css_selector": el.get("cssSelector"),
    }


def explain_mistake(
    *,
    step: dict[str, Any],
    tutorial_title: Optional[str],
    clicked_summary: Optional[str],
    current_url: Optional[str],
    mistake_type: str = "wrong_click",
) -> dict[str, Any]:
    settings = get_settings()
    payload = {
        "mistake_type": mistake_type,
        "clicked": clicked_summary,
        "current_url": current_url,
        "step": _step_context(step, tutorial_title),
    }
    completion = _client().chat.completions.create(
        model=settings.groq_model,
        temperature=0.3,
        messages=[
            {"role": "system", "content": MISTAKE_SYSTEM},
            {
                "role": "user",
                "content": (
                    "Return JSON: "
                    '{"headline":"short title","explanation":"what went wrong + what to do",'
                    '"tip":"one actionable tip"}\n\n'
                    f"Context:\n{json.dumps(payload, ensure_ascii=False)}"
                ),
            },
        ],
        response_format={"type": "json_object"},
    )
    parsed = _extract_json(completion.choices[0].message.content or "{}")
    return {
        "headline": str(parsed.get("headline") or "Not quite — try again").strip(),
        "explanation": str(
            parsed.get("explanation")
            or "That wasn't the control for this step. Use the highlighted element."
        ).strip(),
        "tip": str(parsed.get("tip") or "Look for the green highlight and click that.").strip(),
        "model": settings.groq_model,
    }


def answer_step_question(
    *,
    step: dict[str, Any],
    tutorial_title: Optional[str],
    question: str,
    current_url: Optional[str] = None,
) -> dict[str, Any]:
    settings = get_settings()
    payload = {
        "question": question,
        "current_url": current_url,
        "step": _step_context(step, tutorial_title),
    }
    completion = _client().chat.completions.create(
        model=settings.groq_model,
        temperature=0.4,
        messages=[
            {"role": "system", "content": ASK_SYSTEM},
            {
                "role": "user",
                "content": (
                    'Return JSON: {"answer":"plain language answer","next_action":"what to do now"}\n\n'
                    f"Context:\n{json.dumps(payload, ensure_ascii=False)}"
                ),
            },
        ],
        response_format={"type": "json_object"},
    )
    parsed = _extract_json(completion.choices[0].message.content or "{}")
    return {
        "answer": str(parsed.get("answer") or "Follow the highlighted control for this step.").strip(),
        "next_action": str(
            parsed.get("next_action") or step.get("title") or "Complete the highlighted action."
        ).strip(),
        "model": settings.groq_model,
    }


def recovery_plan(
    *,
    step: dict[str, Any],
    tutorial_title: Optional[str],
    current_url: Optional[str],
) -> dict[str, Any]:
    settings = get_settings()
    ctx = _step_context(step, tutorial_title)
    payload = {"current_url": current_url, "step": ctx}
    completion = _client().chat.completions.create(
        model=settings.groq_model,
        temperature=0.3,
        messages=[
            {"role": "system", "content": RECOVER_SYSTEM},
            {
                "role": "user",
                "content": (
                    "Return JSON: "
                    '{"headline":"short title","explanation":"how to get back",'
                    '"recovery_url":"best URL to open or null","look_for":"what to click/find"}\n\n'
                    f"Context:\n{json.dumps(payload, ensure_ascii=False)}"
                ),
            },
        ],
        response_format={"type": "json_object"},
    )
    parsed = _extract_json(completion.choices[0].message.content or "{}")
    recovery_url = parsed.get("recovery_url") or ctx.get("expected_url")
    if recovery_url and not str(recovery_url).startswith("http"):
        recovery_url = ctx.get("expected_url")
    return {
        "headline": str(parsed.get("headline") or "Let's get you back").strip(),
        "explanation": str(
            parsed.get("explanation")
            or "We'll take you back to the page for this step and highlight the correct control."
        ).strip(),
        "recovery_url": recovery_url,
        "look_for": str(
            parsed.get("look_for") or ctx.get("element_hint") or step.get("title") or "the highlighted control"
        ).strip(),
        "model": settings.groq_model,
    }
