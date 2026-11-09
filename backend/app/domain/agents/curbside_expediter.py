"""Agent 2: Curbside Drive-Thru Expediter Engine.

Calculates vehicle metadata, preparation times, arrival buffers,
priority ranking, and sub-60s SLA compliance metrics.
"""

import math
import re
from typing import Dict, List, Optional, Literal
from pydantic import BaseModel, Field

ITEM_PREPARATION_DURATIONS: Dict[str, int] = {
    "latte": 90,
    "cappuccino": 90,
    "mocha": 90,
    "flat white": 80,
    "caramel macchiato": 90,
    "espresso": 45,
    "double espresso": 45,
    "cortado": 45,
    "americano": 45,
    "classic filter coffee": 50,
    "affogato": 40,
    "cold brew": 15,
    "vanilla bean cold brew": 20,
    "iced latte": 45,
    "earl grey": 60,
    "masala chai": 60,
    "green tea": 45,
    "assam gold": 50,
    "belgian dark chocolate shake": 75,
    "salted caramel shake": 75,
    "strawberry cream shake": 75,
    "croissant": 20,
    "cinnamon roll": 20,
    "classic brownie": 20,
    "choco lava cake": 25,
    "blueberry crumble muffin": 20,
    "banana walnut bread": 20,
    "almond biscotti": 15,
}


class ParsedVehicleInfo(BaseModel):
    plate: str
    bay: str
    description: str
    raw: str


def parse_vehicle_details(vehicle_info: Optional[str] = None) -> ParsedVehicleInfo:
    """Parses vehicle info string into plate, bay, and description."""
    if not vehicle_info or not vehicle_info.strip():
        return ParsedVehicleInfo(
            plate="Unknown Plate",
            bay="General Curb",
            description="Customer Vehicle (Hazard lights on)",
            raw="",
        )

    raw = vehicle_info.strip()

    plate_match = re.search(r"\(([^)]+)\)", raw)
    plate = plate_match.group(1).strip() if plate_match else "Unknown Plate"

    bay_match = re.search(r"Bay\s*#?([0-9A-Za-z]+)", raw, re.IGNORECASE)
    bay = f"Bay #{bay_match.group(1).strip()}" if bay_match else "General Curb"

    cleaned = re.sub(r"\([^)]*\)", "", raw)
    cleaned = re.sub(r"-.*bay.*$", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"-.*$", "", cleaned).strip()

    return ParsedVehicleInfo(
        plate=plate,
        bay=bay,
        description=cleaned or "Customer Vehicle",
        raw=raw,
    )


def calculate_haversine_distance_meters(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> float:
    """Computes great-circle distance between two GPS coordinates in meters."""
    r = 6371000.0  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(delta_phi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    )
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    return r * c


def estimate_order_prep_seconds(items: List[Dict[str, int]]) -> int:
    """Estimates parallel preparation seconds across beverage and bakery stations."""
    bev_seconds = 0
    food_seconds = 0

    for item in items:
        name = str(item.get("name", "")).lower()
        qty = int(item.get("quantity", 1))

        unit_sec = 60
        for k, v in ITEM_PREPARATION_DURATIONS.items():
            if k in name:
                unit_sec = v
                break

        if any(w in name for w in ["roll", "brownie", "cake", "bread", "croissant", "muffin", "biscotti", "cookie", "donut"]):
            food_seconds += unit_sec * qty
        else:
            bev_seconds += unit_sec * qty

    # Parallel station execution: Max station time + 20% handover buffer
    return int(max(bev_seconds, food_seconds) * 1.2)
