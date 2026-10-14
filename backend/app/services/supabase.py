from functools import lru_cache

from supabase import Client, create_client

from app.config import get_settings


@lru_cache
def get_supabase_admin() -> Client:
    """Service-role client for privileged DB and storage operations."""
    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def get_supabase_anon() -> Client:
    """Anon client for auth flows (signup / login)."""
    settings = get_settings()
    return create_client(settings.supabase_url, settings.supabase_anon_key)


def get_supabase_for_user(access_token: str) -> Client:
    """Client scoped to the caller's JWT for RLS-aware queries."""
    settings = get_settings()
    client = create_client(settings.supabase_url, settings.supabase_anon_key)
    client.postgrest.auth(access_token)
    return client
