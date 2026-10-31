#!/usr/bin/env bash
# ==============================================================================
# BREW Coffee Platform — Cloud Firestore Backup & Disaster Recovery Runbook
# Target Project: brew-2621e | Region: asia-south1 (Mumbai)
# NOTE: Execute only after obtaining cloud deployment authorization.
# ==============================================================================

set -euo pipefail

PROJECT_ID="brew-2621e"
REGION="asia-south1"
BUCKET_NAME="brew-2621e-backups"
BUCKET_URI="gs://${BUCKET_NAME}"
SERVICE_ACCOUNT="firebase-adminsdk-fbsvc@brew-2621e.iam.gserviceaccount.com"

echo "=== [Step 1] Creating Cloud Storage Backup Bucket ==="
gcloud storage buckets create "${BUCKET_URI}" \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --uniform-bucket-level-access

echo "=== [Step 2] Applying 30-Day Retention Lifecycle Policy ==="
gcloud storage buckets update "${BUCKET_URI}" \
  --lifecycle-file="scripts/backup-lifecycle.json"

echo "=== [Step 3] Granting Storage & Datastore Export Permissions ==="
# Grant Cloud Firestore export agent permissions on bucket
gcloud storage buckets add-iam-policy-binding "${BUCKET_URI}" \
  --member="serviceAccount:${PROJECT_ID}@appspot.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Grant Service Account import/export admin rights
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/datastore.importExportAdmin"

echo "=== [Step 4] Enabling Cloud Scheduler API ==="
gcloud services enable cloudscheduler.googleapis.com --project="${PROJECT_ID}"

echo "=== [Step 5] Deploying Cloud Scheduler Daily Backup Job (02:00 IST) ==="
gcloud scheduler jobs create http firestore-daily-backup \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --schedule="0 2 * * *" \
  --time-zone="Asia/Kolkata" \
  --uri="https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default):exportDocuments" \
  --http-method=POST \
  --oauth-service-account-email="${SERVICE_ACCOUNT}" \
  --oauth-token-scope="https://www.googleapis.com/auth/datastore" \
  --headers="Content-Type=application/json" \
  --message-body="{\"outputUriPrefix\":\"${BUCKET_URI}\"}"

echo "=== [Step 6] On-Demand Manual Export Command (For Emergency Reference) ==="
echo "gcloud firestore export ${BUCKET_URI}/manual-\$(date +%Y%m%d%H%M) --project=${PROJECT_ID}"

echo "=== [Step 7] Disaster Recovery Restore Command ==="
echo "gcloud firestore import ${BUCKET_URI}/<BACKUP_FOLDER> --project=${PROJECT_ID}"
