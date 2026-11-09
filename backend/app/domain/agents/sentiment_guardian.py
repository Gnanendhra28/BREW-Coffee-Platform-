"""Agent 6: Guest Sentiment Guardian Engine.

Classifies negative reviews, identifies root causes,
synthesizes manager apologies, and allocates recovery vouchers.
"""

import random
from typing import List, Literal, Optional
from pydantic import BaseModel, Field


class ReviewRecoveryNotice(BaseModel):
    customerName: str
    rating: int
    sentiment: Literal["negative", "mixed"]
    detectedIssues: List[str]
    managerApologyText: str
    voucherCode: str
    discountAmount: float = 50.0


def analyze_review_sentiment(
    name: str,
    rating: int,
    comment: str,
) -> Optional[ReviewRecoveryNotice]:
    """Evaluates customer reviews and generates apology/credit notices for ratings <= 3."""
    if rating > 3:
        return None

    lower = comment.lower()
    issues: List[str] = []

    if any(w in lower for w in ["wait", "slow", "late", "time", "queue"]):
        issues.append("Order wait time during peak rush")
    if any(w in lower for w in ["sweet", "sugar"]):
        issues.append("Sweetness calibration")
    if any(w in lower for w in ["cold", "temperature", "hot"]):
        issues.append("Beverage temperature consistency")
    if any(w in lower for w in ["car", "curb", "parking"]):
        issues.append("Curbside handover coordination")

    if not issues:
        issues.append("General service experience")

    voucher_code = f"BREWCARE{random.randint(1000, 9999)}"
    guest_name = name or "Valued Guest"
    joined_issues = " & ".join(issues)

    apology = (
        f"Dear {guest_name},\n\n"
        f"Thank you for sharing candid feedback regarding your visit. We take pride in our craft, "
        f"and we are truly sorry that your experience with our {joined_issues} fell short of our gold standard.\n\n"
        f"Our head barista has been notified to recalibrate this immediately. Please accept a ₹50 courtesy "
        f"credit on us using code {voucher_code} for your next brew. We would love the chance to pour you a cup done right!"
    )

    return ReviewRecoveryNotice(
        customerName=guest_name,
        rating=rating,
        sentiment="negative" if rating <= 2 else "mixed",
        detectedIssues=issues,
        managerApologyText=apology,
        voucherCode=voucher_code,
        discountAmount=50.0,
    )
