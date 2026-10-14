import json
from typing import Optional
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from app.config import get_settings
from app.dependencies import CurrentUser
from app.models.schemas import (
    MediaAsset,
    MediaType,
    MediaUploadResponse,
    SignedUrlResponse,
)
from app.services.supabase import get_supabase_admin

router = APIRouter(prefix="/media", tags=["media"])

ALLOWED_SCREENSHOT_TYPES = {
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
}
ALLOWED_RECORDING_TYPES = {
    "application/json",
    "text/plain",
    "video/webm",
    "video/mp4",
    "application/octet-stream",
}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB


def _assert_tutorial_owner(tutorial_id: UUID, owner_id: UUID) -> None:
    admin = get_supabase_admin()
    try:
        result = (
            admin.table("tutorials")
            .select("id")
            .eq("id", str(tutorial_id))
            .eq("owner_id", str(owner_id))
            .maybe_single()
            .execute()
        )
        data = result.data
    except Exception:
        data = None
    if not data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tutorial not found",
        )


def _bucket_for(media_type: MediaType) -> str:
    settings = get_settings()
    if media_type == MediaType.screenshot:
        return settings.screenshots_bucket
    return settings.recordings_bucket


def _validate_content_type(media_type: MediaType, content_type: str) -> None:
    allowed = (
        ALLOWED_SCREENSHOT_TYPES
        if media_type == MediaType.screenshot
        else ALLOWED_RECORDING_TYPES
    )
    if content_type not in allowed:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"Unsupported content type '{content_type}' for {media_type.value}",
        )


@router.post("/upload", response_model=MediaUploadResponse, status_code=status.HTTP_201_CREATED)
async def upload_media(
    current_user: CurrentUser,
    tutorial_id: UUID = Form(...),
    media_type: MediaType = Form(...),
    file: UploadFile = File(...),
    metadata: Optional[str] = Form(default=None),
) -> MediaUploadResponse:
    """Upload a screenshot or recording payload to Supabase Storage."""
    _assert_tutorial_owner(tutorial_id, current_user.id)

    content_type = file.content_type or "application/octet-stream"
    _validate_content_type(media_type, content_type)

    data = await file.read()
    if not data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty file",
        )
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {MAX_UPLOAD_BYTES} bytes",
        )

    meta: dict = {}
    if metadata:
        try:
            meta = json.loads(metadata)
            if not isinstance(meta, dict):
                raise ValueError("metadata must be a JSON object")
        except (json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid metadata JSON",
            ) from exc

    original_name = file.filename or f"{media_type.value}-{uuid4()}"
    ext = ""
    if "." in original_name:
        ext = "." + original_name.rsplit(".", 1)[-1].lower()

    object_path = f"{current_user.id}/{tutorial_id}/{uuid4()}{ext}"
    bucket = _bucket_for(media_type)
    admin = get_supabase_admin()

    try:
        admin.storage.from_(bucket).upload(
            path=object_path,
            file=data,
            file_options={"content-type": content_type, "upsert": "false"},
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Storage upload failed: {exc}",
        ) from exc

    public_url = None
    try:
        public_url = admin.storage.from_(bucket).get_public_url(object_path)
    except Exception:
        public_url = None

    asset_row = {
        "tutorial_id": str(tutorial_id),
        "owner_id": str(current_user.id),
        "media_type": media_type.value,
        "file_path": object_path,
        "file_name": original_name,
        "content_type": content_type,
        "size_bytes": len(data),
        "bucket": bucket,
        "metadata": meta,
    }
    inserted = admin.table("media_assets").insert(asset_row).execute()
    if not inserted.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to record media asset",
        )

    asset = inserted.data[0]
    asset["public_url"] = public_url
    return MediaUploadResponse(asset=MediaAsset.model_validate(asset))


@router.get("/tutorial/{tutorial_id}", response_model=list[MediaAsset])
async def list_tutorial_media(
    tutorial_id: UUID,
    current_user: CurrentUser,
    media_type: Optional[MediaType] = None,
) -> list[MediaAsset]:
    _assert_tutorial_owner(tutorial_id, current_user.id)
    admin = get_supabase_admin()
    query = (
        admin.table("media_assets")
        .select("*")
        .eq("tutorial_id", str(tutorial_id))
        .eq("owner_id", str(current_user.id))
        .order("created_at", desc=True)
    )
    if media_type is not None:
        query = query.eq("media_type", media_type.value)

    result = query.execute()
    assets: list[MediaAsset] = []
    for row in result.data or []:
        try:
            row["public_url"] = admin.storage.from_(row["bucket"]).get_public_url(
                row["file_path"]
            )
        except Exception:
            row["public_url"] = None
        assets.append(MediaAsset.model_validate(row))
    return assets


@router.get("/{asset_id}/signed-url", response_model=SignedUrlResponse)
async def get_signed_url(
    asset_id: UUID,
    current_user: CurrentUser,
    expires_in: int = 3600,
) -> SignedUrlResponse:
    admin = get_supabase_admin()
    result = (
        admin.table("media_assets")
        .select("*")
        .eq("id", str(asset_id))
        .eq("owner_id", str(current_user.id))
        .maybe_single()
        .execute()
    )
    if result.data is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Media asset not found",
        )

    asset = result.data
    expires_in = max(60, min(expires_in, 86400))
    try:
        signed = admin.storage.from_(asset["bucket"]).create_signed_url(
            asset["file_path"], expires_in
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Could not create signed URL: {exc}",
        ) from exc

    signed_url = signed.get("signedURL") or signed.get("signed_url") or ""
    if not signed_url:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not create signed URL",
        )

    return SignedUrlResponse(
        path=asset["file_path"],
        signed_url=signed_url,
        expires_in=expires_in,
    )


@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_media(asset_id: UUID, current_user: CurrentUser) -> None:
    admin = get_supabase_admin()
    result = (
        admin.table("media_assets")
        .select("*")
        .eq("id", str(asset_id))
        .eq("owner_id", str(current_user.id))
        .maybe_single()
        .execute()
    )
    if result.data is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Media asset not found",
        )

    asset = result.data
    try:
        admin.storage.from_(asset["bucket"]).remove([asset["file_path"]])
    except Exception:
        pass

    admin.table("media_assets").delete().eq("id", str(asset_id)).execute()
