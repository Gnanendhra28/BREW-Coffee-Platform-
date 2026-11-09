"""Agent 1: Inventory Sentinel Engine.

Deterministic ingredient tracking, recipe consumption deduction,
and burn-rate stockout depletion analysis.
"""

import time
from typing import List, Literal, Dict, Any
from pydantic import BaseModel, Field


class InventoryStock(BaseModel):
    coffeeBeansKg: float = 6.2
    wholeMilkLiters: float = 12.5
    oatMilkLiters: float = 4.0
    vanillaGelatoTubs: float = 3.5
    paperCups: int = 68
    bakeryPastries: int = 14
    syrupsLiters: float = 2.8
    lastRestockedAt: int = Field(default_factory=lambda: int(time.time() * 1000))


class DepletionAlert(BaseModel):
    ingredient: str
    currentStock: str
    burnRatePerHour: str
    predictedDepletionTime: str
    severity: Literal["critical", "warning", "healthy"]
    recommendation: str


def deduct_order_ingredients(
    current: InventoryStock,
    items: List[Dict[str, Any]],
) -> InventoryStock:
    """Deducts ingredients mathematically according to standard beverage & bakery recipes."""
    stock = current.model_copy()

    for item in items:
        qty = int(item.get("quantity", 1))
        name = str(item.get("name", "")).lower()

        # Paper cups
        stock.paperCups = max(0, stock.paperCups - qty)

        # Coffee beans (avg 18g per espresso drink)
        if any(w in name for w in [
            "cappuccino", "espresso", "latte", "flat white",
            "americano", "cold brew", "affogato", "mocha"
        ]):
            stock.coffeeBeansKg = max(0.0, round(stock.coffeeBeansKg - 0.018 * qty, 3))

        # Milk (approx 0.18L per milk coffee, 0.22L per shake)
        if any(w in name for w in ["cappuccino", "latte", "flat white", "mocha"]):
            stock.wholeMilkLiters = max(0.0, round(stock.wholeMilkLiters - 0.18 * qty, 2))
        elif "shake" in name:
            stock.wholeMilkLiters = max(0.0, round(stock.wholeMilkLiters - 0.22 * qty, 2))

        # Vanilla gelato (approx 0.1 tub per affogato)
        if "affogato" in name:
            stock.vanillaGelatoTubs = max(0.0, round(stock.vanillaGelatoTubs - 0.1 * qty, 2))

        # Bakery pastries
        if any(w in name for w in [
            "cinnamon roll", "brownie", "lava", "bread",
            "cookie", "donut", "pastry", "cake"
        ]):
            stock.bakeryPastries = max(0, stock.bakeryPastries - qty)

    return stock


def analyze_stock_depletion(stock: InventoryStock) -> List[DepletionAlert]:
    """Evaluates inventory thresholds to predict stockouts and generate proactive alerts."""
    alerts: List[DepletionAlert] = []

    # Paper cups (Warning <= 25, Critical <= 15)
    if stock.paperCups <= 25:
        alerts.append(DepletionAlert(
            ingredient="Artisanal Paper Cups",
            currentStock=f"{stock.paperCups} cups remaining",
            burnRatePerHour="~18 cups/hr",
            predictedDepletionTime="Depleted in ~45 mins" if stock.paperCups <= 15 else "Depleted in ~1.2 hrs",
            severity="critical" if stock.paperCups <= 15 else "warning",
            recommendation="Prompt guests for reusable cup discount or fetch from mobile storage bay.",
        ))

    # Whole milk (Warning <= 5.0, Critical <= 3.0)
    if stock.wholeMilkLiters <= 5.0:
        alerts.append(DepletionAlert(
            ingredient="Farm Fresh Whole Milk",
            currentStock=f"{stock.wholeMilkLiters} L remaining",
            burnRatePerHour="~3.2 Liters/hr",
            predictedDepletionTime="Depleted in ~45 mins" if stock.wholeMilkLiters <= 3.0 else "Depleted in ~1.5 hrs",
            severity="critical" if stock.wholeMilkLiters <= 3.0 else "warning",
            recommendation="Procure 4 additional cartons or suggest Oat Milk / Americano alternatives.",
        ))

    # Coffee beans (Warning <= 2.0, Critical <= 1.0)
    if stock.coffeeBeansKg <= 2.0:
        alerts.append(DepletionAlert(
            ingredient="Single-Origin Coffee Beans",
            currentStock=f"{stock.coffeeBeansKg} kg remaining",
            burnRatePerHour="~0.75 kg/hr",
            predictedDepletionTime="Depleted in ~1 hr" if stock.coffeeBeansKg <= 1.0 else "Depleted in ~2.5 hrs",
            severity="critical" if stock.coffeeBeansKg <= 1.0 else "warning",
            recommendation="Open backup 2.5kg roasted batch bag from rear van vault.",
        ))

    # Bakery pastries (Warning <= 5)
    if stock.bakeryPastries <= 5:
        alerts.append(DepletionAlert(
            ingredient="Fresh Baked Goods",
            currentStock=f"{stock.bakeryPastries} pieces remaining",
            burnRatePerHour="~4 pcs/hr",
            predictedDepletionTime="Depleted in ~1 hr",
            severity="warning",
            recommendation="Toggle 86 (sold-out) on low-stock items or trigger final flash deal bundle.",
        ))

    return alerts
