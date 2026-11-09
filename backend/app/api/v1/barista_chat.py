"""BREW Coffee Platform — AI Barista Customer & Ops Chat Endpoints."""

import os
import json
import time
import logging
from typing import Optional, List, Dict, Any
import httpx
from fastapi import APIRouter, Request, Response, HTTPException, status
from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.rate_limit import check_rate_limit, get_client_ip
from app.core.bounded_body import read_bounded_json
from app.domain.models.menu import MENU_ITEMS, MenuItem

router = APIRouter(tags=["AI Barista"])
logger = logging.getLogger(__name__)

_agent_cache: Dict[str, Dict[str, Any]] = {}
CACHE_TTL_SECONDS = 30 * 60  # 30 minutes

CURATED_PARKING_SPOTS = [
    {
        "id": "spot-cyber-towers",
        "spotName": "HITEC City — Cyber Towers",
        "city": "Hyderabad",
        "address": "Gate 2 Main Entrance, Madhapur",
        "expectedFootfall": "High (2,400 tech employees)",
    },
    {
        "id": "spot-mindspace",
        "spotName": "Mindspace IT Park — Circle",
        "city": "Hyderabad",
        "address": "Building 12 Roundabout, Hitech City",
        "expectedFootfall": "Very High (3,800 tech employees)",
    },
    {
        "id": "spot-jubilee-hills",
        "spotName": "Jubilee Hills — Road No. 36",
        "city": "Hyderabad",
        "address": "Metro Pillar 1650, Near Peddamma Temple",
        "expectedFootfall": "Medium-High (Evening Shoppers)",
    },
]


async def query_gemini_barista(message: str, history: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Outbound async request to Google Gemini 1.5 Flash for grounded beverage recommendations."""
    api_key = (
        settings.gemini_api_key
        or settings.google_genai_api_key
        or os.getenv("GEMINI_API_KEY")
        or os.getenv("GOOGLE_GENAI_API_KEY")
    )
    if not api_key:
        return None

    catalog_context = [
        {
            "id": m.id,
            "name": m.name,
            "category": m.category,
            "price": m.price,
            "description": m.description,
            "notes": m.notes,
        }
        for m in MENU_ITEMS
    ]

    system_prompt = f"""You are the master barista at "BREW", a luxury artisanal mobile coffee van.
Customers will describe their taste preferences, cravings, mood, or past orders.
Your goal is to warmly understand their taste and recommend 1 to 2 items strictly from the BREW menu catalog provided below.

BREW Menu Catalog:
{json.dumps(catalog_context)}

Respond in valid JSON with this exact structure:
{{
  "replyText": "Warm, engaging barista message explaining the choice in 2-3 sentences.",
  "recommendedItemIds": ["id-1", "id-2"],
  "reasons": ["Specific reason item 1 matches their taste", "Specific reason item 2 matches"],
  "quickReplies": ["Quick suggestion 1", "Quick suggestion 2"]
}}"""

    prompt_payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": f"{system_prompt}\n\nCustomer Chat History: {json.dumps(history[-4:])}\n\nCustomer said: \"{message}\""
                    }
                ],
            }
        ],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0.4,
        },
    }

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"

    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.post(url, json=prompt_payload)
            if resp.status_code == 200:
                data = resp.json()
                raw_text = (
                    data.get("candidates", [{}])[0]
                    .get("content", {})
                    .get("parts", [{}])[0]
                    .get("text")
                )
                if raw_text:
                    parsed = json.loads(raw_text)
                    rec_ids = parsed.get("recommendedItemIds", [])
                    reasons = parsed.get("reasons", [])
                    recs = []
                    for idx, rid in enumerate(rec_ids):
                        found = next((m for m in MENU_ITEMS if m.id == rid), None)
                        if found:
                            reason = (
                                reasons[idx]
                                if idx < len(reasons)
                                else "Special barista craft pick for your palate"
                            )
                            recs.append({"item": found.model_dump(), "reason": reason})

                    if recs:
                        return {
                            "replyText": parsed.get(
                                "replyText",
                                "Here is our handcrafted craft recommendation!",
                            ),
                            "recommendations": recs,
                            "quickReplies": parsed.get("quickReplies")
                            or [
                                "Suggest a dessert to pair with this",
                                "Something iced instead",
                                "Explore Full Menu",
                            ],
                        }
            elif resp.status_code == 429:
                logger.warning("Gemini API rate limit exceeded (HTTP 429), falling back to local engine.")
            else:
                logger.warning(f"Gemini API returned non-200 status {resp.status_code}, falling back to local engine.")
    except Exception as e:
        logger.warning(f"Gemini API call failed, falling back to local barista engine: {e}")

    return None


async def query_gemini_barista_ops(message: str, history: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Outbound async request to Google Gemini 1.5 Flash for fleet ops and barista assistance."""
    api_key = (
        settings.gemini_api_key
        or settings.google_genai_api_key
        or os.getenv("GEMINI_API_KEY")
        or os.getenv("GOOGLE_GENAI_API_KEY")
    )
    if not api_key:
        return None

    system_prompt = f"""You are the AI Fleet Dispatcher & Operations Copilot for "BREW", a luxury mobile coffee van company in Telangana and Andhra Pradesh.
You assist employees and baristas with:
1. Optimal van parking locations based on date, footfall, and business peak hours.
2. Checking fleet proximity to avoid clustering with other vans.
3. Reviewing stock and inventory depletion to maintain quality craft.

Fleet Hubs Database:
{json.dumps(CURATED_PARKING_SPOTS)}

Provide a direct, helpful, professional barista ops response in clean formatting."""

    prompt_payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": f"{system_prompt}\n\nEmployee Chat History: {json.dumps(history[-4:])}\n\nBarista asked: \"{message}\""
                    }
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0.3,
        },
    }

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={api_key}"

    try:
        async with httpx.AsyncClient(timeout=6.0) as client:
            resp = await client.post(url, json=prompt_payload)
            if resp.status_code == 200:
                data = resp.json()
                raw_text = (
                    data.get("candidates", [{}])[0]
                    .get("content", {})
                    .get("parts", [{}])[0]
                    .get("text")
                )
                if raw_text:
                    return {
                        "replyText": raw_text.strip(),
                        "recommendedSpots": CURATED_PARKING_SPOTS[:1],
                        "actionSuggestions": [
                            "Trigger bakery flash deal",
                            "Review curbside arrival bays",
                            "Check milk carton reserve",
                        ],
                        "quickReplies": [
                            "Best evening parking spot?",
                            "Analyze low ratings",
                            "Rain contingency plan",
                        ],
                    }
            elif resp.status_code == 429:
                logger.warning("Gemini Ops API rate limit exceeded (HTTP 429), falling back.")
            else:
                logger.warning(f"Gemini Ops API returned status {resp.status_code}, falling back.")
    except Exception as e:
        logger.warning(f"Gemini Ops API call failed, falling back: {e}")

    return None


@router.post("/api/barista-chat")
async def barista_chat_endpoint(request: Request, response: Response):
    """Customer Barista AI Assistant recommendations."""
    client_ip = get_client_ip(request)

    # Rate limiting: max 10 requests / 60s
    rate_res = await check_rate_limit(client_ip, "barista-chat", limit=10, window_seconds=60)
    response.headers["X-RateLimit-Limit"] = str(rate_res.limit)
    response.headers["X-RateLimit-Remaining"] = str(rate_res.remaining)
    response.headers["X-RateLimit-Reset"] = str(rate_res.reset)

    if not rate_res.success:
        retry_sec = max(1, rate_res.reset - int(time.time()))
        response.headers["Retry-After"] = str(retry_sec)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too Many Requests. AI Barista is crafting too many recommendations. Please wait a moment.",
        )

    body = await read_bounded_json(request)
    message = body.get("message")
    if not message or not isinstance(message, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Message is required",
        )

    history = body.get("history") or []

    # Cache check
    norm_query = message.strip().lower()
    cache_key = f"barista:{norm_query}"
    cached = _agent_cache.get(cache_key)
    if cached and cached.get("expires_at", 0) > time.time():
        cached_data = dict(cached["data"])
        cached_data["cached"] = True
        return cached_data

    # 1. Attempt outbound Gemini 1.5 Flash call
    gemini_res = await query_gemini_barista(message, history)
    if gemini_res:
        _agent_cache[cache_key] = {
            "data": gemini_res,
            "expires_at": time.time() + CACHE_TTL_SECONDS,
        }
        return gemini_res

    # 2. Deterministic heuristic recommendation fallback
    lower = norm_query
    pick1: MenuItem = MENU_ITEMS[0]  # Affogato
    pick2: MenuItem = MENU_ITEMS[3]  # Cold Brew

    if "sweet" in lower or "dessert" in lower or "sugar" in lower:
        pick1 = next((item for item in MENU_ITEMS if item.id == "c-1"), MENU_ITEMS[0])  # Affogato
        pick2 = next((item for item in MENU_ITEMS if item.id == "d-4"), MENU_ITEMS[22])  # Cinnamon Roll
        reply_text = (
            f"If you enjoy sweet, decadent notes, our barista craft pick is the **{pick1.name}**! "
            f"It pairs wonderfully with our fresh **{pick2.name}**."
        )
    elif "cold" in lower or "ice" in lower or "refresh" in lower:
        pick1 = next((item for item in MENU_ITEMS if item.id == "c-4"), MENU_ITEMS[3])  # Cold Brew
        pick2 = next((item for item in MENU_ITEMS if item.id == "c-8"), MENU_ITEMS[7])  # Iced Latte
        reply_text = (
            f"For an ice-cold handcrafted boost, we strongly recommend our 18-hr steeped **{pick1.name}**! "
            f"Smooth, zero bitterness, and naturally sweet."
        )
    else:
        reply_text = (
            f"Based on what you enjoy, our barista craft pick for you is the **{pick1.name}**! "
            f"It balances incredible depth with smooth artisanal notes. If you want an alternative or a sweet companion, also check out the **{pick2.name}**."
        )

    res_data = {
        "replyText": reply_text,
        "recommendations": [
            {
                "item": pick1.model_dump(),
                "reason": "Matches your taste: our supreme signature blend & artisanal notes.",
            },
            {
                "item": pick2.model_dump(),
                "reason": "Matches your taste: slow-steeped natural sweetness.",
            },
        ],
        "quickReplies": [
            "Suggest a dessert to pair with this",
            "Something iced instead",
            "Explore Full Menu",
        ],
    }

    _agent_cache[cache_key] = {
        "data": res_data,
        "expires_at": time.time() + CACHE_TTL_SECONDS,
    }

    return res_data


@router.post("/api/barista-ops-chat")
async def barista_ops_chat_endpoint(request: Request, response: Response):
    """Employee Barista & Fleet Operations Copilot Assistant."""
    client_ip = get_client_ip(request)

    # Rate limiting: max 15 requests / 60s
    rate_res = await check_rate_limit(client_ip, "barista-ops-chat", limit=15, window_seconds=60)
    response.headers["X-RateLimit-Limit"] = str(rate_res.limit)
    response.headers["X-RateLimit-Remaining"] = str(rate_res.remaining)
    response.headers["X-RateLimit-Reset"] = str(rate_res.reset)

    if not rate_res.success:
        retry_sec = max(1, rate_res.reset - int(time.time()))
        response.headers["Retry-After"] = str(retry_sec)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too Many Requests to AI Ops Copilot. Please wait a moment.",
        )

    body = await read_bounded_json(request)
    message = body.get("message")
    if not message or not isinstance(message, str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Message is required",
        )

    history = body.get("history") or []

    # Cache check
    norm_query = message.strip().lower()
    cache_key = f"barista_ops:{norm_query}"
    cached = _agent_cache.get(cache_key)
    if cached and cached.get("expires_at", 0) > time.time():
        cached_data = dict(cached["data"])
        cached_data["cached"] = True
        return cached_data

    # 1. Attempt outbound Gemini call
    gemini_res = await query_gemini_barista_ops(message, history)
    if gemini_res:
        _agent_cache[cache_key] = {
            "data": gemini_res,
            "expires_at": time.time() + CACHE_TTL_SECONDS,
        }
        return gemini_res

    # 2. Local fallback
    reply_text = (
        "Here are today's fleet dispatch insights: Station foot-traffic is projected to peak around 4:30 PM. "
        "Recommend maintaining 4 backup milk cartons and running the Late Afternoon Artisan flash bundle."
    )

    res_data = {
        "replyText": reply_text,
        "recommendedSpots": CURATED_PARKING_SPOTS[:1],
        "actionSuggestions": [
            "Trigger bakery flash deal",
            "Review curbside arrival bays",
            "Check milk carton reserve",
        ],
        "quickReplies": [
            "Best evening parking spot?",
            "Analyze low ratings",
            "Rain contingency plan",
        ],
    }

    _agent_cache[cache_key] = {
        "data": res_data,
        "expires_at": time.time() + CACHE_TTL_SECONDS,
    }

    return res_data
