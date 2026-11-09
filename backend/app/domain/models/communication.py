"""BREW Coffee Platform — Communication & Outbox Domain Models."""

from typing import Optional, Literal, Dict, Any, List
from pydantic import BaseModel, Field


CommunicationChannel = Literal["whatsapp", "voice"]
CommunicationPurpose = Literal["booking_confirmation", "booking_quotation", "staff_alert"]
DeliveryStatus = Literal[
    "pending",
    "processing",
    "dispatched",
    "delivered",
    "blocked",
    "failed",
    "permanently_failed",
]


class CommunicationDeliveryRecord(BaseModel):
    id: str
    channel: CommunicationChannel
    purpose: CommunicationPurpose
    sessionId: str
    officialBookingId: Optional[str] = None
    recipientPhoneMasked: str
    status: DeliveryStatus = "pending"
    attemptCount: int = 0
    maxAttempts: int = 3
    claimOwner: Optional[str] = None
    claimToken: Optional[str] = None
    claimedAt: Optional[str] = None
    leaseExpiresAt: Optional[str] = None
    scheduledAt: str
    lastAttemptAt: Optional[str] = None
    lastError: Optional[str] = None
    providerResult: Optional[Dict[str, Any]] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)
    createdAt: str
    updatedAt: str


VoiceCallAttemptStatus = Literal[
    "initiated",
    "ringing",
    "in_progress",
    "completed",
    "failed",
    "busy",
    "no_answer",
    "cancelled",
]


class VoiceCallAttemptRecord(BaseModel):
    id: str
    deliveryId: str
    sessionId: str
    phoneNumberMasked: str
    channel: Literal["voice"] = "voice"
    provider: str
    direction: Literal["outbound"] = "outbound"
    status: VoiceCallAttemptStatus = "initiated"
    statusRank: int = 1
    isTerminal: bool = False
    initiationState: Literal["in_flight", "accepted", "rejected", "uncertain"] = "in_flight"
    providerCallId: Optional[str] = None
    initiatedAt: str
    ringingAt: Optional[str] = None
    answeredAt: Optional[str] = None
    completedAt: Optional[str] = None
    durationSeconds: Optional[int] = None
    errorCode: Optional[str] = None
    errorMessage: Optional[str] = None
    createdAt: str
    updatedAt: str
