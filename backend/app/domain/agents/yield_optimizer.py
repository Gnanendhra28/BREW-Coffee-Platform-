"""Agent 3: Dynamic Flash Deal & Yield Optimizer Engine.

Margin-guarded bundle optimization, bakery perishability clearance,
and weather/foot-traffic surge pricing.
"""

import time
from typing import Literal, List, Optional
from pydantic import BaseModel, Field
from .inventory_sentinel import InventoryStock


class FlashDealConfig(BaseModel):
    id: str = Field(default_factory=lambda: f"deal-{int(time.time() * 1000)}")
    isActive: bool = True
    title: str = Field(min_length=3)
    tagline: str = Field(min_length=3)
    discountPercent: float = Field(ge=5, le=75)
    triggerReason: Literal["weather", "bakery_spoilage_prevention", "manual"] = "weather"
    beverageName: str
    pastryName: str
    originalPrice: float = Field(gt=0)
    dealPrice: float = Field(gt=0)
    expiresAt: int = Field(gt=0)


DEFAULT_FLASH_DEAL = FlashDealConfig(
    id="deal-afternoon-combo",
    isActive=True,
    title="☕ Late Afternoon Artisan Pair",
    tagline="Slow-roasted Single-Origin Cappuccino + Warm Cinnamon Roll",
    discountPercent=25.0,
    triggerReason="bakery_spoilage_prevention",
    beverageName="Cappuccino",
    pastryName="Cinnamon Roll",
    originalPrice=400.0,
    dealPrice=300.0,
    expiresAt=int(time.time() * 1000) + 1000 * 60 * 60 * 2,
)

YIELD_PRESET_BUNDLES: List[FlashDealConfig] = [
    FlashDealConfig(
        id="deal-afternoon-combo",
        isActive=True,
        title="☕ Late Afternoon Artisan Pair",
        tagline="Slow-roasted Single-Origin Cappuccino + Warm Cinnamon Roll",
        discountPercent=25.0,
        triggerReason="bakery_spoilage_prevention",
        beverageName="Cappuccino",
        pastryName="Cinnamon Roll",
        originalPrice=400.0,
        dealPrice=300.0,
        expiresAt=int(time.time() * 1000) + 1000 * 60 * 60 * 2,
    ),
    FlashDealConfig(
        id="deal-rainy-warmth",
        isActive=True,
        title="🌧️ Rainy Afternoon Warmth Pair",
        tagline="Velvety Flat White + Fudgy Walnut Brownie",
        discountPercent=25.0,
        triggerReason="weather",
        beverageName="Flat White",
        pastryName="Walnut Brownie",
        originalPrice=380.0,
        dealPrice=285.0,
        expiresAt=int(time.time() * 1000) + 1000 * 60 * 60 * 2,
    ),
    FlashDealConfig(
        id="deal-sunset-chill",
        isActive=True,
        title="🌅 Sunset Cold Brew & Croissant",
        tagline="18-hr Steeped Cold Brew + Buttery Almond Croissant",
        discountPercent=25.0,
        triggerReason="bakery_spoilage_prevention",
        beverageName="Cold Brew",
        pastryName="Almond Croissant",
        originalPrice=400.0,
        dealPrice=300.0,
        expiresAt=int(time.time() * 1000) + 1000 * 60 * 60 * 2,
    ),
]


class YieldOpportunityAnalysis(BaseModel):
    shouldTrigger: bool
    reason: Literal["weather", "bakery_spoilage_prevention", "manual"]
    recommendedBundle: FlashDealConfig
    projectedWasteSavedRupees: float
    explanation: str


def evaluate_yield_opportunity(
    inventory: InventoryStock,
    current_hour: Optional[int] = None,
    weather_condition: Optional[str] = None,
) -> YieldOpportunityAnalysis:
    """Evaluates telemetry to autonomously suggest or launch yield-maximizing flash deals."""
    if current_hour is None:
        current_hour = time.localtime().tm_hour

    weather_lower = (weather_condition or "").lower()
    is_rainy = any(w in weather_lower for w in ["rain", "drizzle", "storm", "thunder"])

    # Signal 1: Weather Slump (Foot traffic down, drive demand via warm pair)
    if is_rainy:
        bundle = YIELD_PRESET_BUNDLES[1].model_copy()
        bundle.expiresAt = int(time.time() * 1000) + 1000 * 60 * 60 * 2
        return YieldOpportunityAnalysis(
            shouldTrigger=True,
            reason="weather",
            recommendedBundle=bundle,
            projectedWasteSavedRupees=max(12, inventory.bakeryPastries) * 140.0,
            explanation="Rain detected near van: street foot traffic dips ~35%. Auto-pulsed warm bundle to drive digital orders.",
        )

    # Signal 2: Bakery Spoilage Prevention (Past 3:00 PM with unsold pastries)
    if inventory.bakeryPastries > 6 and (current_hour >= 15 or current_hour <= 6):
        bundle = YIELD_PRESET_BUNDLES[0].model_copy()
        bundle.expiresAt = int(time.time() * 1000) + 1000 * 60 * 60 * 2
        return YieldOpportunityAnalysis(
            shouldTrigger=True,
            reason="bakery_spoilage_prevention",
            recommendedBundle=bundle,
            projectedWasteSavedRupees=float(inventory.bakeryPastries * 180),
            explanation=f"{inventory.bakeryPastries} fresh pastries remaining past 3:30 PM. Bundling with high-margin Cappuccino converts potential spoilage into ₹{inventory.bakeryPastries * 300} gross revenue.",
        )

    default_bundle = DEFAULT_FLASH_DEAL.model_copy()
    default_bundle.expiresAt = int(time.time() * 1000) + 1000 * 60 * 60 * 2
    return YieldOpportunityAnalysis(
        shouldTrigger=False,
        reason="manual",
        recommendedBundle=default_bundle,
        projectedWasteSavedRupees=0.0,
        explanation="Inventory burn rate and street foot traffic are optimal. Flash deal remains primed for manual barista launch.",
    )


def generate_yield_flash_deal(
    beverage_name: str,
    pastry_name: str,
    original_price: float,
    discount_percent: float = 25.0,
    trigger_reason: Literal["weather", "bakery_spoilage_prevention", "manual"] = "manual",
) -> FlashDealConfig:
    """Generates and validates a new custom flash deal."""
    deal_price = round(original_price * (1 - discount_percent / 100))
    now_ms = int(time.time() * 1000)

    return FlashDealConfig(
        id=f"deal-{now_ms}",
        isActive=True,
        title=f"⚡ {beverage_name} + {pastry_name} Flash Pair",
        tagline=f"Fresh artisanal pairing · Limited {int(discount_percent)}% OFF yield bundle",
        discountPercent=discount_percent,
        triggerReason=trigger_reason,
        beverageName=beverage_name,
        pastryName=pastry_name,
        originalPrice=original_price,
        dealPrice=deal_price,
        expiresAt=now_ms + 1000 * 60 * 60 * 2,
    )
