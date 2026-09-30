// Production Data Models & Type Contracts for Agent 2: 🚗 Curbside Drive-Thru Expediter

export type CurbsideUrgencyLevel = "NORMAL" | "WATCH" | "URGENT" | "CRITICAL";

export type CurbsideAction = "NORMAL" | "EXPEDITE" | "DEFER" | "PREPARE_HANDOFF";

export type CurbsideLifecycleState =
  | "ORDER_CREATED"
  | "CONFIRMED"
  | "PREPARING"
  | "READY"
  | "VEHICLE_APPROACHING"
  | "VEHICLE_ARRIVED"
  | "HANDOFF_IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED"
  | "NO_SHOW";

export interface ParsedVehicleInfo {
  plate: string;
  bay: string;
  description: string;
  raw: string;
}

export interface VehicleEtaEstimate {
  orderId: string;
  etaSeconds: number;
  distanceMeters?: number;
  source: "beacon_approaching" | "beacon_arrived" | "gps_provider" | "manual";
  updatedAt: number;
}

export interface OrderPreparationEstimate {
  orderId: string;
  totalPrepSeconds: number;
  elapsedPrepSeconds: number;
  remainingPrepSeconds: number;
  parallelStationsCount: number;
  targetReadyTimestamp: number;
  isReady: boolean;
}

export interface CurbsideExpediteAssessment {
  orderId: string;
  orderNumber: string;
  customerName: string;
  vehicleInfo?: string;
  parsedVehicle?: ParsedVehicleInfo;
  lifecycleState: CurbsideLifecycleState;
  vehicleEtaSeconds: number;
  remainingPrepSeconds: number;
  arrivalBufferSeconds: number;
  urgencyLevel: CurbsideUrgencyLevel;
  recommendedAction: CurbsideAction;
  priorityScore: number; // 0 - 100
  reason: string;
  requiresNotification: boolean;
  targetReadyTime: string;
}

export interface CurbsideSlaRecord {
  orderId: string;
  orderNumber?: string;
  vehicleArrivedAt: number;
  handoffStartedAt?: number;
  handoffCompletedAt: number;
  handoffDurationSeconds: number;
  slaMet: boolean; // <= 60 seconds
  vehicleWaitSeconds: number;
}

export interface CurbsideOperationalMetrics {
  ordersMonitored: number;
  ordersExpedited: number;
  ordersCompleted: number;
  slaMetCount: number;
  slaMissedCount: number;
  slaSuccessRate: number; // 0 - 100%
  avgHandoffDurationSeconds: number;
  medianHandoffDurationSeconds: number;
  p95HandoffDurationSeconds: number;
  p99HandoffDurationSeconds: number;
  avgVehicleWaitSeconds: number;
  urgentOrdersCount: number;
  criticalOrdersCount: number;
}

export interface CurbsideAuditLog {
  runId: string;
  agentName: "CurbsideExpediter";
  storeId: string;
  orderId: string;
  triggerEvent: string;
  timestamp: number;
  vehicleEtaSeconds: number;
  remainingPrepSeconds: number;
  urgency: CurbsideUrgencyLevel;
  priority: number;
  decision: string;
  toolsCalled: string[];
  executedAction: string;
  slaStatus?: "SLA_MET" | "SLA_MISSED";
  latencyMs: number;
  error?: string;
}

export interface CurbsideExpediterEvent {
  type:
    | "ORDER_CREATED"
    | "ORDER_CONFIRMED"
    | "ORDER_PREPARATION_STARTED"
    | "VEHICLE_APPROACHING"
    | "VEHICLE_ARRIVED"
    | "ORDER_READY"
    | "HANDOFF_STARTED"
    | "HANDOFF_COMPLETED"
    | "ORDER_CANCELLED";
  storeId: string;
  orderId: string;
  timestamp: number;
  payload?: Record<string, unknown>;
}
