"""Tests for the 6 Autonomous AI Agents."""

import pytest
from app.domain.agents.inventory_sentinel import (
    InventoryStock,
    deduct_order_ingredients,
    analyze_stock_depletion,
)
from app.domain.agents.curbside_expediter import (
    parse_vehicle_details,
    calculate_haversine_distance_meters,
)
from app.domain.agents.yield_optimizer import (
    evaluate_yield_opportunity,
    generate_yield_flash_deal,
)
from app.domain.agents.event_concierge import generate_event_quotation
from app.domain.agents.hype_broadcaster import (
    StationContext,
    generate_social_broadcast,
)
from app.domain.agents.sentiment_guardian import analyze_review_sentiment


def test_agent1_inventory_sentinel():
    stock = InventoryStock(coffeeBeansKg=2.0, paperCups=20, bakeryPastries=5)
    # Deduct 2 cappuccinos and 1 roll
    deducted = deduct_order_ingredients(stock, [
        {"name": "Cappuccino", "quantity": 2},
        {"name": "Cinnamon Roll", "quantity": 1},
    ])
    assert deducted.paperCups == 17
    assert deducted.coffeeBeansKg == 1.964
    assert deducted.bakeryPastries == 4

    alerts = analyze_stock_depletion(deducted)
    assert len(alerts) >= 2


def test_agent2_curbside_expediter():
    parsed = parse_vehicle_details("White Hyundai Creta (TS 09 AB 1234) - Bay 2")
    assert parsed.plate == "TS 09 AB 1234"
    assert parsed.bay == "Bay #2"
    assert "Creta" in parsed.description

    # Cyber Towers (17.4504, 78.3808) to Inorbit Mall (17.4344, 78.3868)
    dist = calculate_haversine_distance_meters(17.4504, 78.3808, 17.4344, 78.3868)
    assert 1700 < dist < 2000  # ~1.8 km


def test_agent3_yield_optimizer():
    stock = InventoryStock(bakeryPastries=10)
    # Rainy weather trigger
    analysis_rain = evaluate_yield_opportunity(stock, weather_condition="thunderstorm")
    assert analysis_rain.shouldTrigger is True
    assert analysis_rain.reason == "weather"

    # Custom deal generation
    deal = generate_yield_flash_deal("Flat White", "Brownie", 380, discount_percent=25)
    assert deal.dealPrice == 285.0


def test_agent4_event_concierge():
    quote = generate_event_quotation(
        organization="TechCorp",
        location="HITEC City",
        crowd_size_str="200",
    )
    assert quote.estimatedCrowd == 200
    assert quote.baristasAssigned == 2
    assert len(quote.tiers) == 3
    # Classic: 200 * 180 + 1500 = 37,500
    assert quote.tiers[0].totalAmount == 37500.0


def test_agent5_hype_broadcaster():
    posts = generate_social_broadcast(
        StationContext(
            spotName="Cyber Towers",
            city="Hyderabad",
            landmark="Gate 2",
            weatherCondition="Breezy",
            tempC=24.0,
        )
    )
    assert len(posts) == 4
    platforms = [p.platform for p in posts]
    assert "WhatsApp Status" in platforms
    assert "Instagram Story" in platforms


def test_agent6_sentiment_guardian():
    # Negative review (rating 2)
    notice = analyze_review_sentiment("Ravi Kumar", 2, "The coffee was slow and wait time was too long.")
    assert notice is not None
    assert notice.sentiment == "negative"
    assert "wait time" in notice.detectedIssues[0].lower()
    assert notice.voucherCode.startswith("BREWCARE")
    assert notice.discountAmount == 50.0

    # Positive review (rating 5) -> returns None
    assert analyze_review_sentiment("Pooja", 5, "Best coffee ever!") is None
