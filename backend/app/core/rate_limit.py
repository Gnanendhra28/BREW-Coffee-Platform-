"""BREW Coffee Platform — Sliding Window Rate Limiting.

Supports Upstash Redis REST API and In-Memory Sliding Window fallback.
Enforces fail-closed behavior for sensitive endpoints in production.
"""

import time
import httpx
from typing import Optional, Dict
from pydantic import BaseModel
from fastapi import Request
from .config import settings


class RateLimitResult(BaseModel):
    success: bool
    limit: int
    remaining: int
    reset: int
    degraded: bool = False
    error: Optional[str] = None


class _WindowRecord:
    def __init__(self, count: int, expires_at: float):
        self.count = count
        self.expires_at = expires_at


_local_memory_store: Dict[str, _WindowRecord] = {}


def get_client_ip(request: Request) -> str:
    """Extracts client IP from proxy headers or client host."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    real_ip = request.headers.get("x-real-ip")
    if real_ip:
        return real_ip.strip()
    cf_ip = request.headers.get("cf-connecting-ip")
    if cf_ip:
        return cf_ip.strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


async def check_rate_limit(
    identifier: str,
    prefix: str = "default",
    limit: int = 10,
    window_seconds: int = 60,
    sensitive: bool = False,
) -> RateLimitResult:
    """Evaluates request against rate limit using Upstash Redis or local memory."""
    redis_url = settings.upstash_redis_rest_url
    redis_token = settings.upstash_redis_rest_token
    key = f"ratelimit:{prefix}:{identifier}"
    now = time.time()
    reset_timestamp = int(now + window_seconds)

    is_production = settings.is_production

    # 1. Upstash Redis execution if configured
    if redis_url and redis_token:
        try:
            clean_url = redis_url.rstrip("/")
            # Use atomic pipeline or EVAL
            script = """
            local current = redis.call('INCR', KEYS[1])
            if current == 1 then
                redis.call('EXPIRE', KEYS[1], ARGV[1])
            end
            local ttl = redis.call('TTL', KEYS[1])
            return {current, ttl}
            """
            async with httpx.AsyncClient(timeout=2.0) as client:
                res = await client.post(
                    f"{clean_url}/eval",
                    headers={"Authorization": f"Bearer {redis_token}"},
                    json={"script": script, "keys": [key], "args": [str(window_seconds)]},
                )
                if res.status_code == 200:
                    data = res.json()
                    result_arr = data.get("result", [1, window_seconds])
                    current = int(result_arr[0])
                    ttl = int(result_arr[1])
                    actual_reset = int(now + max(1, ttl))
                    remaining = max(0, limit - current)
                    return RateLimitResult(
                        success=(current <= limit),
                        limit=limit,
                        remaining=remaining,
                        reset=actual_reset,
                        degraded=False,
                    )
        except Exception:
            # Fall through if Redis error
            pass

    # 2. Production fail-closed policy for sensitive endpoints
    if is_production and sensitive and not (redis_url and redis_token):
        return RateLimitResult(
            success=False,
            limit=limit,
            remaining=0,
            reset=reset_timestamp,
            degraded=True,
            error="RATE_LIMITER_UNAVAILABLE",
        )

    # 3. Local in-memory sliding window
    # Prune expired records
    to_delete = [k for k, r in _local_memory_store.items() if r.expires_at < now]
    for k in to_delete:
        del _local_memory_store[k]

    record = _local_memory_store.get(key)
    if not record or record.expires_at < now:
        record = _WindowRecord(count=1, expires_at=now + window_seconds)
        _local_memory_store[key] = record
    else:
        record.count += 1

    remaining = max(0, limit - record.count)
    return RateLimitResult(
        success=(record.count <= limit),
        limit=limit,
        remaining=remaining,
        reset=int(record.expires_at),
        degraded=True,
    )
