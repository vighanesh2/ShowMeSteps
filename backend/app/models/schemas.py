from datetime import datetime
from enum import Enum
from typing import Any, Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, Field, HttpUrl


# --- Auth ---


class SignupRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: Optional[str] = Field(default=None, max_length=100)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserProfile(BaseModel):
    id: UUID
    email: EmailStr
    display_name: Optional[str] = None
    created_at: Optional[datetime] = None


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: Optional[int] = None
    user: UserProfile


class MessageResponse(BaseModel):
    message: str


# --- Tutorials ---


class TutorialStatus(str, Enum):
    draft = "draft"
    published = "published"
    archived = "archived"


class TutorialStepBase(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    order_index: int = Field(ge=0, default=0)
    screenshot_path: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TutorialStepCreate(TutorialStepBase):
    pass


class TutorialStepUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    order_index: Optional[int] = Field(default=None, ge=0)
    screenshot_path: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


class TutorialStep(TutorialStepBase):
    id: UUID
    tutorial_id: UUID
    created_at: datetime
    updated_at: datetime


class TutorialBase(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    status: TutorialStatus = TutorialStatus.draft


class TutorialCreate(TutorialBase):
    steps: list[TutorialStepCreate] = Field(default_factory=list)


class TutorialUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    status: Optional[TutorialStatus] = None


class Tutorial(TutorialBase):
    id: UUID
    owner_id: UUID
    share_slug: Optional[str] = None
    share_url: Optional[str] = None
    completion_criteria: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime
    steps: list[TutorialStep] = Field(default_factory=list)


class TutorialListResponse(BaseModel):
    items: list[Tutorial]
    count: int


class PublicTutorialStep(BaseModel):
    id: UUID
    title: str
    description: Optional[str] = None
    order_index: int
    screenshot_path: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class PublicTutorial(BaseModel):
    id: UUID
    title: str
    description: Optional[str] = None
    share_slug: str
    share_url: str
    start_url: Optional[str] = None
    step_count: int
    steps: list[PublicTutorialStep] = Field(default_factory=list)
    completion_criteria: dict[str, Any] = Field(default_factory=dict)


# --- Media ---


class MediaType(str, Enum):
    screenshot = "screenshot"
    recording = "recording"


class MediaAsset(BaseModel):
    id: UUID
    tutorial_id: UUID
    owner_id: UUID
    media_type: MediaType
    file_path: str
    file_name: str
    content_type: str
    size_bytes: Optional[int] = None
    public_url: Optional[HttpUrl | str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class MediaUploadResponse(BaseModel):
    asset: MediaAsset
    message: str = "Upload successful"


class SignedUrlResponse(BaseModel):
    path: str
    signed_url: str
    expires_in: int


# --- AI generation & review ---


class GenerateTutorialRequest(BaseModel):
    """Optional inline recording. If omitted, the latest uploaded recording is used."""

    actions: Optional[list[dict[str, Any]]] = None
    replace_existing_steps: bool = True
    update_title: bool = True


class GeneratedStepDraft(BaseModel):
    order_index: int
    title: str
    explanation: str
    source_action_index: Optional[int] = None
    screenshot_path: Optional[str] = None
    screenshot_url: Optional[str] = None
    element_hint: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class GenerateTutorialResponse(BaseModel):
    tutorial_id: UUID
    title: str
    summary: Optional[str] = None
    model: str
    steps: list[GeneratedStepDraft]
    review_url: str
    message: str = "Draft tutorial generated. Review and save when ready."


class ReviewStepUpdate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: Optional[str] = None
    order_index: int = Field(ge=0)
    screenshot_path: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SaveTutorialRequest(BaseModel):
    """Creator review payload — replaces steps and optionally publishes."""

    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    description: Optional[str] = None
    steps: list[ReviewStepUpdate]
    publish: bool = False


class SaveTutorialResponse(BaseModel):
    tutorial: Tutorial
    message: str
    share_url: Optional[str] = None
    share_slug: Optional[str] = None


# --- Verification / attempts ---


class AttemptStatus(str, Enum):
    in_progress = "in_progress"
    passed = "passed"
    failed = "failed"
    needs_retry = "needs_retry"
    pending_review = "pending_review"


class CompletionCriteriaUpdate(BaseModel):
    success_definition: str = Field(min_length=1, max_length=500)
    require_all_steps: bool = True
    required_step_indexes: Optional[list[int]] = None
    verification: dict[str, Any] = Field(default_factory=dict)


class StartAttemptRequest(BaseModel):
    learner_key: str = Field(min_length=4, max_length=120)
    learner_label: Optional[str] = Field(default=None, max_length=120)


class Attempt(BaseModel):
    id: UUID
    tutorial_id: UUID
    learner_key: str
    learner_label: Optional[str] = None
    status: AttemptStatus
    steps_completed: int = 0
    steps_total: int = 0
    completed_step_indexes: list[int] = Field(default_factory=list)
    verification_method: Optional[str] = None
    verification_result: dict[str, Any] = Field(default_factory=dict)
    evidence: dict[str, Any] = Field(default_factory=dict)
    evidence_file_path: Optional[str] = None
    reviewer_notes: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime


class CompleteAttemptRequest(BaseModel):
    completed_step_indexes: list[int] = Field(default_factory=list)
    page_evidence: Optional[dict[str, Any]] = None
    request_manual_review: bool = False
    notes: Optional[str] = Field(default=None, max_length=1000)


class CompleteAttemptResponse(BaseModel):
    attempt: Attempt
    verification: dict[str, Any]
    message: str


class ManualReviewRequest(BaseModel):
    status: AttemptStatus
    reviewer_notes: Optional[str] = Field(default=None, max_length=2000)


class AttemptListResponse(BaseModel):
    items: list[Attempt]
    count: int

