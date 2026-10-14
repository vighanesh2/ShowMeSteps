from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "ShowMeSteps"
    debug: bool = False
    environment: str = "development"  # development | staging | production
    cors_origins: str = "http://localhost:3000,http://localhost:5173"

    supabase_url: str
    supabase_anon_key: str
    supabase_service_role_key: str
    supabase_jwt_secret: str

    screenshots_bucket: str = "screenshots"
    recordings_bucket: str = "recordings"

    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"
    public_app_url: str = "http://localhost:8000"

    # Production / privacy
    sentry_dsn: str = ""
    sentry_traces_sample_rate: float = 0.0
    privacy_retain_attempts_days: int = 365
    privacy_allow_ai_coaching_default: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_production(self) -> bool:
        return self.environment.lower() == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
