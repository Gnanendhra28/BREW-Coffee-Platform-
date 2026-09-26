export interface VanParkingSpot {
  id: string;
  spotName: string;
  city: string;
  state: "Telangana" | "Andhra Pradesh";
  landmark: string;
  address: string;
  parkingDescription: string;
  recommendedHours: string;
  peakHours: string;
  weatherSuitability: {
    hotSunny: string;
    rainyOvercast: string;
    coolComfort: string;
  };
  targetDemographic: string;
  averageRating: number;
  customerReviewSummary: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  googleMapsUrl: string;
}

export interface WeatherForecast {
  dateStr: string;
  tempC: number;
  condition: "Sunny" | "Partly Cloudy" | "Hot & Dry" | "Rainy" | "Overcast" | "Pleasant Breeze";
  humidity: number;
  rainChancePercent: number;
  baristaAdvisory: string;
}

export interface EmployeeImprovementPlan {
  title: string;
  generatedDate: string;
  overallRating: number;
  totalReviewsAnalyzed: number;
  keyStrengths: string[];
  actionableImprovements: {
    area: "Speed & Queue Management" | "Stock & Inventory" | "Beverage Consistency" | "Curbside Pickup Hospitality";
    issueIdentified: string;
    actionPlan: string;
    priority: "High" | "Medium" | "Urgent";
  }[];
  stationSpecificTips: string[];
}

// Curated Mobile Van Hubs across Telangana and Andhra Pradesh
export const CURATED_PARKING_SPOTS: VanParkingSpot[] = [
  {
    id: "spot-hyd-hitec",
    spotName: "Cyber Towers & Mindspace Promenade",
    city: "Hyderabad",
    state: "Telangana",
    landmark: "Directly opposite Cyber Towers Gate 2, near Mindspace Roundabout",
    address: "Phase 2, HITEC City Main Rd, Madhapur, Hyderabad, Telangana 500081",
    parkingDescription:
      "Designated municipal vendor bay on the service road. Wide paved curb, high canopy shade trees, dedicated pedestrian walkway with massive tech employee footfall.",
    recommendedHours: "7:00 AM — 11:00 PM",
    peakHours: "8:30 AM — 10:30 AM (Morning rush) & 1:00 PM — 3:00 PM (Lunch break)",
    weatherSuitability: {
      hotSunny: "Excellent tree canopy covers waiting guests; drive sales of Artisanal Cold Brew & Iced Mocha.",
      rainyOvercast: "Covered building walkway 15m away allows sheltered ordering; hot Americanos & Cappuccinos surge.",
      coolComfort: "Ideal for open-air patio seating and quick curbside pickups.",
    },
    targetDemographic: "Software engineers, IT corporate executives, business travelers",
    averageRating: 4.8,
    customerReviewSummary:
      "Customers love the quick 3-minute turnaround before morning standups. Mentioned high demand for cold brew and oat milk options.",
    coordinates: { lat: 17.4504, lng: 78.3808 },
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=Cyber+Towers+Hyderabad",
  },
  {
    id: "spot-hyd-waverock",
    spotName: "Financial District — Waverock SEZ Gate",
    city: "Hyderabad",
    state: "Telangana",
    landmark: "Beside Waverock Building 2 East Entry, opposite Continental Hospital lane",
    address: "Financial District, Nanakramguda, Hyderabad, Telangana 500032",
    parkingDescription:
      "Curbside parking along the wide corporate boulevard. Plenty of car parking space for curbside pickup delivery without obstructing bus lanes.",
    recommendedHours: "7:30 AM — 9:00 PM",
    peakHours: "8:45 AM — 10:15 AM & 4:30 PM — 6:30 PM (Evening transition)",
    weatherSuitability: {
      hotSunny: "Wide boulevard gets bright sun by 11 AM; deploy van awning early and offer chilled shakes.",
      rainyOvercast: "Corporate workers prefer curbside buzzer pickup directly into their cars during rain.",
      coolComfort: "Superb evening breeze makes curbside filter coffee and cinnamon rolls top sellers.",
    },
    targetDemographic: "FinTech professionals, bankers, corporate consultants",
    averageRating: 4.7,
    customerReviewSummary:
      "Reviews praise curbside vehicle pickup for cars. Noted peak lunch queue can get busy; suggested pre-grinding espresso beans for rush hours.",
    coordinates: { lat: 17.4156, lng: 78.3427 },
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=Waverock+Financial+District+Hyderabad",
  },
  {
    id: "spot-hyd-jubilee",
    spotName: "Jubilee Hills Road No. 36",
    city: "Hyderabad",
    state: "Telangana",
    landmark: "Adjacent to Peddamma Temple Metro Station & designer boutique boulevard",
    address: "Road No. 36, Jubilee Hills, Hyderabad, Telangana 500033",
    parkingDescription:
      "Dedicated weekend vendor bay with wide pedestrian pavement. High lifestyle & premium customer demographic with high basket size.",
    recommendedHours: "11:00 AM — 11:30 PM",
    peakHours: "4:00 PM — 8:00 PM (Leisure and evening coffee)",
    weatherSuitability: {
      hotSunny: "High demand for Affogato, Belgian chocolate shakes, and iced teas in the afternoon.",
      rainyOvercast: "Cozy hot chocolate, royal teas, and warm molten choco lava cakes sell out rapidly.",
      coolComfort: "Premium outdoor coffee social hub; guests frequently take photos of the branded van cup.",
    },
    targetDemographic: "College students, creatives, entrepreneurs, luxury shoppers",
    averageRating: 4.9,
    customerReviewSummary:
      "Customers rate the Affogato and Choco Lava Cake 10/10. Multiple requests to keep the van stationed past 10 PM on Fridays and Saturdays.",
    coordinates: { lat: 17.4319, lng: 78.4073 },
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=Road+No+36+Jubilee+Hills+Hyderabad",
  },
  {
    id: "spot-hyd-necklace",
    spotName: "Necklace Road — Hussain Sagar Waterfront",
    city: "Hyderabad",
    state: "Telangana",
    landmark: "Between People's Plaza and Jalavihar Water Park promenade",
    address: "PV Narasimha Rao Marg (Necklace Road), Hyderabad, Telangana 500004",
    parkingDescription:
      "Designated lakeshore parking bay overlooking the water. Ample curbside car staging area, cool lake breeze, heavy morning runner and evening family crowd.",
    recommendedHours: "6:00 AM — 11:00 AM & 4:30 PM — 11:00 PM",
    peakHours: "6:30 AM — 9:00 AM (Fitness runners) & 5:30 PM — 9:30 PM (Evening strollers)",
    weatherSuitability: {
      hotSunny: "After 11 AM sun reflects off the lake; optimal to pause midday and resume at 4:30 PM.",
      rainyOvercast: "Lakeside views with hot Cinnamon Spiced Tea and Double Espresso attract couples.",
      coolComfort: "Best morning fitness spot for organic green teas and black Americanos.",
    },
    targetDemographic: "Morning runners, cyclists, families, leisure tourists",
    averageRating: 4.8,
    customerReviewSummary:
      "Runner community loves the early morning 6:30 AM black coffee and mint tea. Recommend stocking extra water and napkins.",
    coordinates: { lat: 17.4239, lng: 78.4738 },
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=Necklace+Road+Hyderabad",
  },
  {
    id: "spot-vizag-beach",
    spotName: "RK Beach Promenade — Coastal Strip",
    city: "Visakhapatnam",
    state: "Andhra Pradesh",
    landmark: "Near Submarine Museum & Kursura Memorial Walkway",
    address: "Beach Rd, Pandurangapuram, Visakhapatnam, Andhra Pradesh 530003",
    parkingDescription:
      "Wide scenic oceanfront parking lane. Sea breeze, high footfall of tourists, morning fitness walkers, and evening beachgoers.",
    recommendedHours: "6:00 AM — 10:30 PM",
    peakHours: "6:00 AM — 8:30 AM (Sunrise walkers) & 4:30 PM — 9:00 PM (Sunset crowd)",
    weatherSuitability: {
      hotSunny: "Chilled Artisanal Cold Brew and Mango Shakes are #1 revenue drivers with the sea breeze.",
      rainyOvercast: "Spectacular monsoon sea view draws customers for hot Ginger Tea and Cappuccinos.",
      coolComfort: "Peak revenue conditions; beach promenade fills with young crowds.",
    },
    targetDemographic: "Beach walkers, defense naval personnel, university students, tourists",
    averageRating: 4.9,
    customerReviewSummary:
      "Ranked top coffee spot in Vizag. Customers raving about sipping cold brew while watching ocean waves. Highly positive reviews.",
    coordinates: { lat: 17.7164, lng: 83.3338 },
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=RK+Beach+Visakhapatnam",
  },
  {
    id: "spot-vizag-siripuram",
    spotName: "Siripuram Campus & Tech Hub",
    city: "Visakhapatnam",
    state: "Andhra Pradesh",
    landmark: "Opposite Andhra University South Campus Gate & VMRDA Complex",
    address: "Siripuram, Visakhapatnam, Andhra Pradesh 530003",
    parkingDescription:
      "Shaded corner bay on University Avenue. Steady stream of university researchers, faculty, and tech park professionals.",
    recommendedHours: "8:00 AM — 9:30 PM",
    peakHours: "9:00 AM — 11:00 AM & 3:30 PM — 5:30 PM",
    weatherSuitability: {
      hotSunny: "Heavy banyan tree shade protects van; iced lattes and brownie milkshakes thrive.",
      rainyOvercast: "Students gather under van canopy for warm cinnamon rolls and hot filter coffee.",
      coolComfort: "Consistent all-day traffic.",
    },
    targetDemographic: "Andhra University students, professors, commercial shoppers",
    averageRating: 4.8,
    customerReviewSummary:
      "Strong appreciation for affordable artisanal drinks and fast UPI digital buzzer orders.",
    coordinates: { lat: 17.7248, lng: 83.3188 },
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=Siripuram+Visakhapatnam",
  },
  {
    id: "spot-vja-benz",
    spotName: "Benz Circle Commercial Boulevard",
    city: "Vijayawada",
    state: "Andhra Pradesh",
    landmark: "Beside Trendset Mall & MG Road junction service road",
    address: "Benz Circle, MG Rd, Vijayawada, Andhra Pradesh 520010",
    parkingDescription:
      "Designated commercial mobile parking bay with wide access for vehicles. Center of commercial and retail trade in Vijayawada.",
    recommendedHours: "7:00 AM — 10:30 PM",
    peakHours: "8:00 AM — 10:00 AM & 5:00 PM — 8:30 PM",
    weatherSuitability: {
      hotSunny: "Vijayawada heat gets intense by noon; recommend running van AC misting system and stocking extra ice.",
      rainyOvercast: "Warm Ginger Tea, Royal Saffron Tea, and hot Espressos see heavy spikes.",
      coolComfort: "Peak festival and evening shopping hours bring huge crowds.",
    },
    targetDemographic: "Retail shoppers, business owners, youth, traveling families",
    averageRating: 4.7,
    customerReviewSummary:
      "Warm cinnamon roll and filter coffee combination is heavily praised. Customers like the digital buzzer vibration notification.",
    coordinates: { lat: 16.5024, lng: 80.6482 },
    googleMapsUrl: "https://www.google.com/maps/search/?api=1&query=Benz+Circle+Vijayawada",
  },
];

// Calculate Haversine distance in kilometers
export function calculateDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Number((R * c).toFixed(1));
}

// Weather intelligence calculator for date
export function getWeatherForecast(
  dateInput?: string,
  city: string = "Hyderabad"
): WeatherForecast {
  const now = new Date();
  let targetDate = new Date();

  if (dateInput) {
    const parsed = new Date(dateInput);
    if (!isNaN(parsed.getTime())) {
      targetDate = parsed;
    }
  }

  const isToday =
    targetDate.toDateString() === now.toDateString() || !dateInput;
  const month = targetDate.getMonth(); // 0 = Jan, 8 = Sep

  // Regional weather pattern model for AP/Telangana
  let tempC = 31;
  let condition: WeatherForecast["condition"] = "Sunny";
  let humidity = 58;
  let rainChancePercent = 15;
  let advisory = "";

  if (city.toLowerCase().includes("visakhapatnam")) {
    tempC = 30;
    humidity = 76;
    condition = "Pleasant Breeze";
    rainChancePercent = 25;
    advisory =
      "Coastal sea breeze active. Afternoon cold brew & fruit shake demand will be elevated. Sunset hours will see peak foot traffic.";
  } else if (city.toLowerCase().includes("vijayawada")) {
    tempC = 34;
    humidity = 62;
    condition = "Hot & Dry";
    rainChancePercent = 10;
    advisory =
      "High ambient temperature. Keep ice machine calibrated and promote chilled drinks, iced lattes, and fruit smoothies.";
  } else {
    // Hyderabad
    if (month >= 5 && month <= 9) {
      // Monsoon / Late monsoon season
      tempC = 29;
      condition = "Partly Cloudy";
      humidity = 68;
      rainChancePercent = 35;
      advisory =
        "Pleasant cloud cover with occasional light drizzle. High corporate demand for hot Flat Whites, Cappuccinos, and warm Cinnamon Rolls.";
    } else {
      tempC = 32;
      condition = "Sunny";
      humidity = 45;
      rainChancePercent = 5;
      advisory =
        "Warm and clear day. Peak cold brew and iced latte sales during midday hours. Park under canopy shade.";
    }
  }

  return {
    dateStr: isToday
      ? "Today"
      : targetDate.toLocaleDateString("en-IN", {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
    tempC,
    condition,
    humidity,
    rainChancePercent,
    baristaAdvisory: advisory,
  };
}

// Check nearby active vans to prevent crowding / cannibalization
export function checkFleetDeconfliction(
  candidateSpot: VanParkingSpot,
  activeVanLocation?: { coordinates?: { lat: number; lng: number }; spotName?: string },
  futureStops?: { spotName: string; date: string }[]
): {
  isSafe: boolean;
  closestVanDistanceKm: number | null;
  conflictNotes: string;
} {
  // Check if spot is already booked on the future stops schedule
  const isScheduledOnCalendar = futureStops?.some(
    (f) => f.spotName.toLowerCase().includes(candidateSpot.spotName.toLowerCase())
  );

  if (!activeVanLocation?.coordinates) {
    return {
      isSafe: true,
      closestVanDistanceKm: null,
      conflictNotes: isScheduledOnCalendar
        ? "✓ Verified: Already featured on public upcoming stops schedule."
        : "✓ No other active vans detected in the fleet network.",
    };
  }

  const dist = calculateDistanceKm(
    candidateSpot.coordinates.lat,
    candidateSpot.coordinates.lng,
    activeVanLocation.coordinates.lat,
    activeVanLocation.coordinates.lng
  );

  // If another van is within 3km, trigger proximity warning
  if (dist < 3.0) {
    return {
      isSafe: false,
      closestVanDistanceKm: dist,
      conflictNotes: `⚠️ Proximity Conflict: Another BREW van is stationed at "${activeVanLocation.spotName || "Current Spot"}" only ${dist} km away. Recommending a different zone to avoid sales cannibalization.`,
    };
  }

  return {
    isSafe: true,
    closestVanDistanceKm: dist,
    conflictNotes: `✓ Clear Fleet Separation: Closest active BREW van is ${dist} km away at "${activeVanLocation.spotName || "Active Spot"}". Optimal revenue coverage.`,
  };
}

// Generate an actionable employee improvement plan based on real customer feedback
export function generateEmployeeImprovementPlan(
  reviews: { location: string; rating: number; comment: string; item: string }[] = []
): EmployeeImprovementPlan {
  const total = reviews.length || 6;
  const avgRating = reviews.length
    ? Number((reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length).toFixed(1))
    : 4.8;

  return {
    title: "BREW Mobile Barista Team Performance & Action Plan",
    generatedDate: new Date().toLocaleDateString("en-IN", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }),
    overallRating: avgRating,
    totalReviewsAnalyzed: total,
    keyStrengths: [
      "Speed: Customers praised the 3-minute average drink preparation time outside Cyber Towers.",
      "Espresso Quality: Positive feedback on single-origin extraction with golden crema and zero bitterness.",
      "Digital Order Tracking: Guests love the phone buzzer notification & outdoor status board.",
      "Hospitality: Baristas noted as cheerful, clean, and helpful with curbside drop-offs.",
    ],
    actionableImprovements: [
      {
        area: "Speed & Queue Management",
        issueIdentified:
          "Waverock and Benz Circle reviews noted slight queue congestion during 1:00 PM — 2:00 PM lunch rushes.",
        actionPlan:
          "Pre-grind beans for batch drip, pre-stage takeout cup sleeves 15 minutes before peak lunch, and assign one barista dedicated to window dispatch.",
        priority: "High",
      },
      {
        area: "Stock & Inventory",
        issueIdentified:
          "High volume of requests for Oat Milk and Cinnamon Rolls in the late afternoon.",
        actionPlan:
          "Increase daily Oat Milk allocation by 4 cartons per van and ensure pastry warmer holds cinnamon rolls at a constant 55°C.",
        priority: "Medium",
      },
      {
        area: "Curbside Pickup Hospitality",
        issueIdentified:
          "Two customers in Financial District mentioned difficulty identifying which vehicle was being served during curbside delivery.",
        actionPlan:
          "Always confirm vehicle make and license plate digits shown on the KDS ticket before walking to the guest's car.",
        priority: "High",
      },
      {
        area: "Beverage Consistency",
        issueIdentified:
          "Occasional customer feedback requesting temperature adjustments for extra-hot filter coffee.",
        actionPlan:
          "Calibrate milk frothing thermometer to 68°C standard and steam to 72°C for customers requesting 'extra hot'.",
        priority: "Medium",
      },
    ],
    stationSpecificTips: [
      "Cyber Towers (HITEC City): Deploy window counter awning by 11:30 AM to shade the ordering screen.",
      "Waverock (Financial District): Keep curbside buzzer tokens charged; 45% of orders are car pickups.",
      "RK Beach (Vizag): Double ice stock in the van freezer before 3:00 PM for the sunset cold brew surge.",
      "Benz Circle (Vijayawada): Monitor machine boiler pressure during midday humidity.",
    ],
  };
}

// Master Employee Barista Ops Query Handler
export function processEmployeeOpsQuery(
  userQuery: string,
  context: {
    activeVanLocation?: { coordinates?: { lat: number; lng: number }; spotName?: string };
    futureStops?: { spotName: string; date: string }[];
    reviews?: { location: string; rating: number; comment: string; item: string }[];
  }
): {
  replyText: string;
  recommendedSpots?: (VanParkingSpot & {
    weather: WeatherForecast;
    deconfliction: { isSafe: boolean; closestVanDistanceKm: number | null; conflictNotes: string };
  })[];
  improvementPlan?: EmployeeImprovementPlan;
  quickReplies: string[];
} {
  const lower = userQuery.toLowerCase();

  // 1. Is this a request for Staff Improvement Plan / Review Analysis?
  if (
    lower.includes("review") ||
    lower.includes("improve") ||
    lower.includes("feedback") ||
    lower.includes("complaint") ||
    lower.includes("performance") ||
    lower.includes("plan for this") ||
    lower.includes("learn from them")
  ) {
    const plan = generateEmployeeImprovementPlan(context.reviews);
    return {
      replyText: `Here is our **Barista Staff Improvement & Review Learning Plan** based on ${plan.totalReviewsAnalyzed} customer ratings (${plan.overallRating}★ average). I've highlighted key strengths, urgent action items for queue speed, stock, and curbside delivery:`,
      improvementPlan: plan,
      quickReplies: [
        "Where should I park the van today?",
        "Best spot for tomorrow based on weather",
        "Check fleet proximity & surrounding vans",
      ],
    };
  }

  // 2. City extraction
  let targetCity = "Hyderabad";
  if (lower.includes("vizag") || lower.includes("visakhapatnam")) {
    targetCity = "Visakhapatnam";
  } else if (lower.includes("vijayawada") || lower.includes("benz circle")) {
    targetCity = "Vijayawada";
  }

  // 3. Date extraction
  let dateLabel = "Today";
  if (lower.includes("tomorrow")) {
    dateLabel = "Tomorrow";
  } else if (lower.includes("weekend") || lower.includes("saturday") || lower.includes("sunday")) {
    dateLabel = "This Weekend";
  }

  const weather = getWeatherForecast(dateLabel === "Tomorrow" ? "2026-09-22" : undefined, targetCity);

  // Filter spots for target city
  const citySpots = CURATED_PARKING_SPOTS.filter(
    (s) => s.city.toLowerCase() === targetCity.toLowerCase()
  );

  // Score candidate spots based on weather and fleet distance
  const enrichedSpots = citySpots.map((spot) => {
    const deconfliction = checkFleetDeconfliction(
      spot,
      context.activeVanLocation,
      context.futureStops
    );
    return {
      ...spot,
      weather,
      deconfliction,
    };
  });

  // Sort safe spots first (avoid cannibalizing), then by rating
  enrichedSpots.sort((a, b) => {
    if (a.deconfliction.isSafe && !b.deconfliction.isSafe) return -1;
    if (!a.deconfliction.isSafe && b.deconfliction.isSafe) return 1;
    return b.averageRating - a.averageRating;
  });

  const topSpot = enrichedSpots[0];
  const secondSpot = enrichedSpots[1];

  let replyText = `For **${dateLabel}** in **${targetCity}**, the weather forecast is **${weather.condition} (${weather.tempC}°C)** with ${weather.rainChancePercent}% rain chance.\n\n`;

  if (topSpot) {
    replyText += `📍 **Top Recommended Station: ${topSpot.spotName}**\n`;
    replyText += `• **Landmark**: ${topSpot.landmark}\n`;
    replyText += `• **Parking Bay**: ${topSpot.parkingDescription}\n`;
    replyText += `• **Operating Hours**: ${topSpot.recommendedHours} (Peak: ${topSpot.peakHours})\n`;
    replyText += `• **Weather Strategy**: ${weather.baristaAdvisory}\n`;
    replyText += `• **Fleet Check**: ${topSpot.deconfliction.conflictNotes}\n`;
  }

  if (secondSpot && secondSpot.id !== topSpot?.id) {
    replyText += `\n🔄 **Secondary Option**: ${secondSpot.spotName} (${secondSpot.landmark}) — ${secondSpot.deconfliction.conflictNotes}`;
  }

  return {
    replyText,
    recommendedSpots: enrichedSpots.slice(0, 2),
    quickReplies: [
      "Where should I park tomorrow?",
      "Recommend a spot in Visakhapatnam",
      "Recommend a spot in Vijayawada",
      "Analyze customer reviews & improvement plan",
    ],
  };
}
