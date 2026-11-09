"""BREW Coffee Platform — Application Configuration.

Implements Pydantic BaseSettings for strong typing, environment variable loading,
and safe validation without leaking secrets.
"""

from typing import Optional
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=("../.env.local", "../.env", ".env.local", ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Environment
    app_env: str = Field(default="development", alias="NODE_ENV")
    app_url: str = Field(default="http://localhost:3000", alias="APP_URL")
    business_email: str = Field(default="catering@brewcoffee.in", alias="BUSINESS_EMAIL")
    business_phone: str = Field(default="+919876543210", alias="BUSINESS_PHONE")

    # Security & Auth
    auth_secret: str = Field(
        default="brew-platform-secure-jwt-hmac-secret-key-2026",
        alias="AUTH_SECRET",
    )
    quotation_snapshot_secret: str = Field(
        default="brew-test-quotation-secret-32-chars-long!",
        alias="QUOTATION_SNAPSHOT_SECRET",
    )
    barista_pin: str = Field(default="2026", alias="BARISTA_PIN")
    fleet_admin_pin: str = Field(default="7788", alias="FLEET_ADMIN_PIN")
    cron_secret: str = Field(default="brew-cron-worker-secret-dev", alias="CRON_SECRET")
    outbox_worker_secret: str = Field(
        default="brew-platform-secure-jwt-hmac-secret-key-2026",
        alias="OUTBOX_WORKER_SECRET",
    )

    # Firebase / Firestore
    firebase_project_id: Optional[str] = Field(default=None, alias="FIREBASE_PROJECT_ID")
    firebase_client_email: Optional[str] = Field(default=None, alias="FIREBASE_CLIENT_EMAIL")
    firebase_private_key: Optional[str] = Field(default=None, alias="FIREBASE_PRIVATE_KEY")
    firebase_service_account: Optional[str] = Field(default=None, alias="FIREBASE_SERVICE_ACCOUNT")
    firestore_emulator_host: Optional[str] = Field(default=None, alias="FIRESTORE_EMULATOR_HOST")

    # Redis (Upstash)
    upstash_redis_rest_url: Optional[str] = Field(default=None, alias="UPSTASH_REDIS_REST_URL")
    upstash_redis_rest_token: Optional[str] = Field(default=None, alias="UPSTASH_REDIS_REST_TOKEN")

    # Razorpay
    razorpay_key_id: str = Field(default="rzp_test_brew2026", alias="RAZORPAY_KEY_ID")
    razorpay_key_secret: str = Field(default="brew_razorpay_secret_test_2026", alias="RAZORPAY_KEY_SECRET")
    razorpay_webhook_secret: str = Field(default="brew_webhook_secret_dev_2026", alias="RAZORPAY_WEBHOOK_SECRET")

    # AI / Gemini
    gemini_api_key: Optional[str] = Field(default=None, alias="GEMINI_API_KEY")
    google_genai_api_key: Optional[str] = Field(default=None, alias="GOOGLE_GENAI_API_KEY")

    # Outbox Worker & Background Processing
    outbox_worker_enabled: bool = Field(default=False, alias="OUTBOX_WORKER_ENABLED")
    allow_local_fallback: bool = Field(default=True, alias="ALLOW_LOCAL_FALLBACK")

    # Telephony & Voice Bridge
    voice_booking_enabled: bool = Field(default=False, alias="VOICE_BOOKING_ENABLED")
    exotel_account_sid: Optional[str] = Field(default=None, alias="EXOTEL_ACCOUNT_SID")
    exotel_api_key: Optional[str] = Field(default=None, alias="EXOTEL_API_KEY")
    exotel_api_token: Optional[str] = Field(default=None, alias="EXOTEL_API_TOKEN")
    exotel_subdomain: str = Field(default="api.in.exotel.com", alias="EXOTEL_SUBDOMAIN")
    exotel_caller_id: Optional[str] = Field(default=None, alias="EXOTEL_CALLER_ID")
    stream_secret_key: str = Field(default="brew-dev-stream-secret-change-in-production", alias="STREAM_SECRET_KEY")

    # Speech Providers
    azure_speech_key: Optional[str] = Field(default=None, alias="AZURE_SPEECH_KEY")
    azure_speech_region: Optional[str] = Field(default=None, alias="AZURE_SPEECH_REGION")

    # Meta WhatsApp
    meta_whatsapp_phone_number_id: Optional[str] = Field(default=None, alias="META_WHATSAPP_PHONE_NUMBER_ID")
    meta_whatsapp_access_token: Optional[str] = Field(default=None, alias="META_WHATSAPP_ACCESS_TOKEN")
    meta_whatsapp_app_secret: Optional[str] = Field(default=None, alias="META_WHATSAPP_APP_SECRET")
    meta_whatsapp_verify_token: Optional[str] = Field(default=None, alias="META_WHATSAPP_VERIFY_TOKEN")

    @property
    def is_production(self) -> bool:
        return self.app_env.lower() == "production"


settings = Settings()
