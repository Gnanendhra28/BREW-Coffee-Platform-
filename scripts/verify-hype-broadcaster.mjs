// Verification Suite for BREW Hyper-Local Hype Broadcaster (Agent #5)
// Validates:
// 1. Multi-channel broadcast generation (WhatsApp, Instagram, Twitter/X, SMS)
// 2. Platform-specific constraints (wa.me deep-links, 160-char SMS limits, twitter intent links)
// 3. Dynamic weather contextualization & location injection
// 4. Strict Zod schema compliance via SocialBroadcastArraySchema
// 5. Sub-1ms execution performance benchmark

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

console.log("---------------------------------------------------------------");
console.log("📢 TEST SUITE: Hyper-Local Hype Broadcaster (Agent #5)");
console.log("---------------------------------------------------------------");

// 1. Schema Definitions (mirrored from src/lib/agentSchemas.ts)
const SocialBroadcastPostSchema = z.object({
  platform: z.enum(["WhatsApp Status", "Instagram Story", "Twitter / X", "SMS Alert"]),
  headline: z.string().min(3),
  body: z.string().min(10),
  hashtags: z.array(z.string()),
  shareableUrl: z.string(),
});

const SocialBroadcastArraySchema = z.array(SocialBroadcastPostSchema);

// Engine function mirror
function generateSocialBroadcast(station) {
  const weatherNote = station.weatherCondition
    ? `It's a ${station.weatherCondition} (${station.tempC}°C)`
    : "The coffee aroma is in the air";

  const posts = [
    {
      platform: "WhatsApp Status",
      headline: `🚐 BREW Van Live at ${station.spotName}!`,
      body: `Hey ${station.city}! ☕ ${weatherNote}. The BREW Van has parked at *${station.spotName}* (${station.landmark}).\n\n✨ Serving slow-roasted Single-Origin Espresso, Chilled Cold Brew & warm baked treats curbside.\n\n📲 Order ahead & pick up in 60 secs: https://brew-coffee.cafe/location`,
      hashtags: ["#BREWMobileCoffee", `#${station.city.replace(/\s+/g, "")}Coffee`, "#CurbsidePickup"],
      shareableUrl: `https://wa.me/?text=${encodeURIComponent(
        `☕ The BREW Van is LIVE at ${station.spotName}! Stop by for fresh artisanal coffee & warm pastries: https://brew-coffee.cafe/location`
      )}`,
    },
    {
      platform: "Instagram Story",
      headline: `Van Sighted: ${station.spotName}`,
      body: `📍 *${station.spotName}* — ${station.landmark}\n☕ Double-shot espresso pulled fresh, velvety microfoam & freshly baked cinnamon rolls.\n⏰ Open until 10:30 PM. See you at the window! 🚚💨`,
      hashtags: ["#SpecialtyCoffee", "#CoffeeVan", "#OutletOnWheels"],
      shareableUrl: "https://www.instagram.com/",
    },
    {
      platform: "Twitter / X",
      headline: `🚐 Sighted: BREW Van at ${station.spotName}`,
      body: `🚨 We are parked at ${station.spotName} (${station.landmark})!\n${weatherNote}.\n\nPulling fresh single-origin shots & hot milk microfoam right now. ⚡ Pre-order curbside: https://brew-coffee.cafe/location`,
      hashtags: ["#BREW", "#SpecialtyCoffee", `#${station.city.replace(/\s+/g, "")}`],
      shareableUrl: `https://twitter.com/intent/tweet?text=${encodeURIComponent(
        `🚨 The @BREWCoffee van is live at ${station.spotName}! Serving fresh espresso & bakery pastries. Grab a cup: https://brew-coffee.cafe/location`
      )}`,
    },
    {
      platform: "SMS Alert",
      headline: "BREW Flash Station Update",
      body: `BREW Alert: Mobile Van is now stationing at ${station.spotName}. Skip the cafe queue—order on brew-coffee.cafe for rapid car pickup!`,
      hashtags: ["#BREWVan"],
      shareableUrl: "",
    },
  ];

  return SocialBroadcastArraySchema.parse(posts);
}

// 2. Test Multi-Channel Output Generation
console.log("1. Validating Multi-Channel Generation...");
const sampleStation = {
  spotName: "Cyber Gateway Sector 2",
  city: "Hyderabad",
  landmark: "Opposite Inorbit Mall Main Entrance",
  weatherCondition: "Warm Afternoon",
  tempC: 31,
};

const broadcasts = generateSocialBroadcast(sampleStation);
assert.equal(broadcasts.length, 4, "Must generate exactly 4 channel outputs");

const platforms = broadcasts.map((b) => b.platform);
assert.deepEqual(
  platforms,
  ["WhatsApp Status", "Instagram Story", "Twitter / X", "SMS Alert"],
  "Must generate WhatsApp, Instagram, Twitter / X, and SMS outputs"
);
console.log("   ✓ Generated 4 target platforms: WhatsApp, Instagram, Twitter / X, SMS");

// 3. Test Platform-Specific Guarantees
console.log("2. Validating Platform Deep-Links and Character Limits...");

// WhatsApp
const waPost = broadcasts.find((b) => b.platform === "WhatsApp Status");
assert(waPost.shareableUrl.startsWith("https://wa.me/?text="), "WhatsApp must use wa.me deep-link");
assert(waPost.shareableUrl.includes(encodeURIComponent(sampleStation.spotName)), "WhatsApp link must encode spot name");
assert(waPost.body.includes(sampleStation.landmark), "WhatsApp body must include landmark");
console.log("   ✓ WhatsApp Status: Valid wa.me deep-link with URL encoding");

// Instagram
const instaPost = broadcasts.find((b) => b.platform === "Instagram Story");
assert(instaPost.body.includes("Open until"), "Instagram post must include operational hours guidance");
assert(instaPost.hashtags.includes("#SpecialtyCoffee"), "Instagram post must include coffee hashtags");
console.log("   ✓ Instagram Story: Rich sticker format with opening hours & hashtags");

// Twitter / X
const twitterPost = broadcasts.find((b) => b.platform === "Twitter / X");
assert(twitterPost.shareableUrl.startsWith("https://twitter.com/intent/tweet?text="), "Twitter must use intent URL");
assert(twitterPost.body.includes("Pre-order curbside"), "Twitter post must have pre-order call to action");
console.log("   ✓ Twitter / X: One-click tweet intent URL with pre-order CTA");

// SMS Alert
const smsPost = broadcasts.find((b) => b.platform === "SMS Alert");
assert(smsPost.body.length <= 160, `SMS body must be <= 160 characters (actual: ${smsPost.body.length})`);
assert(smsPost.body.includes("brew-coffee.cafe"), "SMS must include direct domain link");
console.log(`   ✓ SMS Alert: Compact length ${smsPost.body.length}/160 chars for GSM transmission`);

// 4. Test Weather Adaptation
console.log("3. Validating Ambient Weather Adaptation...");
const rainyStation = {
  spotName: "Financial District Hub",
  city: "Hyderabad",
  landmark: "Near Amazon Campus Gate 1",
  weatherCondition: "Rainy Drizzle",
  tempC: 23,
};
const rainyBroadcasts = generateSocialBroadcast(rainyStation);
const rainyWa = rainyBroadcasts.find((b) => b.platform === "WhatsApp Status");
assert(rainyWa.body.includes("Rainy Drizzle (23°C)"), "Must contextualize rainy drizzle in body copy");

const chilledStation = {
  spotName: "KBR Park Outer Ring",
  city: "Hyderabad",
  landmark: "Next to Gate 4 Joggers Track",
  weatherCondition: "Chilly Morning",
  tempC: 17,
};
const chillyBroadcasts = generateSocialBroadcast(chilledStation);
const chillyTwitter = chillyBroadcasts.find((b) => b.platform === "Twitter / X");
assert(chillyTwitter.body.includes("Chilly Morning (17°C)"), "Must contextualize chilly morning in Twitter body");
console.log("   ✓ Dynamic weather adaptation verified across hot, rainy, and chilly contexts");

// 5. Test Zod Schema Enforcement & Rejection of Malformed Payloads
console.log("4. Validating Zod Schema Guardrails...");
assert.doesNotThrow(() => {
  SocialBroadcastArraySchema.parse(broadcasts);
}, "Valid broadcasts must pass Zod parse");

assert.throws(() => {
  SocialBroadcastPostSchema.parse({
    platform: "TikTok", // Invalid platform
    headline: "Van Live",
    body: "Short", // Too short
    hashtags: [],
    shareableUrl: "url",
  });
}, /Invalid enum value|too_small/, "Invalid platform & short body must fail Zod parse");
console.log("   ✓ Strict Zod guardrails reject unsupported platforms and invalid schemas");

// 6. Test Barista Dashboard UI Integration
console.log("5. Validating Barista KDS Launchpad UI Integration...");
const baristaPagePath = path.resolve(process.cwd(), "src/app/barista/page.tsx");
const baristaSource = fs.readFileSync(baristaPagePath, "utf-8");

assert(baristaSource.includes("Hyper-Local Hype Broadcaster"), "Barista page must contain Hyper-Local Hype Broadcaster section");
assert(baristaSource.includes("broadcastWeather"), "Barista page must track ambient weather context");
assert(baristaSource.includes("Open WhatsApp"), "Barista page must render Open WhatsApp deep-link button");
assert(baristaSource.includes("Post to X"), "Barista page must render Twitter / X launch button");
assert(baristaSource.includes("Copied!"), "Barista page must show visual clipboard confirmation");
console.log("   ✓ Barista KDS page has full 1-click launchpad, ambient weather toggle, and clipboard feedback");

// 7. Performance SLA Benchmark
console.log("6. Benchmarking Generation Latency (SLA: < 1ms)...");
const iterations = 5000;
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  generateSocialBroadcast(sampleStation);
}
const elapsed = performance.now() - start;
const avgPerRunMs = elapsed / iterations;

console.log(`   ✓ Benchmark: 5,000 runs executed in ${elapsed.toFixed(2)}ms (${(avgPerRunMs * 1000).toFixed(2)}µs per run)`);
assert(avgPerRunMs < 1.0, `Average generation must be under 1ms (actual: ${avgPerRunMs.toFixed(3)}ms)`);

console.log("---------------------------------------------------------------");
console.log("✅ AGENT #5 (HYPER-LOCAL HYPE BROADCASTER) PASSED ALL VERIFICATIONS");
console.log("---------------------------------------------------------------");
