"""Generate plain-language tutorial steps from a recording using Groq."""

from __future__ import annotations

import json
import re
from typing import Any, Optional

from groq import Groq

from app.config import get_settings

SYSTEM_PROMPT = """You are ShowMeSteps, an expert at turning browser task recordings into clear interactive tutorials.

Given a list of recorded user actions (clicks, form changes, navigations, submits), produce numbered tutorial steps a beginner can follow.

Rules:
- Write in simple, direct language (short sentences).
- Each step is one clear action the learner should take.
- Merge noisy/redundant actions (e.g. many input events on the same field → one step).
- Skip session_start noise unless it is the only way to name the starting page.
- Never invent credentials or ask for passwords; if a field was redacted, say "Enter your password" without a value.
- Prefer actionable titles like "Click Create project" over technical selectors.
- Include a short explanation of why/what happens when helpful.
- Reference source_action_index from the input so we can attach the right screenshot.
- Keep step count focused: typically 3–20 steps depending on the recording.
- Return ONLY valid JSON matching the schema. No markdown fences.
"""

USER_SCHEMA_HINT = """
Return JSON with this shape:
{
  "title": "optional improved tutorial title",
  "summary": "1-2 sentence overview of the task",
  "steps": [
    {
      "order_index": 0,
      "title": "short action title",
      "explanation": "simple language instructions for this step",
      "source_action_index": 12,
      "element_hint": "optional human-readable target, e.g. the Save button"
    }
  ]
}
"""


def _compact_actions(actions: list[dict[str, Any]], limit: int = 80) -> list[dict[str, Any]]:
    """Shrink recording payload for the LLM context window."""
    compacted: list[dict[str, Any]] = []
    for index, action in enumerate(actions[:limit]):
        if not action.get("important", True) and action.get("kind") == "input":
            # Keep a light trail of typing only if nothing else exists nearby
            continue
        el = action.get("element") or {}
        compacted.append(
            {
                "index": index,
                "kind": action.get("kind"),
                "url": action.get("url"),
                "page_title": action.get("title"),
                "value": action.get("value"),
                "from": action.get("from"),
                "to": action.get("to"),
                "element": {
                    "tag": el.get("tag"),
                    "text": el.get("text"),
                    "name": el.get("name"),
                    "id": el.get("id"),
                    "type": el.get("type"),
                    "ariaLabel": el.get("ariaLabel"),
                    "placeholder": el.get("placeholder"),
                    "role": el.get("role"),
                    "cssSelector": el.get("cssSelector"),
                    "sensitive": el.get("sensitive"),
                }
                if el
                else None,
            }
        )

    # If we filtered too aggressively, fall back to first N important-ish actions
    if len(compacted) < 2:
        compacted = []
        for index, action in enumerate(actions[:limit]):
            el = action.get("element") or {}
            compacted.append(
                {
                    "index": index,
                    "kind": action.get("kind"),
                    "url": action.get("url"),
                    "page_title": action.get("title"),
                    "value": action.get("value"),
                    "element": {
                        "tag": el.get("tag"),
                        "text": el.get("text"),
                        "ariaLabel": el.get("ariaLabel"),
                        "cssSelector": el.get("cssSelector"),
                    }
                    if el
                    else None,
                }
            )
    return compacted


def _extract_json(text: str) -> dict[str, Any]:
    text = text.strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise
        return json.loads(match.group(0))


def generate_tutorial_from_actions(
    *,
    actions: list[dict[str, Any]],
    tutorial_title: Optional[str] = None,
    available_screenshot_indexes: Optional[list[int]] = None,
) -> dict[str, Any]:
    settings = get_settings()
    if not settings.groq_api_key:
        raise RuntimeError(
            "GROQ_API_KEY is not set. Add it to backend/.env (https://console.groq.com/keys)."
        )

    compact = _compact_actions(actions)
    if not compact:
        raise ValueError("Recording has no actions to generate from")

    screenshot_note = ""
    if available_screenshot_indexes:
        screenshot_note = (
            "Screenshots exist for these source action indexes: "
            f"{available_screenshot_indexes}. Prefer source_action_index values from this list "
            "when a visual is useful.\n"
        )

    user_prompt = (
        f"Tutorial working title: {tutorial_title or 'Untitled task'}\n"
        f"{screenshot_note}"
        f"{USER_SCHEMA_HINT}\n"
        f"Recorded actions JSON:\n{json.dumps(compact, ensure_ascii=False)}"
    )

    client = Groq(api_key=settings.groq_api_key)
    completion = client.chat.completions.create(
        model=settings.groq_model,
        temperature=0.3,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
        response_format={"type": "json_object"},
    )

    content = completion.choices[0].message.content or "{}"
    parsed = _extract_json(content)

    steps_in = parsed.get("steps") or []
    steps_out: list[dict[str, Any]] = []
    for i, step in enumerate(steps_in):
        if not isinstance(step, dict):
            continue
        title = str(step.get("title") or f"Step {i + 1}").strip()[:200]
        explanation = str(
            step.get("explanation") or step.get("description") or ""
        ).strip()
        source = step.get("source_action_index")
        try:
            source_index = int(source) if source is not None else None
        except (TypeError, ValueError):
            source_index = None

        order = step.get("order_index", i)
        try:
            order_index = int(order)
        except (TypeError, ValueError):
            order_index = i

        steps_out.append(
            {
                "order_index": order_index,
                "title": title,
                "explanation": explanation,
                "source_action_index": source_index,
                "element_hint": step.get("element_hint"),
            }
        )

    steps_out.sort(key=lambda s: s["order_index"])
    for i, step in enumerate(steps_out):
        step["order_index"] = i

    return {
        "title": (parsed.get("title") or tutorial_title or "").strip() or None,
        "summary": (parsed.get("summary") or "").strip() or None,
        "steps": steps_out,
        "model": settings.groq_model,
    }
