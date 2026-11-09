"""Tests for Gemini AI Outbound Integration & Fallback Engine."""

import json
from unittest.mock import patch, AsyncMock
import pytest
import httpx

from app.core.config import settings
from app.api.v1.barista_chat import _agent_cache


@pytest.fixture(autouse=True)
def clear_agent_cache():
    _agent_cache.clear()
    yield
    _agent_cache.clear()


@pytest.mark.asyncio
async def test_gemini_outbound_success(client, monkeypatch):
    """Verifies that a valid Gemini API response is parsed, mapped to menu catalog, and cached."""
    monkeypatch.setattr(settings, "gemini_api_key", "mock-gemini-test-key-12345")

    mock_gemini_response = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "text": json.dumps({
                                "replyText": "For something rich and creamy, I recommend our signature Affogato paired with a warm Cinnamon Roll!",
                                "recommendedItemIds": ["c-1", "d-4"],
                                "reasons": [
                                    "Handcrafted vanilla bean gelato with bold espresso",
                                    "Freshly baked artisanal pastry with Ceylon cinnamon",
                                ],
                                "quickReplies": [
                                    "Tell me about your beans",
                                    "Iced drinks instead",
                                    "Explore Menu",
                                ],
                            })
                        }
                    ]
                }
            }
        ]
    }

    mock_resp = httpx.Response(
        status_code=200,
        json=mock_gemini_response,
        request=httpx.Request("POST", "https://generativelanguage.googleapis.com"),
    )

    mock_http_client = AsyncMock()
    mock_http_client.post.return_value = mock_resp
    mock_http_client.__aenter__.return_value = mock_http_client
    mock_http_client.__aexit__.return_value = None

    with patch("app.api.v1.barista_chat.httpx.AsyncClient", return_value=mock_http_client):
        res = await client.post(
            "/api/barista-chat",
            json={"message": "I want something sweet and warm for dessert"},
        )

        assert res.status_code == 200
        data = res.json()
        assert "Affogato" in data["replyText"] or "rich and creamy" in data["replyText"]
        assert len(data["recommendations"]) == 2
        assert data["recommendations"][0]["item"]["id"] == "c-1"
        assert data["recommendations"][1]["item"]["id"] == "d-4"
        assert mock_http_client.post.called

        # Verify second call is served from 30-min cache without second outbound HTTP post
        mock_http_client.post.reset_mock()
        cached_res = await client.post(
            "/api/barista-chat",
            json={"message": "I want something sweet and warm for dessert"},
        )
        assert cached_res.status_code == 200
        assert cached_res.json().get("cached") is True
        assert not mock_http_client.post.called


@pytest.mark.asyncio
async def test_gemini_fallback_on_error(client, monkeypatch):
    """Verifies graceful fallback to deterministic engine on Gemini HTTP error."""
    monkeypatch.setattr(settings, "gemini_api_key", "mock-gemini-test-key-12345")

    mock_err_resp = httpx.Response(
        status_code=500,
        text="Internal Server Error",
        request=httpx.Request("POST", "https://generativelanguage.googleapis.com"),
    )

    mock_http_client = AsyncMock()
    mock_http_client.post.return_value = mock_err_resp
    mock_http_client.__aenter__.return_value = mock_http_client
    mock_http_client.__aexit__.return_value = None

    with patch("app.api.v1.barista_chat.httpx.AsyncClient", return_value=mock_http_client):
        res = await client.post(
            "/api/barista-chat",
            json={"message": "I want something cold and refreshing"},
        )

        # Must not crash with 500; gracefully falls back to deterministic engine
        assert res.status_code == 200
        data = res.json()
        assert "Cold Brew" in data["replyText"] or "18-hr steeped" in data["replyText"]
        assert len(data["recommendations"]) >= 1


@pytest.mark.asyncio
async def test_gemini_fallback_on_rate_limit(client, monkeypatch):
    """Verifies graceful fallback when Gemini rate limit (HTTP 429) occurs."""
    monkeypatch.setattr(settings, "gemini_api_key", "mock-gemini-test-key-12345")

    mock_429_resp = httpx.Response(
        status_code=429,
        text="Rate limit exceeded",
        request=httpx.Request("POST", "https://generativelanguage.googleapis.com"),
    )

    mock_http_client = AsyncMock()
    mock_http_client.post.return_value = mock_429_resp
    mock_http_client.__aenter__.return_value = mock_http_client
    mock_http_client.__aexit__.return_value = None

    with patch("app.api.v1.barista_chat.httpx.AsyncClient", return_value=mock_http_client):
        res = await client.post(
            "/api/barista-chat",
            json={"message": "Suggest a morning espresso"},
        )

        assert res.status_code == 200
        data = res.json()
        assert "recommendations" in data
        assert len(data["recommendations"]) >= 1


@pytest.mark.asyncio
async def test_no_gemini_call_when_key_absent(client, monkeypatch):
    """Verifies that no outbound HTTP request is made if GEMINI_API_KEY is not configured."""
    monkeypatch.setattr(settings, "gemini_api_key", None)
    monkeypatch.setattr(settings, "google_genai_api_key", None)

    mock_http_client = AsyncMock()
    with patch("app.api.v1.barista_chat.httpx.AsyncClient", return_value=mock_http_client):
        res = await client.post(
            "/api/barista-chat",
            json={"message": "Recommend a sweet beverage"},
        )

        assert res.status_code == 200
        assert not mock_http_client.post.called
        data = res.json()
        assert "Affogato" in data["replyText"]


@pytest.mark.asyncio
async def test_gemini_barista_ops_chat(client, monkeypatch):
    """Verifies employee ops chat with Gemini integration."""
    monkeypatch.setattr(settings, "gemini_api_key", "mock-gemini-test-key-12345")

    mock_ops_response = {
        "candidates": [
            {
                "content": {
                    "parts": [
                        {
                            "text": "Cyber Towers Gate 2 has optimal footfall today. Recommend positioning before 4:00 PM."
                        }
                    ]
                }
            }
        ]
    }

    mock_resp = httpx.Response(
        status_code=200,
        json=mock_ops_response,
        request=httpx.Request("POST", "https://generativelanguage.googleapis.com"),
    )

    mock_http_client = AsyncMock()
    mock_http_client.post.return_value = mock_resp
    mock_http_client.__aenter__.return_value = mock_http_client
    mock_http_client.__aexit__.return_value = None

    with patch("app.api.v1.barista_chat.httpx.AsyncClient", return_value=mock_http_client):
        res = await client.post(
            "/api/barista-ops-chat",
            json={"message": "Where should we deploy van #2 today?"},
        )

        assert res.status_code == 200
        data = res.json()
        assert "Cyber Towers" in data["replyText"]
        assert len(data["recommendedSpots"]) >= 1
