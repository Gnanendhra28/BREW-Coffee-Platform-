"""BREW Coffee Platform — Payment Orders & Processed Payments Repository."""

import time
from typing import Optional, Dict, Set, Any
from .client import get_firestore_client

_mem_orders: Dict[str, StoredPaymentOrder] = {}
_mem_processed_payments: Set[str] = set()
_mem_processed_webhooks: Set[str] = set()

ORDERS_COLLECTION = "payment_orders"
PAYMENTS_COLLECTION = "processed_payments"
WEBHOOKS_COLLECTION = "processed_webhooks"


async def save_payment_order(order: StoredPaymentOrder) -> None:
    """Saves payment order in-memory and in Firestore if connected."""
    _mem_orders[order.orderId] = order
    if order.razorpayOrderId:
        _mem_orders[order.razorpayOrderId] = order

    db = get_firestore_client()
    if db is not None:
        try:
            doc_data = order.model_dump()
            db.collection(ORDERS_COLLECTION).document(order.orderId).set(doc_data)
        except Exception:
            pass


async def get_payment_order(order_id: str) -> Optional[StoredPaymentOrder]:
    """Retrieves payment order by internal ID or Razorpay Order ID."""
    if order_id in _mem_orders:
        return _mem_orders[order_id]

    db = get_firestore_client()
    if db is not None:
        try:
            doc = db.collection(ORDERS_COLLECTION).document(order_id).get()
            if doc.exists:
                data = doc.to_dict()
                order = StoredPaymentOrder(**data)
                _mem_orders[order.orderId] = order
                return order
            # Try query by razorpayOrderId
            query = db.collection(ORDERS_COLLECTION).where("razorpayOrderId", "==", order_id).limit(1).stream()
            for d in query:
                order = StoredPaymentOrder(**d.to_dict())
                _mem_orders[order.orderId] = order
                return order
        except Exception:
            pass
    return None


async def mark_payment_verified(
    payment_id: str,
    order_id: str,
    customer_reference: Optional[str] = None,
) -> None:
    """Marks payment verified durably and registers payment ID to prevent replays."""
    _mem_processed_payments.add(payment_id)

    target_internal_id = order_id
    if order_id in _mem_orders:
        target_internal_id = _mem_orders[order_id].orderId
        _mem_orders[target_internal_id].paymentStatus = "paid"
        _mem_orders[target_internal_id].orderStatus = "brewing"
        _mem_orders[target_internal_id].razorpayPaymentId = payment_id

    db = get_firestore_client()
    if db is not None:
        try:
            target_ref = db.collection(ORDERS_COLLECTION).document(target_internal_id)
            doc_snap = target_ref.get()
            if not doc_snap.exists:
                query_docs = list(
                    db.collection(ORDERS_COLLECTION)
                    .where("razorpayOrderId", "==", order_id)
                    .limit(1)
                    .stream()
                )
                if query_docs:
                    target_ref = query_docs[0].reference

            target_ref.update({
                "paymentStatus": "paid",
                "orderStatus": "brewing",
                "razorpayPaymentId": payment_id,
            })
            db.collection(PAYMENTS_COLLECTION).document(payment_id).set({
                "paymentId": payment_id,
                "orderId": target_internal_id,
                "customerReference": customer_reference or "Guest",
            })
        except Exception as e:
            import logging
            logging.getLogger("payment_repo").warning(f"Error marking payment verified in Firestore: {e}")


async def is_payment_id_processed(payment_id: str) -> bool:
    """Checks if a payment ID was already processed."""
    if payment_id in _mem_processed_payments:
        return True
    db = get_firestore_client()
    if db is not None:
        try:
            doc = db.collection(PAYMENTS_COLLECTION).document(payment_id).get()
            if doc.exists:
                _mem_processed_payments.add(payment_id)
                return True
        except Exception:
            pass
    return False


async def is_webhook_id_processed(event_id: str) -> bool:
    """Checks if webhook event ID was already processed."""
    if event_id in _mem_processed_webhooks:
        return True
    db = get_firestore_client()
    if db is not None:
        try:
            doc = db.collection(WEBHOOKS_COLLECTION).document(event_id).get()
            if doc.exists:
                _mem_processed_webhooks.add(event_id)
                return True
        except Exception:
            pass
    return False


async def mark_webhook_id_processed(event_id: str, data: Optional[Dict[str, Any]] = None) -> None:
    """Registers webhook event ID as processed."""
    _mem_processed_webhooks.add(event_id)
    db = get_firestore_client()
    if db is not None:
        try:
            doc_data = {
                "eventId": event_id,
                "processedAt": int(time.time() * 1000),
            }
            if data:
                doc_data.update(data)
            db.collection(WEBHOOKS_COLLECTION).document(event_id).set(doc_data)
        except Exception as e:
            import logging
            logging.getLogger("payment_repo").warning(f"Error persisting webhook to Firestore: {e}")


get_payment_order_by_id = get_payment_order
