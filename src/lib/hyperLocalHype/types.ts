// Production Data Contracts & Type Schemas for Agent 5: 📢 Hyper-Local Hype Broadcaster

export type WeatherCondition =
  | "CLEAR"
  | "WARM"
  | "HOT"
  | "RAIN"
  | "DRIZZLE"
  | "CHILLY"
  | "BREEZY"
  | "STORM"
  | "UNAVAILABLE";

export interface WeatherSnapshot {
  temperatureC: number;
  feelsLikeC: number;
  humidityPercent: number;
  rainProbability: number; // 0.0 to 1.0
  condition: WeatherCondition;
  conditionDescription: string;
  windSpeedKmh: number;
  observedAt: number;     // timestamp ms
  isStale: boolean;
}

export interface WeatherForecast {
  horizonHours: number;
  forecastTime: number;
  temperatureC: number;
  rainProbability: number;
  condition: WeatherCondition;
}

export interface StoreMarketingContext {
  storeId: string;
  tenantId: string;
  storeName: string;
  location: string;
  city: string;
  landmark: string;
  timezone: string;
  operatingHours: string;
  currentLocalHour: number;
  isStoreOpen: boolean;
  weather: WeatherSnapshot;
  forecast?: WeatherForecast;
  activePromotions: Array<{
    id: string;
    title: string;
    productName: string;
    normalPrice: number;
    dealPrice: number;
    discountPercent: number;
    expiresAt: number;
    isActive: boolean;
  }>;
  inventorySignals: Array<{
    productId: string;
    productName: string;
    availableStock: number;
    isSurplus: boolean;
  }>;
  localEvent?: {
    name: string;
    distanceKm: number;
    startsAt: string;
  };
}

export type MarketingOpportunityType =
  | "COLD_DRINK_OPPORTUNITY"
  | "HOT_DRINK_OPPORTUNITY"
  | "RAIN_OPPORTUNITY"
  | "AFTERNOON_SLUMP"
  | "MORNING_RUSH"
  | "EVENING_TREAT"
  | "YIELD_FLASH_DEAL"
  | "LOCAL_EVENT";

export interface MarketingOpportunity {
  id: string;
  type: MarketingOpportunityType;
  priorityScore: number;     // 0 - 100
  triggerReason: string;
  recommendedProducts: string[];
  promotionReference?: {
    id: string;
    dealPrice: number;
    normalPrice: number;
    discountPercent: number;
    expiresAt: number;
  };
  headlineTheme: string;
  urgencyLevel: "LOW" | "MEDIUM" | "HIGH";
  detectedAt: number;
}

export interface CustomerMarketingProfile {
  customerId: string;
  name: string;
  email?: string;
  phone?: string;
  locationZone: string;
  distanceKm: number;
  marketingConsent: boolean;
  channelPreferences: {
    push: boolean;
    sms: boolean;
    whatsapp: boolean;
    email: boolean;
  };
  lastContactedTimestamp?: number;
  dailyContactCount: number;
  segments: string[];
}

export interface AudienceCriteria {
  storeId: string;
  maxRadiusKm: number;
  allowedChannels: Array<"push" | "sms" | "whatsapp" | "social">;
  customerSegments?: string[];
  requireConsent: boolean;
  quietHoursBypass?: boolean;
}

export interface AudienceSelectionResult {
  totalEvaluated: number;
  eligibleCount: number;
  excludedOptOut: number;
  excludedQuietHours: number;
  excludedFrequencyCap: number;
  excludedRadius: number;
  eligibleCustomers: CustomerMarketingProfile[];
}

export type CampaignStatus =
  | "DRAFT"
  | "GENERATED"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "SCHEDULED"
  | "SENDING"
  | "SENT"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "FAILED";

export interface CampaignMessageCopy {
  channel: "push" | "sms" | "whatsapp" | "social";
  headline: string;
  body: string;
  ctaText: string;
  ctaUrl: string;
  hashtags: string[];
  tone: "friendly" | "urgent" | "playful" | "premium";
}

export interface CampaignPerformanceMetrics {
  targetedCount: number;
  deliveredCount: number;
  failedCount: number;
  openCount: number;
  clickCount: number;
  conversionCount: number;
  revenueGenerated: number;
}

export interface HypeCampaignRecord {
  campaignId: string;
  idempotencyKey: string;
  storeId: string;
  tenantId: string;
  status: CampaignStatus;
  opportunity: MarketingOpportunity;
  audienceCriteria: AudienceCriteria;
  audience: AudienceSelectionResult;
  messages: Partial<Record<"push" | "sms" | "whatsapp" | "social", CampaignMessageCopy>>;
  approvedBy?: string;
  scheduledAt?: number;
  sentAt?: number;
  preSendValidationPassed: boolean;
  preSendValidationErrors?: string[];
  metrics: CampaignPerformanceMetrics;
  createdAt: number;
  expiresAt: number;
}

export interface HypeAuditLog {
  runId: string;
  agentName: "HyperLocalHypeBroadcaster";
  tenantId: string;
  storeId: string;
  campaignId?: string;
  trigger: string;
  opportunityType?: string;
  audienceEligibleCount?: number;
  channel?: string;
  decision: string;
  policyChecksPassed: boolean;
  toolsCalled: string[];
  executionResult: "SUCCESS" | "BLOCKED" | "FAILED";
  latencyMs: number;
  error?: string;
}

export interface HypeBroadcasterMetrics {
  campaignsGenerated: number;
  campaignsApproved: number;
  campaignsSent: number;
  campaignsBlocked: number;
  campaignsCancelled: number;
  totalAudienceReached: number;
  totalDeliverySuccess: number;
  totalDeliveryFailures: number;
  totalConversions: number;
  totalRevenueAttributed: number;
  avgClickRatePercent: number;
  avgConversionRatePercent: number;
}
