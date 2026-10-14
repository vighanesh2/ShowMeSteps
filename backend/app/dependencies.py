from typing import Annotated
from uuid import UUID

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from gotrue.errors import AuthApiError

from app.models.schemas import UserProfile
from app.services.supabase import get_supabase_admin, get_supabase_for_user

security = HTTPBearer(auto_error=True)


async def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
) -> UserProfile:
    token = credentials.credentials
    try:
        admin = get_supabase_admin()
        response = admin.auth.get_user(token)
    except AuthApiError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

    user = response.user
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token",
            headers={"WWW-Authenticate": "Bearer"},
        )

    meta = user.user_metadata or {}
    return UserProfile(
        id=UUID(user.id),
        email=user.email or "",
        display_name=meta.get("display_name"),
        created_at=user.created_at,
    )


async def get_user_client(
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(security)],
    _: Annotated[UserProfile, Depends(get_current_user)],
):
    """Return a Supabase client authenticated as the current user (RLS applies)."""
    return get_supabase_for_user(credentials.credentials)


CurrentUser = Annotated[UserProfile, Depends(get_current_user)]
