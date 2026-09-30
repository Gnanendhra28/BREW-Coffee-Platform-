// Deterministic Fallback Message Templates for Agent 5: 📢 Hyper-Local Hype Broadcaster
// Guarantees zero hallucinations and safe commercial copy even if external LLM generation is unavailable or fails validation.

import { CampaignMessageCopy, MarketingOpportunity, StoreMarketingContext } from "./types";

export function generateFallbackTemplates(
  opportunity: MarketingOpportunity,
  context: StoreMarketingContext
): Partial<Record<"push" | "sms" | "whatsapp" | "social", CampaignMessageCopy>> {
  const storeName = context.storeName;
  const landmark = context.landmark;
  const storeUrl = `https://brewcoffee.van/menu?store=${encodeURIComponent(context.storeId)}`;

  switch (opportunity.type) {
    case "YIELD_FLASH_DEAL": {
      const promo = opportunity.promotionReference;
      const dealPrice = promo?.dealPrice ?? 300;
      const normalPrice = promo?.normalPrice ?? 400;
      const discount = promo?.discountPercent ?? 25;
      const product = opportunity.recommendedProducts[0] || "Artisan Brew & Pastry Pair";

      return {
        whatsapp: {
          channel: "whatsapp",
          headline: `⚡ Flash Deal: ${product} @ ₹${dealPrice}`,
          body: `Hey Coffee Lover! ☕ Our barista just rolled out a limited flash combo: ${product} for just ₹${dealPrice} (regular ₹${normalPrice}, save ${discount}%). Freshly baked and brewed at ${storeName}, ${landmark}. Ready for curbside or table pickup!`,
          ctaText: "Claim Flash Deal",
          ctaUrl: `${storeUrl}&deal=${promo?.id || "flash"}`,
          hashtags: ["#BREWCoffee", "#FreshPastry", "#FlashDeal", "#ArtisanCoffee"],
          tone: "urgent",
        },
        push: {
          channel: "push",
          headline: `⚡ ₹${dealPrice} Flash Deal: ${product}`,
          body: `Save ${discount}% on our fresh artisan combo at ${landmark}. Fresh batch, limited quantity!`,
          ctaText: "Order Now",
          ctaUrl: `${storeUrl}&deal=${promo?.id || "flash"}`,
          hashtags: ["#BREW"],
          tone: "urgent",
        },
        sms: {
          channel: "sms",
          headline: `BREW Alert: ${product}`,
          body: `BREW Flash Deal: Get ${product} for only ₹${dealPrice} (was ₹${normalPrice}). Stop by ${landmark} or order ahead: ${storeUrl}`,
          ctaText: "Tap to Order",
          ctaUrl: storeUrl,
          hashtags: [],
          tone: "urgent",
        },
        social: {
          channel: "social",
          headline: `🔥 AFTERNOON FLASH DROP AT ${context.city.toUpperCase()}`,
          body: `Freshly baked and poured! Grab our signature ${product} for ₹${dealPrice} (regularly ₹${normalPrice}). Available until stocks last at ${storeName} (${landmark}).`,
          ctaText: "Find the Van",
          ctaUrl: storeUrl,
          hashtags: ["#SpecialtyCoffee", "#FreshBakes", "#HyderabadFoodies", "#CoffeeVan"],
          tone: "playful",
        },
      };
    }

    case "RAIN_OPPORTUNITY": {
      const items = opportunity.recommendedProducts.join(" & ");
      return {
        whatsapp: {
          channel: "whatsapp",
          headline: `🌧️ Rainy Day Comfort at ${storeName}`,
          body: `Monsoon clouds outside? Warm up your spirit with a hot cup of ${items}. Parked right at ${landmark}. Curbside pickup available so you stay dry! ☔`,
          ctaText: "Order Warm Brew",
          ctaUrl: `${storeUrl}&tag=rain`,
          hashtags: ["#RainyDayCoffee", "#WarmBrews", "#MonsoonHyd"],
          tone: "friendly",
        },
        push: {
          channel: "push",
          headline: "🌧️ Cold rain outside? Hot coffee inside.",
          body: `Curbside pickup ready at ${landmark}. Order your warm ${opportunity.recommendedProducts[0]} in seconds.`,
          ctaText: "Get Warm Drink",
          ctaUrl: `${storeUrl}&tag=rain`,
          hashtags: ["#RainyBrews"],
          tone: "friendly",
        },
        sms: {
          channel: "sms",
          headline: "BREW Rain Comfort",
          body: `Stay warm! Fresh ${items} brewing now at BREW, ${landmark}. Curbside pickup available: ${storeUrl}`,
          ctaText: "Order Ahead",
          ctaUrl: storeUrl,
          hashtags: [],
          tone: "friendly",
        },
        social: {
          channel: "social",
          headline: "🌧️ RAINY DAY COFFEE VIBES",
          body: `Nothing pairs with the drizzle like piping hot specialty coffee and warm pastries. Find us parked at ${landmark}! ☕✨`,
          ctaText: "See Menu",
          ctaUrl: storeUrl,
          hashtags: ["#RainAndCoffee", "#HyderabadMonsoon", "#ArtisanCoffee"],
          tone: "friendly",
        },
      };
    }

    case "COLD_DRINK_OPPORTUNITY": {
      return {
        whatsapp: {
          channel: "whatsapp",
          headline: `☀️ Beat the Heat with Iced Artisanal Brews!`,
          body: `It's ${context.weather.temperatureC}°C outside! Cool down instantly with our slow-steeped Nitro Cold Brew and Iced Spanish Latte. Chilling at ${landmark}.`,
          ctaText: "Order Iced Brew",
          ctaUrl: `${storeUrl}&tag=iced`,
          hashtags: ["#BeatTheHeat", "#ColdBrew", "#IcedCoffee"],
          tone: "playful",
        },
        push: {
          channel: "push",
          headline: `☀️ ${context.weather.temperatureC}°C Heatwave? Iced Coffee Ready.`,
          body: `Grab a refreshing Cold Brew or Iced Latte at ${landmark}. 3-minute curbside pickup!`,
          ctaText: "Cool Down Now",
          ctaUrl: `${storeUrl}&tag=iced`,
          hashtags: ["#ColdBrew"],
          tone: "playful",
        },
        sms: {
          channel: "sms",
          headline: "BREW Chilled Coffee",
          body: `Hot afternoon? Refresh with iced specialty cold brews at BREW (${landmark}). Order ahead: ${storeUrl}`,
          ctaText: "Order Iced",
          ctaUrl: storeUrl,
          hashtags: [],
          tone: "playful",
        },
        social: {
          channel: "social",
          headline: "🧊 ICE COLD SPECIALTY BREWS ON TAP",
          body: `When the sun hits hard, our single-origin cold brews hit harder. 18-hour steep, crystal clear ice, maximum refreshing taste. Parked at ${landmark}!`,
          ctaText: "Get Iced Coffee",
          ctaUrl: storeUrl,
          hashtags: ["#ColdBrewSeason", "#IcedCoffee", "#CraftCoffee"],
          tone: "playful",
        },
      };
    }

    case "HOT_DRINK_OPPORTUNITY": {
      return {
        whatsapp: {
          channel: "whatsapp",
          headline: `☕ Cozy Up with Steaming Single-Origin Coffee`,
          body: `Crisp chilly breeze? Warm up your hands with a rich, silky Flat White or hand-poured single origin roast at ${landmark}.`,
          ctaText: "Order Hot Coffee",
          ctaUrl: `${storeUrl}&tag=hot`,
          hashtags: ["#CozyCoffee", "#SingleOrigin", "#BREW"],
          tone: "friendly",
        },
        push: {
          channel: "push",
          headline: "☕ Steaming Hot Flat White Waiting for You",
          body: `Freshly ground and pulled at ${landmark}. Perfect for this chilly weather!`,
          ctaText: "Warm Up",
          ctaUrl: `${storeUrl}&tag=hot`,
          hashtags: ["#HotCoffee"],
          tone: "friendly",
        },
        sms: {
          channel: "sms",
          headline: "BREW Warm Coffee",
          body: `Chilly breeze outside? Warm up with fresh single-origin brew at BREW (${landmark}). Order here: ${storeUrl}`,
          ctaText: "Order Hot",
          ctaUrl: storeUrl,
          hashtags: [],
          tone: "friendly",
        },
        social: {
          channel: "social",
          headline: "☕ STEAMING HOT ARTISAN BREWS",
          body: `Chilly weather calls for hot silky lattes and rich single-origin beans. Stop by our van at ${landmark} today!`,
          ctaText: "Order Now",
          ctaUrl: storeUrl,
          hashtags: ["#HotCoffee", "#SpecialtyRoast", "#HyderabadCoffee"],
          tone: "friendly",
        },
      };
    }

    case "AFTERNOON_SLUMP": {
      return {
        whatsapp: {
          channel: "whatsapp",
          headline: `⚡ 3 PM Work Slump? Double Shot to the Rescue!`,
          body: `Hit that afternoon wall? Recharge your focus with a fresh Double Shot Cortado & fresh Belgian brownie from ${storeName}, parked near ${landmark}. Curbside ready in 3 mins!`,
          ctaText: "Recharge Focus",
          ctaUrl: `${storeUrl}&tag=slump`,
          hashtags: ["#WorkFuel", "#AfternoonCoffee", "#EspressoRecharge"],
          tone: "playful",
        },
        push: {
          channel: "push",
          headline: "⚡ Beat the 3 PM Work Slump",
          body: `Your double-shot cortado & fudge brownie are 3 minutes away at ${landmark}.`,
          ctaText: "Recharge",
          ctaUrl: `${storeUrl}&tag=slump`,
          hashtags: ["#Espresso"],
          tone: "playful",
        },
        sms: {
          channel: "sms",
          headline: "BREW Slump Buster",
          body: `Need an afternoon recharge? Double shot espresso & treats ready at ${landmark}. Curbside pickup: ${storeUrl}`,
          ctaText: "Recharge Now",
          ctaUrl: storeUrl,
          hashtags: [],
          tone: "playful",
        },
        social: {
          channel: "social",
          headline: "⚡ FUEL YOUR AFTERNOON SPRINT",
          body: `Say goodbye to the 3 PM yawns. Grab an artisanal double shot and power through your workday. Find us at ${landmark}! 💻☕`,
          ctaText: "Order Curbside",
          ctaUrl: storeUrl,
          hashtags: ["#OfficeFuel", "#HyderabadWorkplace", "#SpecialtyEspresso"],
          tone: "playful",
        },
      };
    }

    case "MORNING_RUSH": {
      return {
        whatsapp: {
          channel: "whatsapp",
          headline: `🌅 Fast Morning Coffee on Your Commute!`,
          body: `Good morning! Skip the cafe lines. Order ahead for 3-minute curbside pickup at ${landmark}. Handcrafted Flat White + warm Butter Croissant ready as you pull up. 🚗☕`,
          ctaText: "Order Ahead",
          ctaUrl: `${storeUrl}&tag=morning`,
          hashtags: ["#MorningCommute", "#CurbsideCoffee", "#BREW"],
          tone: "friendly",
        },
        push: {
          channel: "push",
          headline: "🌅 Morning Coffee in 3 Mins",
          body: `Curbside pickup ready at ${landmark}. Pull up, grab your flat white, and conquer the day!`,
          ctaText: "Order Now",
          ctaUrl: `${storeUrl}&tag=morning`,
          hashtags: ["#MorningCoffee"],
          tone: "friendly",
        },
        sms: {
          channel: "sms",
          headline: "BREW Morning Coffee",
          body: `Good morning! Fresh brew & warm croissants ready at ${landmark}. Fast 3-min curbside pickup: ${storeUrl}`,
          ctaText: "Order Now",
          ctaUrl: storeUrl,
          hashtags: [],
          tone: "friendly",
        },
        social: {
          channel: "social",
          headline: "🌅 MORNING COMMUTE FUEL",
          body: `On your way into work? Stop by BREW at ${landmark} for single-origin pour-overs, flat whites, and fresh pastries! 🚗💨`,
          ctaText: "Order Commute Brew",
          ctaUrl: storeUrl,
          hashtags: ["#MorningCoffee", "#DriveThruCoffee", "#HyderabadBrews"],
          tone: "friendly",
        },
      };
    }

    case "LOCAL_EVENT":
    default: {
      return {
        whatsapp: {
          channel: "whatsapp",
          headline: `🎪 Pop-up Alert: ${storeName} is Here!`,
          body: `We are parked right near ${landmark}! Grab your favorite handcrafted brew and fresh bakes on the go.`,
          ctaText: "See Live Menu",
          ctaUrl: storeUrl,
          hashtags: ["#PopUpCoffee", "#BREWOnWheels"],
          tone: "friendly",
        },
        push: {
          channel: "push",
          headline: `🎪 BREW Mobile Van is at ${landmark}`,
          body: "Handcrafted coffee on wheels. Stop by for your favorite brew!",
          ctaText: "View Menu",
          ctaUrl: storeUrl,
          hashtags: ["#BREW"],
          tone: "friendly",
        },
        sms: {
          channel: "sms",
          headline: "BREW Pop-up Alert",
          body: `BREW Mobile Coffee Van is parked at ${landmark}. Order ahead: ${storeUrl}`,
          ctaText: "Order Now",
          ctaUrl: storeUrl,
          hashtags: [],
          tone: "friendly",
        },
        social: {
          channel: "social",
          headline: `📍 BREW ON WHEELS: NOW AT ${landmark.toUpperCase()}`,
          body: `Come say hi and grab a freshly poured specialty brew! Parked right at ${landmark}. 🚚✨`,
          ctaText: "Find Us",
          ctaUrl: storeUrl,
          hashtags: ["#CoffeeVan", "#SpecialtyCoffee", "#Hyderabad"],
          tone: "playful",
        },
      };
    }
  }
}
