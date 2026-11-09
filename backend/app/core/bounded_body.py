"""BREW Coffee Platform — Bounded Body Middleware / Helpers.

Enforces strict stream-level size boundaries (default 100KB) to prevent
memory exhaustion and unauthenticated large payload buffering.
"""

import json
from typing import Any, Tuple, Optional
from fastapi import Request, HTTPException, status

MAX_BODY_BYTES = 100 * 1024  # 100 KB


async def read_bounded_bytes(request: Request, max_bytes: int = MAX_BODY_BYTES) -> bytes:
    """Reads request body up to max_bytes, raising 413 if exceeded."""
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise HTTPException(
                    status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail=f"Payload too large. Exceeds limit of {max_bytes} bytes.",
                )
        except ValueError:
            pass

    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Payload too large. Exceeds limit of {max_bytes} bytes.",
            )

    return bytes(body)


async def read_bounded_json(request: Request, max_bytes: int = MAX_BODY_BYTES) -> Any:
    """Reads bounded bytes and parses JSON, raising 400 on malformed syntax."""
    raw = await read_bounded_bytes(request, max_bytes)
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Malformed JSON payload: {str(e)}",
        )
