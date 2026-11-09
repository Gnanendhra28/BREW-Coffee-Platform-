"""BREW Coffee Platform — Real-Time Event Hub & SSE Broadcast Service."""

import asyncio
import time
from typing import Dict, Any, List, Set
from pydantic import BaseModel
from app.domain.agents.inventory_sentinel import InventoryStock
from app.domain.agents.yield_optimizer import FlashDealConfig, DEFAULT_FLASH_DEAL


class ServerRealtimeEvent(BaseModel):
    type: str
    payload: Any
    timestamp: int


_subscribers: Set[asyncio.Queue] = set()

_state_orders: List[Dict[str, Any]] = [
    {
        "id": "ord-101",
        "orderNumber": "101",
        "customerName": "Arjun Reddy",
        "items": [
            {"id": "c-3", "name": "Single-Origin Cappuccino", "price": 220, "image": "/assets/cup1.png", "category": "Coffee", "quantity": 1},
            {"id": "d-4", "name": "Cinnamon Roll", "price": 180, "image": "/assets/desserts /Cinnamon Roll.png", "category": "Desserts", "quantity": 1},
        ],
        "notes": "Oat milk for cappuccino please!",
        "totalAmount": 400,
        "status": "ready",
        "createdAt": int(time.time() * 1000) - 1000 * 60 * 12,
        "prepProgress": 100,
        "vehicleInfo": "White Hyundai Creta (TS 09 AB 1234) - Bay 2",
        "isCurbside": True,
        "vanLocationName": "HITEC City — Cyber Towers (Hyderabad)",
    },
    {
        "id": "ord-102",
        "orderNumber": "102",
        "customerName": "Priya Sharma",
        "items": [
            {"id": "c-4", "name": "18-hr Cold Brew", "price": 240, "image": "/assets/cup2.png", "category": "Coffee", "quantity": 1},
            {"id": "d-2", "name": "Brownie Bite", "price": 140, "image": "/assets/desserts /Brownie Bite.png", "category": "Desserts", "quantity": 2},
        ],
        "notes": "Extra black cherry notes if possible!",
        "totalAmount": 520,
        "status": "brewing",
        "createdAt": int(time.time() * 1000) - 1000 * 60 * 6,
        "prepProgress": 65,
        "vehicleInfo": "Grey Honda City (TS 07 CD 5678) - Bay 1",
        "isCurbside": True,
        "vanLocationName": "HITEC City — Cyber Towers (Hyderabad)",
    },
]

_state_inventory = InventoryStock()
_state_flash_deal = DEFAULT_FLASH_DEAL.model_dump()
_state_van_location = {
    "spotName": "HITEC City — Cyber Towers",
    "city": "Hyderabad",
    "coordinates": {"lat": 17.4504, "lng": 78.3808},
    "currentAddress": "Opposite Inorbit Mall Road, Madhapur, Hyderabad, Telangana 500081",
    "activeHours": "7:00 AM – 11:00 PM Daily",
    "landmark": "Near Main Entrance Gate 2, Under the Gulmohar Trees",
}


def get_realtime_snapshot() -> Dict[str, Any]:
    """Returns current system snapshot for newly connecting SSE clients."""
    return {
        "orders": _state_orders,
        "inventory": _state_inventory.model_dump(),
        "vanLocation": _state_van_location,
        "flashDeal": _state_flash_deal,
        "activeOrders": len(_state_orders),
    }


def broadcast_event(event_type: str, payload: Any) -> None:
    """Dispatches a real-time event to all active SSE queues."""
    event = ServerRealtimeEvent(
        type=event_type,
        payload=payload,
        timestamp=int(time.time() * 1000),
    )

    # Mutate internal state if applicable
    if event_type == "ORDER_CREATED" and isinstance(payload, dict):
        _state_orders.insert(0, payload)
    elif event_type == "ORDER_STATUS_CHANGED" and isinstance(payload, dict):
        order_id = payload.get("orderId")
        new_status = payload.get("status")
        for ord_item in _state_orders:
            if ord_item.get("id") == order_id:
                ord_item["status"] = new_status
                break

    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except Exception:
            pass


async def subscribe_sse():
    """Generator yielding Server-Sent Events with keep-alive pings."""
    q = asyncio.Queue()
    _subscribers.add(q)

    # Yield initial snapshot immediately
    initial = ServerRealtimeEvent(
        type="INITIAL_SYNC",
        payload=get_realtime_snapshot(),
        timestamp=int(time.time() * 1000),
    )
    yield f"data: {initial.model_dump_json()}\n\n"

    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=20.0)
                yield f"data: {event.model_dump_json()}\n\n"
            except asyncio.TimeoutError:
                # 20s keep-alive ping to prevent proxy disconnections
                yield ": ping\n\n"
    finally:
        _subscribers.discard(q)
