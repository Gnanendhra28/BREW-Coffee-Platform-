"""BREW Coffee Platform — Firebase Admin & Firestore Singleton Client."""

import json
import os
from typing import Optional, Any
from app.core.config import settings

_firebase_initialized = False
_firestore_client = None


def get_firestore_client() -> Optional[Any]:
    """Initializes and returns the Firestore client singleton, or None if unconfigured."""
    global _firebase_initialized, _firestore_client

    if _firestore_client is not None:
        return _firestore_client

    if _firebase_initialized:
        import firebase_admin
        from firebase_admin import firestore
        try:
            _firestore_client = firestore.client()
            return _firestore_client
        except Exception:
            return None

    # Check for credentials
    sa_env = settings.firebase_service_account
    project_id = settings.firebase_project_id
    client_email = settings.firebase_client_email
    private_key = settings.firebase_private_key

    try:
        import firebase_admin
        from firebase_admin import credentials, firestore

        cred = None
        if sa_env and sa_env.strip():
            sa_str = sa_env.strip()
            if not sa_str.startswith("{"):
                import base64
                sa_str = base64.b64decode(sa_str).decode("utf-8")
            sa_dict = json.loads(sa_str)
            cred = credentials.Certificate(sa_dict)
        elif project_id and client_email and private_key:
            clean_pk = private_key.replace("\\n", "\n").strip()
            cred_dict = {
                "type": "service_account",
                "project_id": project_id,
                "client_email": client_email,
                "private_key": clean_pk,
                "token_uri": "https://oauth2.googleapis.com/token",
            }
            cred = credentials.Certificate(cred_dict)

        if not firebase_admin._apps:
            if cred:
                app = firebase_admin.initialize_app(cred)
            else:
                app = firebase_admin.initialize_app()
        else:
            app = firebase_admin.get_app()
        _firebase_initialized = True
        _firestore_client = firestore.client(app=app)
        return _firestore_client
    except Exception as e:
        import logging
        logging.getLogger("firebase_client").warning(f"Failed to initialize Firestore: {e}")
        return None
