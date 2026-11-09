"""BREW Coffee Platform — Main FastAPI Application Entrypoint.

Unifies all migrated REST routes, Server-Sent Events (SSE), and
bidirectional WebSocket carrier audio streaming under Clean Architecture.
"""

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.config import settings
from app.api.v1 import (
    health,
    auth,
    payments,
    van_requests,
    voice_booking,
    barista_chat,
    realtime,
    notifications,
    webhooks,
    admin,
    cron,
)
from app.websockets import voice_bridge

app = FastAPI(
    title="BREW Coffee Platform API",
    description="Clean Architecture Python FastAPI Backend for Mobile Sanctuary Coffee Platform",
    version="1.0.0",
)

# CORS Middleware (Configured for Next.js frontend communication)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        settings.app_url,
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Centralized Exception Handlers (Exact contract matching with Next.js)
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    errors = "; ".join(f"{'.'.join(str(loc) for loc in err['loc'])}: {err['msg']}" for err in exc.errors())
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content={"error": f"Validation Error: {errors}"},
    )


# Include All Routers
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(payments.router)
app.include_router(van_requests.router)
app.include_router(voice_booking.router)
app.include_router(barista_chat.router)
app.include_router(realtime.router)
app.include_router(notifications.router)
app.include_router(webhooks.router)
app.include_router(admin.router)
app.include_router(cron.router)
app.include_router(voice_bridge.router)


@app.get("/")
async def root():
    return {
        "service": "BREW Coffee Platform FastAPI Backend",
        "status": "online",
        "version": "1.0.0",
    }
