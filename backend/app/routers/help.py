"""Public AI help for learners (mistakes, Q&A, recovery)."""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.services.groq_help import answer_step_question, explain_mistake, recovery_plan

router = APIRouter(prefix="/public/help", tags=["help"])


class StepPayload(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class MistakeRequest(BaseModel):
    tutorial_title: Optional[str] = None
    step: StepPayload
    mistake_type: str = "wrong_click"
    clicked_summary: Optional[str] = None
    current_url: Optional[str] = None


class MistakeResponse(BaseModel):
    headline: str
    explanation: str
    tip: str
    model: str


class AskRequest(BaseModel):
    tutorial_title: Optional[str] = None
    step: StepPayload
    question: str = Field(min_length=1, max_length=500)
    current_url: Optional[str] = None


class AskResponse(BaseModel):
    answer: str
    next_action: str
    model: str


class RecoverRequest(BaseModel):
    tutorial_title: Optional[str] = None
    step: StepPayload
    current_url: Optional[str] = None


class RecoverResponse(BaseModel):
    headline: str
    explanation: str
    recovery_url: Optional[str] = None
    look_for: str
    model: str


def _step_dict(step: StepPayload) -> dict[str, Any]:
    return {
        "title": step.title,
        "description": step.description,
        "metadata": step.metadata or {},
    }


@router.post("/mistake", response_model=MistakeResponse)
async def help_mistake(payload: MistakeRequest) -> MistakeResponse:
    try:
        result = explain_mistake(
            step=_step_dict(payload.step),
            tutorial_title=payload.tutorial_title,
            clicked_summary=payload.clicked_summary,
            current_url=payload.current_url,
            mistake_type=payload.mistake_type,
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Help request failed: {exc}",
        ) from exc
    return MistakeResponse(**result)


@router.post("/ask", response_model=AskResponse)
async def help_ask(payload: AskRequest) -> AskResponse:
    try:
        result = answer_step_question(
            step=_step_dict(payload.step),
            tutorial_title=payload.tutorial_title,
            question=payload.question,
            current_url=payload.current_url,
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Help request failed: {exc}",
        ) from exc
    return AskResponse(**result)


@router.post("/recover", response_model=RecoverResponse)
async def help_recover(payload: RecoverRequest) -> RecoverResponse:
    try:
        result = recovery_plan(
            step=_step_dict(payload.step),
            tutorial_title=payload.tutorial_title,
            current_url=payload.current_url,
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Help request failed: {exc}",
        ) from exc
    return RecoverResponse(**result)
