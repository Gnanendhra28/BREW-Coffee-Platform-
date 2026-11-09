"""BREW Coffee Platform — Order & Payment Domain Models."""

from typing import List, Optional, Literal
from pydantic import BaseModel, Field, field_validator


class CreateOrderItem(BaseModel):
    id: str = Field(min_length=1, description="Product ID")
    quantity: int

    @field_validator("quantity")
    @classmethod
    def validate_quantity(cls, v: int) -> int:
        if v < 1:
            raise ValueError("Quantity must be at least 1")
        if v > 20:
            raise ValueError("Quantity cannot exceed 20 per item")
        return v


class CreateOrderInput(BaseModel):
    items: List[CreateOrderItem] = Field(min_length=1, max_length=30)
    promoCode: Optional[str] = Field(default=None, max_length=50)
    isMember: Optional[bool] = False
    currency: str = Field(default="INR")
    receipt: Optional[str] = Field(default=None, max_length=100)
    customerName: Optional[str] = Field(default=None, max_length=100)
    customerPhone: Optional[str] = Field(default=None, max_length=30)
    vanLocationName: Optional[str] = Field(default=None, max_length=100)
    amount: Optional[float] = None  # Client submitted amount for verification


class StoredPaymentItem(BaseModel):
    id: str
    name: str
    price: float
    quantity: int


class StoredPaymentOrder(BaseModel):
    orderId: str
    customerReference: str
    customerName: str
    customerPhone: Optional[str] = None
    items: List[StoredPaymentItem]
    subtotal: float
    discountAmount: float
    appliedPromotion: Optional[str] = None
    taxAmount: float
    deliveryFee: float
    finalTotal: float
    amountInPaise: int
    currency: str = "INR"
    receipt: str
    razorpayOrderId: Optional[str] = None
    razorpayPaymentId: Optional[str] = None
    paymentStatus: Literal["pending", "paid", "failed"] = "pending"
    orderStatus: Literal["pending", "brewing", "ready", "completed", "cancelled"] = "pending"
    createdAt: int
    updatedAt: int
    verificationMetadata: Optional[dict] = None
    vanLocationName: str = "HITEC City — Cyber Towers (Hyderabad)"


class VerifyPaymentInput(BaseModel):
    razorpay_order_id: str = Field(min_length=1)
    razorpay_payment_id: str = Field(min_length=1)
    razorpay_signature: str = Field(min_length=1)
    customerReference: Optional[str] = None
