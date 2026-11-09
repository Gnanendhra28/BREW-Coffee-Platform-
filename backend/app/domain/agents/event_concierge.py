"""Agent 4: Autonomous Event Quoter & Catering Concierge Engine.

Calculates barista staffing, crowd consumption matrix,
ingredient requirements, and 3-tier catering quotation.
"""

import math
import re
from typing import List, Optional, Literal
from pydantic import BaseModel, Field


class EventQuotationTier(BaseModel):
    name: Literal["Classic Brew", "Artisanal Signature", "VIP Unlimited Bar"]
    pricePerGuest: float
    totalAmount: float
    perks: List[str]
    isRecommended: Optional[bool] = False


class IngredientAllocation(BaseModel):
    coffeeBeansKg: float
    milkLiters: float
    cupsCount: int
    pastriesCount: int


class EventQuotation(BaseModel):
    organization: str
    location: str
    estimatedCrowd: int
    baristasAssigned: int
    vanOperationalHours: str
    powerRequirement: str = "16A Single Phase (or Van Internal Silent Inverter)"
    ingredientAllocation: IngredientAllocation
    tiers: List[EventQuotationTier]
    travelDistanceFee: float = 1500.0
    terms: str = (
        "Includes complete curbside bar setup, outdoor QR board, live barista service, "
        "paper cups, sleeves & napkins."
    )


def generate_event_quotation(
    organization: Optional[str] = None,
    location: Optional[str] = None,
    crowd_size_str: Optional[str] = None,
    event_date: Optional[str] = None,
) -> EventQuotation:
    """Calculates crowd consumption, staffing, and 3-tier catering quotation."""
    crowd = 120
    if crowd_size_str:
        digits = re.sub(r"\D", "", str(crowd_size_str))
        if digits:
            num = int(digits)
            if num > 0:
                crowd = num

    baristas_assigned = 3 if crowd > 250 else (2 if crowd > 100 else 1)
    beans_kg = round(crowd * 1.3 * 0.018, 1)
    milk_liters = round(crowd * 1.3 * 0.16, 1)
    cups_count = math.ceil(crowd * 1.4)
    pastries_count = math.ceil(crowd * 0.7)

    tiers = [
        EventQuotationTier(
            name="Classic Brew",
            pricePerGuest=180.0,
            totalAmount=float(crowd * 180 + 1500),
            perks=[
                "Single-Origin Espresso, Americano, Classic Filter Coffee",
                "Imperial Black & Herbal Green Teas",
                "1 Dedicated Certified Barista",
            ],
            isRecommended=False,
        ),
        EventQuotationTier(
            name="Artisanal Signature",
            pricePerGuest=260.0,
            totalAmount=float(crowd * 260 + 1500),
            isRecommended=True,
            perks=[
                "Full Coffee Menu: Flat Whites, Cappuccinos, Cold Brew, Mochas",
                "Whole Milk & Vegan Oat Milk bar",
                "Fresh Cinnamon Roll & Brownie Bites pairing",
                "2 Dedicated Baristas for rapid 45s service speed",
                "Digital Order Board display with custom host branding",
            ],
        ),
        EventQuotationTier(
            name="VIP Unlimited Bar",
            pricePerGuest=360.0,
            totalAmount=float(crowd * 360 + 1500),
            isRecommended=False,
            perks=[
                "Unlimited Specialty Coffees, Belgian Shakes & Mango Coolers",
                "Full Artisan Bakery spread (Tiramisu cups, Choco Lava, Cookies)",
                "Dedicated 3-Barista Crew + Curbside Express Handover",
                "Personalized cup branding stickers for your company",
            ],
        ),
    ]

    return EventQuotation(
        organization=organization or "Corporate / Campus Host",
        location=location or "City Hub",
        estimatedCrowd=crowd,
        baristasAssigned=baristas_assigned,
        vanOperationalHours="4 Hours Dedicated On-Site Window Service",
        powerRequirement="16A Single Phase (or Van Internal Silent Inverter)",
        ingredientAllocation=IngredientAllocation(
            coffeeBeansKg=beans_kg,
            milkLiters=milk_liters,
            cupsCount=cups_count,
            pastriesCount=pastries_count,
        ),
        travelDistanceFee=1500.0,
        terms="Includes complete curbside bar setup, outdoor QR board, live barista service, paper cups, sleeves & napkins.",
        tiers=tiers,
    )
