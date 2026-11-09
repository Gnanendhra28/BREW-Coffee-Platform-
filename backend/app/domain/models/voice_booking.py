"""BREW Coffee Platform — Voice Booking Domain Models & Safe Views."""

from typing import List, Optional, Literal, Dict, Any
from pydantic import BaseModel, Field


SupportedLanguage = Literal["en", "hi", "te"]

VoiceBookingState = Literal[
    "created",
    "language_selected",
    "collecting_requirements",
    "details_collected",
    "quotation_presented",
    "awaiting_customer_confirmation",
    "customer_confirmed",
    "awaiting_staff_approval",
    "booking_confirmed",
    "customer_declined",
    "human_handoff",
    "cancelled",
    "failed",
]


class BookingRequirements(BaseModel):
    eventType: Optional[str] = None
    guestCount: Optional[int] = None
    eventDate: Optional[str] = None
    startTime: Optional[str] = None
    durationHours: Optional[float] = None
    venueAddress: Optional[str] = None
    selectedTier: Optional[str] = None
    customerConfirmed: bool = False
    missingFields: List[str] = Field(default_factory=list)


class QuotationTier(BaseModel):
    tierId: str
    name: str
    pricePerGuest: float
    totalAmount: float
    perks: List[str]
    isRecommended: bool = False
    tagline: Optional[str] = None
    staffAssigned: Optional[int] = None
    equipmentSummary: Optional[str] = None


class VoiceQuotation(BaseModel):
    eventType: str
    estimatedGuests: int
    guestCount: Optional[int] = None
    recommendedTier: Optional[str] = None
    tiers: List[QuotationTier]


class ConversationMessage(BaseModel):
    id: str
    role: Literal["user", "assistant", "system"]
    content: str
    language: SupportedLanguage
    timestamp: str


class SafeCallAttemptStatus(BaseModel):
    callAttemptStatus: Literal["pending", "answered", "no_answer", "busy", "failed", "blocked"] = "pending"
    lastAttemptAt: Optional[str] = None
    attemptCount: int = 0
    staffFollowUpRequired: bool = False


class SafeCustomerVoiceSessionView(BaseModel):
    sessionId: str
    officialBookingId: Optional[str] = None
    state: VoiceBookingState
    language: SupportedLanguage
    requirements: BookingRequirements
    quotation: Optional[VoiceQuotation] = None
    conversationHistory: List[ConversationMessage] = Field(default_factory=list)
    callStatus: SafeCallAttemptStatus = Field(default_factory=SafeCallAttemptStatus)
    createdAt: str
    updatedAt: str


class StaffApprovalAudit(BaseModel):
    staffApprovalId: str
    approvedBy: str
    staffRole: str
    approvedAt: str
    scheduleSlotReserved: bool = True
    officialBookingId: str


class StaffRejectionAudit(BaseModel):
    staffRejectionId: str
    rejectedBy: str
    staffRole: str
    rejectedAt: str
    reason: str
    customerFacingReason: Optional[str] = None


class VoiceBookingSession(BaseModel):
    id: str
    revision: int = 1
    state: VoiceBookingState = "created"
    language: SupportedLanguage = "en"
    phoneNumber: str
    phoneNumberMasked: str
    requirements: BookingRequirements = Field(default_factory=BookingRequirements)
    quotation: Optional[VoiceQuotation] = None
    quotationSnapshot: Optional[Dict[str, Any]] = None
    staffApprovalAudit: Optional[StaffApprovalAudit] = None
    staffRejectionAudit: Optional[StaffRejectionAudit] = None
    officialBookingId: Optional[str] = None
    conversationHistory: List[ConversationMessage] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    createdAt: str
    updatedAt: str


def mask_phone_number(phone: str) -> str:
    """Masks phone number preserving country code and last 2 digits, e.g. +91 98*** ***10."""
    cleaned = phone.strip()
    if len(cleaned) < 8:
        return "***"
    prefix = cleaned[:6]
    suffix = cleaned[-2:]
    return f"{prefix}*** ***{suffix}"


def to_safe_customer_voice_session_view(session: VoiceBookingSession) -> SafeCustomerVoiceSessionView:
    """Sanitizes voice session for public client inspection, removing tokens/secrets."""
    meta = session.metadata or {}
    call_status = SafeCallAttemptStatus(
        callAttemptStatus=meta.get("callAttemptStatus", "pending"),
        lastAttemptAt=meta.get("lastAttemptAt"),
        attemptCount=meta.get("attemptCount", 0),
        staffFollowUpRequired=meta.get("staffFollowUpRequired", False),
    )

    return SafeCustomerVoiceSessionView(
        sessionId=session.id,
        officialBookingId=session.officialBookingId,
        state=session.state,
        language=session.language,
        requirements=session.requirements,
        quotation=session.quotation,
        conversationHistory=session.conversationHistory,
        callStatus=call_status,
        createdAt=session.createdAt,
        updatedAt=session.updatedAt,
    )
