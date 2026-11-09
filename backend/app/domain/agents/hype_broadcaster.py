"""Agent 5: HyperLocal Hype Broadcaster Engine.

Generates contextual marketing copy across WhatsApp, Instagram,
Twitter/X, and SMS based on van stationing and live telemetry.
"""

import urllib.parse
from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class SocialBroadcastPost(BaseModel):
    platform: Literal["WhatsApp Status", "Instagram Story", "Twitter / X", "SMS Alert"]
    headline: str
    body: str
    hashtags: List[str]
    shareableUrl: str


class StationContext(BaseModel):
    spotName: str
    city: str
    landmark: str
    weatherCondition: Optional[str] = None
    tempC: Optional[float] = None


def generate_social_broadcast(station: StationContext) -> List[SocialBroadcastPost]:
    """Generates 4-channel broadcast campaign tailored to active station coordinates."""
    weather_note = (
        f"It's a {station.weatherCondition} ({int(station.tempC)}°C)"
        if station.weatherCondition and station.tempC is not None
        else "The coffee aroma is in the air"
    )

    clean_city = station.city.replace(" ", "")

    wa_msg = urllib.parse.quote(
        f"☕ The BREW Van is LIVE at {station.spotName}! Stop by for fresh artisanal coffee & warm pastries: https://brew-coffee.cafe/location"
    )

    tw_msg = urllib.parse.quote(
        f"🚨 The @BREWCoffee van is live at {station.spotName}! Serving fresh espresso & bakery pastries. Grab a cup: https://brew-coffee.cafe/location"
    )

    return [
        SocialBroadcastPost(
            platform="WhatsApp Status",
            headline=f"🚐 BREW Van Live at {station.spotName}!",
            body=(
                f"Hey {station.city}! ☕ {weather_note}. The BREW Van has parked at *{station.spotName}* ({station.landmark}).\n\n"
                f"✨ Serving slow-roasted Single-Origin Espresso, Chilled Cold Brew & warm baked treats curbside.\n\n"
                f"📲 Order ahead & pick up in 60 secs: https://brew-coffee.cafe/location"
            ),
            hashtags=["#BREWMobileCoffee", f"#{clean_city}Coffee", "#CurbsidePickup"],
            shareableUrl=f"https://wa.me/?text={wa_msg}",
        ),
        SocialBroadcastPost(
            platform="Instagram Story",
            headline=f"Van Sighted: {station.spotName}",
            body=(
                f"📍 *{station.spotName}* — {station.landmark}\n"
                f"☕ Double-shot espresso pulled fresh, velvety microfoam & freshly baked cinnamon rolls.\n"
                f"⏰ Open until 10:30 PM. See you at the window! 🚚💨"
            ),
            hashtags=["#SpecialtyCoffee", "#CoffeeVan", "#OutletOnWheels"],
            shareableUrl="https://www.instagram.com/",
        ),
        SocialBroadcastPost(
            platform="Twitter / X",
            headline=f"🚐 Sighted: BREW Van at {station.spotName}",
            body=(
                f"🚨 We are parked at {station.spotName} ({station.landmark})!\n"
                f"{weather_note}.\n\n"
                f"Pulling fresh single-origin shots & hot milk microfoam right now. ⚡ Pre-order curbside: https://brew-coffee.cafe/location"
            ),
            hashtags=["#BREW", "#SpecialtyCoffee", f"#{clean_city}"],
            shareableUrl=f"https://twitter.com/intent/tweet?text={tw_msg}",
        ),
        SocialBroadcastPost(
            platform="SMS Alert",
            headline="BREW Flash Station Update",
            body=(
                f"BREW Alert: Mobile Van is now stationing at {station.spotName}. "
                f"Skip the cafe queue—order on brew-coffee.cafe for rapid car pickup!"
            ),
            hashtags=["#BREWVan"],
            shareableUrl="",
        ),
    ]
