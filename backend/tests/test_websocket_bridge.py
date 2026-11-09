"""Tests for WebSocket Voice Bridge (/ws/voice/media)."""

import pytest
import time
import hmac
import hashlib
from app.websockets.voice_bridge import (
    verify_stream_token,
    packetize_audio_for_exotel,
)


def test_packetize_audio_for_exotel():
    # 6,400 bytes -> exactly 2 packets of 3,200 bytes
    raw_audio = b"\x01\x02" * 3200
    packets = packetize_audio_for_exotel(raw_audio, chunk_size=3200)
    assert len(packets) == 2
    for p in packets:
        assert len(p) == 3200
        assert len(p) % 320 == 0


def test_stream_token_verification_and_replay_protection():
    secret_key = "test_stream_secret_key"
    attempt_id = "att_test_101"
    session_id = "vbs_test_202"
    exp = int(time.time()) + 300
    nonce = "safe_nonce_12345678"

    payload = f"{attempt_id}:{session_id}:{exp}:{nonce}".encode("utf-8")
    sig = hmac.new(secret_key.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    token = f"{exp}.{nonce}.{sig}"

    # 1. First verification: valid
    is_valid1 = verify_stream_token(token, attempt_id, session_id, secret_key)
    assert is_valid1 is True

    # 2. Replay with identical token & nonce: rejected
    is_valid2 = verify_stream_token(token, attempt_id, session_id, secret_key)
    assert is_valid2 is False
