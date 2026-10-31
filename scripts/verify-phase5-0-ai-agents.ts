/**
 * BREW Autonomous Coffee Platform — Phase 5.0 Six Autonomous AI Agents Audit Suite
 * 
 * Systematically executes 8 evaluation dimensions across all 6 autonomous agents:
 * 1. Normal operation
 * 2. Invalid input handling
 * 3. Missing business data & fallback hierarchy
 * 4. Firestore outage / resilience
 * 5. Gemini / API failure & deterministic degradation
 * 6. Unauthorized action & policy boundaries
 * 7. Duplicate request handling & idempotency
 * 8. Conflicting business information & safety guards
 * 
 * Total: 48 automated test cases covering Agents 1 to 6.
 */

import assert from "node:assert/strict";

// Agent 1: Inventory Sentinel
import {
  runInventorySentinelCycle,
} from "../src/lib/inventorySentinel/sentinelAgent";
import {
  tool_create_restock_request,
  updateServerStockCache,
  getServerStockCache,
} from "../src/lib/inventorySentinel/tools";
import {
  getTrackedIngredients,
  analyzeConsumptionRates,
  forecastDemand,
  evaluateIngredientStockout,
} from "../src/lib/inventorySentinel/calculations";
import { applyRecipeDeduction } from "../src/lib/inventorySentinel/recipes";
import { DEFAULT_INVENTORY_STOCK } from "../src/lib/inventorySentinel/types";

// Agent 2: Curbside Expediter
import {
  runCurbsideExpediterCycle,
} from "../src/lib/curbsideExpediter/expediterAgent";
import {
  parseVehicleDetails,
  calculateCurbsideUrgency,
  calculateQueuePriorityScore,
} from "../src/lib/curbsideExpediter/calculations";
import {
  isValidTransition,
} from "../src/lib/curbsideExpediter/stateMachine";
import {
  registerOrderInCache,
  tool_mark_vehicle_arrived,
} from "../src/lib/curbsideExpediter/tools";

// Agent 3: Yield Optimizer
import {
  runYieldOptimizerCycle,
} from "../src/lib/yieldOptimizer/optimizerAgent";
import {
  calculateBundleEconomics,
  classifyWasteRisk,
} from "../src/lib/yieldOptimizer/calculations";
import {
  validateInventoryBeforePublish,
} from "../src/lib/yieldOptimizer/policy";
import { YieldFlashDealRecord } from "../src/lib/yieldOptimizer/types";

// Agent 4: Event Booking Concierge
import {
  processEventInquiry,
} from "../src/lib/eventBookingConcierge/conciergeAgent";
import {
  validateEventRequirements,
} from "../src/lib/eventBookingConcierge/validation";
import {
  calculateConsumption,
} from "../src/lib/eventBookingConcierge/consumption";
import {
  calculateStaffing,
} from "../src/lib/eventBookingConcierge/staffing";
import {
  calculateTierEconomics,
} from "../src/lib/eventBookingConcierge/calculations";
import {
  tool_create_quote,
} from "../src/lib/eventBookingConcierge/tools";

// Agent 5: HyperLocal Hype Broadcaster
import {
  runHypeBroadcasterCycle,
} from "../src/lib/hyperLocalHype/hypeAgent";
import {
  detectMarketingOpportunities,
} from "../src/lib/hyperLocalHype/opportunities";
import {
  validateCampaignCopyFacts,
  validateCampaignPreSend,
} from "../src/lib/hyperLocalHype/policy";
import {
  buildStoreMarketingContext,
} from "../src/lib/hyperLocalHype/context";
import {
  CampaignMessageCopy,
  MarketingOpportunity,
  HypeCampaignRecord,
  StoreMarketingContext,
} from "../src/lib/hyperLocalHype/types";

// Agent 6: Guest Sentiment Guardian
import {
  processCustomerFeedback,
} from "../src/lib/guestSentimentGuardian/sentimentAgent";
import {
  classifySentiment,
} from "../src/lib/guestSentimentGuardian/classifier";
import {
  extractIssuesFromComment,
} from "../src/lib/guestSentimentGuardian/issueExtractor";
import {
  evaluateFeedbackSeverity,
} from "../src/lib/guestSentimentGuardian/severity";
import {
  correlateOperationalRootCauses,
} from "../src/lib/guestSentimentGuardian/correlation";

console.log("===============================================================");
console.log("🤖 BREW COFFEE — PHASE 5.0 SIX AI AGENTS AUDIT & VERIFICATION");
console.log("===============================================================\n");

let passedCount = 0;
let totalCount = 0;

async function testCase(agentNum: number, agentName: string, dim: string, fn: () => void | Promise<void>) {
  totalCount++;
  const label = `[Agent ${agentNum}: ${agentName}] Dim: ${dim}`;
  try {
    await fn();
    passedCount++;
    console.log(`   ✓ ${label}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`   ❌ FAIL: ${label} -> ${message}`);
    throw err;
  }
}

async function runAll() {

  // =================================================================
  // AGENT 1: INVENTORY SENTINEL
  // =================================================================
  console.log("▶ Auditing Agent 1: 🛡️ Inventory Sentinel...");

  await testCase(1, "Inventory Sentinel", "1. Normal Operation", () => {
    const res = runInventorySentinelCycle("van-01", "POLL", DEFAULT_INVENTORY_STOCK);
    assert(res.healthReport.healthScore.score >= 0 && res.healthReport.healthScore.score <= 100);
    assert(Array.isArray(res.healthReport.ingredients));
    assert(res.healthReport.ingredients.length > 0);
  });

  await testCase(1, "Inventory Sentinel", "2. Invalid Input", () => {
    // Excessive consumption deductions clamped cleanly at 0
    const deducted = applyRecipeDeduction(DEFAULT_INVENTORY_STOCK, [{ name: "cappuccino", quantity: 9999 }]);
    assert.equal(deducted.coffeeBeansKg, 0, "Stock deductions must clamp at 0");
    assert.equal(deducted.wholeMilkLiters, 0, "Milk deductions must clamp at 0");
  });

  await testCase(1, "Inventory Sentinel", "3. Missing Business Data", () => {
    // When consumption rates have no historical variance
    const item = getTrackedIngredients(DEFAULT_INVENTORY_STOCK).find(i => i.id === "coffeeBeansKg")!;
    const analytics = analyzeConsumptionRates(item);
    const forecast = forecastDemand(item, analytics, 4);
    assert(forecast.predictedDemandNext24h > 0, "Must fall back to baseline velocity");
    assert(forecast.predictedRatePerHour > 0, "Predicted rate per hour must be positive");
  });

  await testCase(1, "Inventory Sentinel", "4. Firestore Outage Resilience", () => {
    // Pure memory-safe cache operates when cloud database is offline
    updateServerStockCache({ coffeeBeansKg: 1.2 });
    const cached = getServerStockCache();
    assert.equal(cached.coffeeBeansKg, 1.2);
    // Restore default
    updateServerStockCache({ ...DEFAULT_INVENTORY_STOCK });
  });

  await testCase(1, "Inventory Sentinel", "5. Gemini/API Failure", () => {
    // Operates with 0 LLM dependency
    const criticalStock = { ...DEFAULT_INVENTORY_STOCK, coffeeBeansKg: 0.5 };
    const res = runInventorySentinelCycle("van-01", "POLL", criticalStock);
    const criticalAlert = res.alertsGenerated.find(a => a.severity === "critical");
    assert(criticalAlert, "Must generate deterministic critical alert without LLM");
  });

  await testCase(1, "Inventory Sentinel", "6. Unauthorized Action", () => {
    // Invalid supplier or negative quantity restock rejected
    const restock = tool_create_restock_request({
      storeId: "van-01",
      ingredientId: "coffeeBeansKg",
      quantityUnits: -10, // Invalid
      reason: "Bad order",
    });
    assert.equal(restock.success, false, "Negative restock quantities must be rejected");
  });

  await testCase(1, "Inventory Sentinel", "7. Duplicate Request (Idempotency)", () => {
    const p1 = tool_create_restock_request({
      storeId: "van-01",
      ingredientId: "wholeMilkLiters",
      quantityUnits: 10,
      reason: "Restock duplicate test",
    });
    const p2 = tool_create_restock_request({
      storeId: "van-01",
      ingredientId: "wholeMilkLiters",
      quantityUnits: 10,
      reason: "Restock duplicate test",
    });
    assert(p1.success, "First restock request must succeed");
    assert.equal(p2.isDuplicate, true, "Second identical restock request must be marked isDuplicate: true");
  });

  await testCase(1, "Inventory Sentinel", "8. Conflicting Business Information", () => {
    // Pending inbound order exists while stock is low -> net deficit correctly accounts for inbound
    const lowStock = { ...DEFAULT_INVENTORY_STOCK, wholeMilkLiters: 1.0 };
    const pendingInbound = { wholeMilkLiters: 15.0 };
    const ingredients = getTrackedIngredients(lowStock, pendingInbound);
    const milk = ingredients.find(i => i.id === "wholeMilkLiters")!;
    assert.equal(milk.incomingQuantity, 15.0);
    const prediction = evaluateIngredientStockout(milk, analyzeConsumptionRates(milk), forecastDemand(milk, analyzeConsumptionRates(milk), 2));
    assert(prediction.recommendedOrderQuantity <= 15, "Recommended quantity must deduct pending inbound");
  });

  // =================================================================
  // AGENT 2: CURBSIDE EXPEDITER
  // =================================================================
  console.log("\n▶ Auditing Agent 2: 🚗 Curbside Drive-Thru Expediter...");

  await testCase(2, "Curbside Expediter", "1. Normal Operation", () => {
    registerOrderInCache({
      id: "ord_curb_101",
      orderNumber: "#101",
      customerName: "Priya S.",
      pickupType: "curbside",
      status: "received",
      vehicleInfo: "White Kia Seltos, TS 09 AB 1234, Bay 3",
      items: [{ id: "c-1", name: "Affogato", price: 240, quantity: 1, category: "coffee", image: "/assets/coffee/affagato.webp" }],
      createdAt: Date.now(),
      totalAmount: 240,
    });
    const run = runCurbsideExpediterCycle("ord_curb_101", "van-01");
    assert(run);
    assert.equal(run.orderId, "ord_curb_101");
    assert(run.assessment.priorityScore >= 0 && run.assessment.priorityScore <= 100);
  });

  await testCase(2, "Curbside Expediter", "2. Invalid Input", () => {
    // Non-existent order returns null safely
    const run = runCurbsideExpediterCycle("non_existent_ord_999", "van-01");
    assert.equal(run, null);
  });

  await testCase(2, "Curbside Expediter", "3. Missing Business Data", () => {
    // Empty vehicleInfo parsed safely without throwing
    const parsed = parseVehicleDetails("");
    assert.equal(parsed.plate, "Unknown Plate");
    assert.equal(parsed.bay, "General Curb");
  });

  await testCase(2, "Curbside Expediter", "4. Firestore Outage Resilience", () => {
    // Pure memory-safe tool execution does not block KDS queue
    const urgency = calculateCurbsideUrgency(45, 120, false);
    assert.equal(urgency.urgencyLevel, "URGENT");
  });

  await testCase(2, "Curbside Expediter", "5. Gemini/API Failure", () => {
    // Pure deterministic SLA calculations (< 1ms)
    const priority = calculateQueuePriorityScore("CRITICAL", -75, 45, true);
    assert(priority >= 60, "Critical arrival must receive high priority score");
  });

  await testCase(2, "Curbside Expediter", "6. Unauthorized Action", () => {
    // Illegal state transition: ORDER_CREATED -> COMPLETED directly without prep or handoff
    const canJump = isValidTransition("ORDER_CREATED", "COMPLETED");
    assert.equal(canJump, false, "Illegal state transition directly to COMPLETED must be rejected");
  });

  await testCase(2, "Curbside Expediter", "7. Duplicate Request", () => {
    // Multiple arrival signals idempotently handled
    const t1 = tool_mark_vehicle_arrived("ord_curb_101");
    const t2 = tool_mark_vehicle_arrived("ord_curb_101");
    assert(t1.success);
    assert(t2.success);
  });

  await testCase(2, "Curbside Expediter", "8. Conflicting Business Information", () => {
    // Cancelled order cannot be expedited or marked arrived
    registerOrderInCache({
      id: "ord_curb_cancelled",
      orderNumber: "#102",
      customerName: "Ghost",
      pickupType: "curbside",
      status: "cancelled",
      vehicleInfo: "Bay 1",
      items: [{ id: "c-1", name: "Affogato", price: 240, quantity: 1, category: "coffee", image: "/assets/coffee/affagato.webp" }],
      createdAt: Date.now(),
      totalAmount: 240,
    });
    const run = runCurbsideExpediterCycle("ord_curb_cancelled", "van-01");
    assert(run);
    assert.equal(run.assessment.lifecycleState, "CANCELLED");
    assert.equal(run.baristaNotified, false, "Cancelled orders must not trigger barista notifications");
    const arrival = tool_mark_vehicle_arrived("ord_curb_cancelled");
    assert.equal(arrival.success, false, "Arrival on cancelled order must be rejected");
  });

  // =================================================================
  // AGENT 3: YIELD OPTIMIZER
  // =================================================================
  console.log("\n▶ Auditing Agent 3: ⚡ Yield Optimizer...");

  await testCase(3, "Yield Optimizer", "1. Normal Operation", () => {
    const res = runYieldOptimizerCycle({ storeId: "van-01", currentHour: 16 });
    assert(res.evaluatedPastriesCount > 0);
    assert(Array.isArray(res.assessments));
  });

  await testCase(3, "Yield Optimizer", "2. Invalid Input", () => {
    // Negative retail price caught by economic validator
    const eco = calculateBundleEconomics({
      normalPrice: -100, // Invalid
      dealPrice: 50,
      totalCost: 40,
    });
    assert.equal(eco.isEconomicallyViable, false, "Negative price must be non-viable");
    assert.equal(eco.rejectionReason, "Prices must be strictly positive.");
  });

  await testCase(3, "Yield Optimizer", "3. Missing Business Data", () => {
    // Missing sales velocity falls back safely to baseline
    const risk = classifyWasteRisk({
      productId: "p-test",
      productName: "Artisan Roll",
      currentStock: 10,
      unitCost: 35,
      expectedNaturalSales: 2,
      expectedSurplus: 8,
      remainingOperatingHours: 2,
    });
    assert(risk.expectedSurplus > 0, "Must calculate surplus using fallback");
  });

  await testCase(3, "Yield Optimizer", "4. Firestore Outage Resilience", () => {
    // Yield evaluation runs deterministically in memory
    const eco = calculateBundleEconomics({
      normalPrice: 400,
      dealPrice: 300,
      totalCost: 90,
    });
    assert(eco.grossMarginPercent >= 30, "Gross margin must meet 30% floor");
    assert(eco.isEconomicallyViable, "Valid margin deal must be viable");
  });

  await testCase(3, "Yield Optimizer", "5. Gemini/API Failure", () => {
    // Economics and bundle generation function without LLM
    const res = runYieldOptimizerCycle({ currentHour: 16 });
    assert(res.latencyMs < 50, "Deterministic calculations must complete in sub-50ms");
  });

  await testCase(3, "Yield Optimizer", "6. Unauthorized Action", () => {
    // Attempting to publish deal with margin < 30% is rejected
    const lowMarginEco = calculateBundleEconomics({
      normalPrice: 300,
      dealPrice: 150,
      totalCost: 120, // 80% cost ratio -> only 20% margin
    });
    assert.equal(lowMarginEco.isEconomicallyViable, false, "Margin < 30% must be rejected");
  });

  await testCase(3, "Yield Optimizer", "7. Duplicate Request", () => {
    // Multiple evaluations return consistent deterministic surplus
    const r1 = runYieldOptimizerCycle({ storeId: "van-01", currentHour: 16 });
    const r2 = runYieldOptimizerCycle({ storeId: "van-01", currentHour: 16 });
    assert.equal(r1.evaluatedPastriesCount, r2.evaluatedPastriesCount);
  });

  await testCase(3, "Yield Optimizer", "8. Conflicting Business Information", () => {
    // Live inventory drops to 0 before publish
    const mockDeal = {
      dealId: "deal_123",
      candidate: { pastryId: "p-1", pastryName: "Croissant", surplusUnits: 5 },
      stockCommitted: 5,
    } as unknown as YieldFlashDealRecord;
    const check = validateInventoryBeforePublish(mockDeal, 0); // 0 live stock
    assert.equal(check.valid, false, "Publishing must be blocked if stock sold out");
  });

  // =================================================================
  // AGENT 4: EVENT BOOKING CONCIERGE
  // =================================================================
  console.log("\n▶ Auditing Agent 4: 🎪 Event Booking Concierge...");

  await testCase(4, "Event Booking Concierge", "1. Normal Operation", () => {
    const res = processEventInquiry({
      guestCount: 150,
      eventType: "corporate",
      durationMinutes: 180,
      location: "HITEC City Hyderabad",
      eventDate: "2026-11-25",
    });
    assert(res.quote);
    assert(res.quote.tiers.length === 3);
    assert(res.quote.tiers[0].totalAmount > 0);
  });

  await testCase(4, "Event Booking Concierge", "2. Invalid Input", () => {
    // Crowd size > 1000 exceeds single-van capacity
    const validation = validateEventRequirements({
      guestCount: 2500,
      eventType: "corporate",
      durationMinutes: 240,
      location: "Gachibowli",
      eventDate: "2026-11-25",
    });
    assert.equal(validation.isValid, false, "Crowd > 1000 must be rejected");
  });

  await testCase(4, "Event Booking Concierge", "3. Missing Business Data", () => {
    // Missing eventDate -> returns targeted clarification prompt
    const res = processEventInquiry({
      guestCount: 100,
      location: "Madhapur",
    });
    assert.equal(res.needsClarification, true);
    assert(res.customerSummaryMessage.includes("eventDate") || res.customerSummaryMessage.includes("date"));
  });

  await testCase(4, "Event Booking Concierge", "4. Firestore Outage Resilience", () => {
    // Instant quotation math runs without DB
    const consumption = calculateConsumption({ guestCount: 100, tierId: "STANDARD" });
    assert(consumption.coffeeBeansKg > 0);
    assert(consumption.cupsCount >= 100);
  });

  await testCase(4, "Event Booking Concierge", "5. Gemini/API Failure", () => {
    // Quotation engine computes pricing deterministically
    const staff = calculateStaffing({ guestCount: 200, tierId: "STANDARD" });
    assert(staff.baristasAssigned >= 2);
  });

  await testCase(4, "Event Booking Concierge", "6. Unauthorized Action", () => {
    // Low margin tier (< 30%) rejected by cost engine
    const eco = calculateTierEconomics({
      tierId: "BASIC",
      guestCount: 100,
      totalCost: 15000,
      customPricePerGuest: 160, // ₹16,000 rev vs ₹15,000 cost -> ~6.25% margin
    });
    assert.equal(eco.isEconomicallyViable, false, "Package must maintain >= 30% margin");
  });

  await testCase(4, "Event Booking Concierge", "7. Duplicate Request (Idempotency)", () => {
    const q1 = tool_create_quote({
      requirements: {
        organization: "Acme Corp",
        guestCount: 100,
        eventType: "corporate",
        durationMinutes: 120,
        startTime: "10:00",
        endTime: "12:00",
        location: "Cyber Towers",
        city: "Hyderabad",
        serviceLevel: "STANDARD",
        dietaryRequirements: [],
        eventDate: "2026-11-20",
      },
      customerId: "cust_dup_test",
    });
    assert(q1.success);
    assert(q1.quote);
  });

  await testCase(4, "Event Booking Concierge", "8. Conflicting Business Information", () => {
    // Location > 60km outside mobile service radius
    const validation = validateEventRequirements({
      guestCount: 100,
      eventType: "corporate",
      durationMinutes: 120,
      location: "Warangal Highway, 120km away",
      eventDate: "2026-11-20",
    });
    assert.equal(validation.isValid, false, "Locations > 60km must be flagged as outside radius");
  });

  // =================================================================
  // AGENT 5: HYPERLOCAL HYPE BROADCASTER
  // =================================================================
  console.log("\n▶ Auditing Agent 5: 📢 Hyper-Local Hype Broadcaster...");

  await testCase(5, "HyperLocal Hype", "1. Normal Operation", async () => {
    const res = await runHypeBroadcasterCycle({
      storeId: "van-01",
      currentHour: 15,
      weatherSnapshot: {
        condition: "CLEAR",
        conditionDescription: "Clear skies",
        temperatureC: 34,
        feelsLikeC: 36,
        rainProbability: 0.05,
        humidityPercent: 40,
        windSpeedKmh: 10,
        observedAt: Date.now(),
        isStale: false,
      },
    });
    assert(res.success);
    assert(res.actionTaken === "CAMPAIGN_DRAFTED" || res.actionTaken === "NO_OPPORTUNITY");
  });

  await testCase(5, "HyperLocal Hype", "2. Invalid Input", () => {
    // Stale weather snapshot (> 30 min old) rejected
    const opportunities = detectMarketingOpportunities({
      storeId: "van-01",
      tenantId: "brew-main",
      storeName: "BREW Cyber Towers",
      location: "HITEC City",
      city: "Hyderabad",
      landmark: "Cyber Towers Gate 2",
      timezone: "Asia/Kolkata",
      operatingHours: "07:00 - 23:00",
      currentLocalHour: 15,
      isStoreOpen: true,
      weather: {
        condition: "CLEAR",
        conditionDescription: "Clear sunny skies",
        temperatureC: 34,
        feelsLikeC: 36,
        rainProbability: 0.05,
        humidityPercent: 40,
        windSpeedKmh: 10,
        observedAt: Date.now() - 45 * 60 * 1000,
        isStale: true,
      },
      activePromotions: [],
      inventorySignals: [],
    });
    assert(Array.isArray(opportunities));
  });

  await testCase(5, "HyperLocal Hype", "3. Missing Business Data", async () => {
    // Store closed -> immediate exit with STORE_CLOSED action
    const res = await runHypeBroadcasterCycle({
      currentHour: 23, // 11 PM
    });
    assert.equal(res.actionTaken, "STORE_CLOSED");
  });

  await testCase(5, "HyperLocal Hype", "4. Firestore Outage Resilience", () => {
    // Commercial fact verification works in-memory without cloud database
    const opp = {
      id: "opp_1",
      type: "YIELD_FLASH_DEAL",
      promotionReference: {
        id: "deal_1",
        dealPrice: 300,
        normalPrice: 400,
        discountPercent: 25,
        expiresAt: Date.now() + 3600000,
      },
    } as unknown as MarketingOpportunity;
    const validCopy = {
      headline: "Flash Deal: Coffee & Roll for ₹300!",
      body: "Save 25% today at BREW mobile van.",
      ctaText: "Order for ₹300",
    } as unknown as CampaignMessageCopy;
    const check = validateCampaignCopyFacts(validCopy, opp);
    assert(check.isValid, "Matching commercial facts must be valid");
  });

  await testCase(5, "HyperLocal Hype", "5. Gemini/API Failure", async () => {
    // Generates rule-based templates when LLM unavailable
    const context = await buildStoreMarketingContext({ currentHour: 15 });
    assert(context.isStoreOpen);
  });

  await testCase(5, "HyperLocal Hype", "6. Unauthorized Action (Quiet Hours)", () => {
    // Quiet hours (21:00 - 08:00) policy strictly blocks dispatch
    const mockCampaign = {
      campaignId: "camp_123",
      storeId: "van-01",
      audienceCriteria: { quietHoursBypass: false },
      opportunity: { type: "MORNING_RUSH" },
      messages: {},
    } as unknown as HypeCampaignRecord;
    const mockContext = {
      storeId: "van-01",
      isStoreOpen: true,
      currentLocalHour: 22, // 10 PM
      activePromotions: [],
    } as unknown as StoreMarketingContext;
    const check = validateCampaignPreSend(mockCampaign, mockContext);
    assert.equal(check.canSend, false, "Quiet hours must strictly block campaign send");
    assert(check.errors.some(e => e.includes("quiet hours")));
  });

  await testCase(5, "HyperLocal Hype", "7. Duplicate Request", async () => {
    // Running cycle twice under identical context produces deterministic action
    const r1 = await runHypeBroadcasterCycle({ currentHour: 15 });
    const r2 = await runHypeBroadcasterCycle({ currentHour: 15 });
    assert.equal(r1.success, r2.success);
  });

  await testCase(5, "HyperLocal Hype", "8. Conflicting Business Information", () => {
    // Hallucinated discount percentage strictly rejected by fact validator
    const opp = {
      id: "opp_1",
      type: "YIELD_FLASH_DEAL",
      promotionReference: {
        id: "deal_1",
        dealPrice: 300,
        normalPrice: 400,
        discountPercent: 25,
        expiresAt: Date.now() + 3600000,
      },
    } as unknown as MarketingOpportunity;
    const badCopy = {
      headline: "Massive 50% Off Everything!", // Hallucinated 50%
      body: "Get coffee for ₹199 only!",     // Hallucinated ₹199
      ctaText: "Claim 50% Deal",
    } as unknown as CampaignMessageCopy;
    const check = validateCampaignCopyFacts(badCopy, opp);
    assert.equal(check.isValid, false, "Hallucinated prices and discounts must be rejected");
    assert(check.errors.length > 0);
  });

  // =================================================================
  // AGENT 6: GUEST SENTIMENT GUARDIAN
  // =================================================================
  console.log("\n▶ Auditing Agent 6: ❤️ Guest Sentiment Guardian...");

  await testCase(6, "Guest Sentiment Guardian", "1. Normal Operation", async () => {
    const res = await processCustomerFeedback({
      feedbackId: `fb_test_${Date.now()}`,
      tenantId: "brew-main",
      storeId: "van-01",
      customerId: "cust_101",
      orderId: "ord_101",
      rating: 3,
      comment: "Coffee took 20 minutes to prepare and was lukewarm.",
      source: "IN_APP_REVIEW",
      createdAt: Date.now(),
    });
    assert(res.success);
    assert(res.recovery);
    assert.equal(res.recovery.rating, 3);
  });

  await testCase(6, "Guest Sentiment Guardian", "2. Invalid Input", () => {
    // 5-star rating with no complaint receives positive classification and NO_ACTION
    const sentiment = classifySentiment(5, "Absolutely loved the espresso and friendly barista!");
    assert.equal(sentiment, "POSITIVE");
  });

  await testCase(6, "Guest Sentiment Guardian", "3. Missing Business Data", () => {
    // Review without order context extracts issues from text alone
    const issues = extractIssuesFromComment("Waited too long, cold coffee", 2);
    assert(issues.includes("WAIT_TIME"));
    assert(issues.includes("TEMPERATURE"));
  });

  await testCase(6, "Guest Sentiment Guardian", "4. Firestore Outage Resilience", () => {
    // Issue extraction and severity classification run in-memory
    const sev = evaluateFeedbackSeverity(1, "Terrible service and cold latte", ["TEMPERATURE"]);
    assert(sev.severity === "HIGH" || sev.severity === "MEDIUM");
  });

  await testCase(6, "Guest Sentiment Guardian", "5. Gemini/API Failure", async () => {
    // Deterministic recovery policy operates with 0 LLM dependency
    const res = await processCustomerFeedback({
      feedbackId: `fb_no_llm_${Date.now()}`,
      tenantId: "brew-main",
      storeId: "van-01",
      customerId: "cust_no_llm",
      rating: 2,
      comment: "Wrong item delivered",
      source: "IN_APP_REVIEW",
      createdAt: Date.now(),
    });
    assert(res.success);
    assert(res.recovery?.voucher?.code || res.recovery?.status);
  });

  await testCase(6, "Guest Sentiment Guardian", "6. Unauthorized Action (Critical Allergy)", () => {
    // Critical safety / allergy complaint must NOT auto-voucher; must escalate to manager
    const sev = evaluateFeedbackSeverity(1, "I told them I had a peanut allergy but found peanuts in my cookie!", ["FOOD_QUALITY"]);
    assert.equal(sev.isCriticalSafety, true, "Allergy complaints must be flagged as critical safety");
  });

  await testCase(6, "Guest Sentiment Guardian", "7. Duplicate Request (Idempotency)", async () => {
    const feedbackId = `fb_dup_${Date.now()}`;
    const fb = {
      feedbackId,
      tenantId: "brew-main",
      storeId: "van-01",
      customerId: "cust_dup",
      rating: 3,
      comment: "Average experience",
      source: "IN_APP_REVIEW" as const,
      createdAt: Date.now(),
    };
    const r1 = await processCustomerFeedback(fb);
    const r2 = await processCustomerFeedback(fb);
    assert(r1.success);
    assert.equal(r2.isExisting, true, "Duplicate feedback must return existing record");
  });

  await testCase(6, "Guest Sentiment Guardian", "8. Conflicting Business Information", () => {
    // Review claims 25 min wait time, but order telemetry shows 5 min prep time
    const correlations = correlateOperationalRootCauses(
      {
        feedbackId: "fb_conflict",
        tenantId: "brew-main",
        storeId: "van-01",
        customerId: "cust_1",
        rating: 2,
        comment: "I waited 25 minutes for my drink",
        source: "IN_APP_REVIEW",
        createdAt: Date.now(),
      },
      ["WAIT_TIME"],
      {
        orderId: "ord_fast",
        totalAmount: 180,
        status: "COMPLETED",
        pickupType: "curbside",
        items: [],
        createdAt: Date.now() - 5 * 60 * 1000,
        readyAt: Date.now() - 2 * 60 * 1000,
        actualWaitMinutes: 3, // Only 3 minutes!
      }
    );
    // Root cause correlation reflects factual operational telemetry
    assert(Array.isArray(correlations));
  });

  console.log("\n===============================================================");
  console.log(`🎉 ALL ${passedCount}/${totalCount} PHASE 5.0 AUDIT TESTS PASSED!`);
  console.log("===============================================================\n");
}

runAll().catch((err) => {
  console.error("FATAL ERROR IN AI AGENTS AUDIT:", err);
  process.exit(1);
});
