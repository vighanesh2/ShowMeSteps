from uuid import UUID

from fastapi import APIRouter, HTTPException, status
from gotrue.errors import AuthApiError

from app.dependencies import CurrentUser
from app.models.schemas import (
    AuthResponse,
    LoginRequest,
    MessageResponse,
    SignupRequest,
    UserProfile,
)
from app.services.supabase import get_supabase_admin, get_supabase_anon

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/signup", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def signup(payload: SignupRequest) -> AuthResponse:
    client = get_supabase_anon()
    try:
        result = client.auth.sign_up(
            {
                "email": payload.email,
                "password": payload.password,
                "options": {
                    "data": {"display_name": payload.display_name},
                },
            }
        )
    except AuthApiError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc

    if result.user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Signup failed",
        )

    user = result.user
    meta = user.user_metadata or {}
    profile = UserProfile(
        id=UUID(user.id),
        email=user.email or payload.email,
        display_name=meta.get("display_name") or payload.display_name,
        created_at=user.created_at,
    )

    # Email confirmation may be required; session can be None.
    if result.session is None:
        raise HTTPException(
            status_code=status.HTTP_200_OK,
            detail={
                "message": (
                    "Account created. Confirm your email before logging in, "
                    "or disable email confirmation in Supabase Auth for local dev."
                ),
                "user": profile.model_dump(mode="json"),
            },
        )

    return AuthResponse(
        access_token=result.session.access_token,
        refresh_token=result.session.refresh_token,
        expires_in=result.session.expires_in,
        user=profile,
    )


@router.post("/login", response_model=AuthResponse)
async def login(payload: LoginRequest) -> AuthResponse:
    client = get_supabase_anon()
    try:
        result = client.auth.sign_in_with_password(
            {"email": payload.email, "password": payload.password}
        )
    except AuthApiError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        ) from exc

    if result.user is None or result.session is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    user = result.user
    meta = user.user_metadata or {}
    return AuthResponse(
        access_token=result.session.access_token,
        refresh_token=result.session.refresh_token,
        expires_in=result.session.expires_in,
        user=UserProfile(
            id=UUID(user.id),
            email=user.email or payload.email,
            display_name=meta.get("display_name"),
            created_at=user.created_at,
        ),
    )


@router.get("/me", response_model=UserProfile)
async def me(current_user: CurrentUser) -> UserProfile:
    return current_user


@router.post("/logout", response_model=MessageResponse)
async def logout(current_user: CurrentUser) -> MessageResponse:
    # Client should discard tokens; optionally revoke via admin if needed.
    _ = current_user
    try:
        get_supabase_admin().auth.sign_out()
    except Exception:
        pass
    return MessageResponse(message="Logged out")
