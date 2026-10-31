#!/bin/bash
set -e

# ==============================================================================
# ☕ BREW Mobile Coffee Platform — Deploy to Google Cloud Run (GCP)
# Target Environment: Google Cloud Platform (GCP) Project: brew-2621e
# Region: asia-south1 (Mumbai)
# ==============================================================================

PROJECT_ID="brew-2621e"
REGION="asia-south1"
SERVICE_NAME="brew-coffee-platform"

echo "=========================================================="
echo "🚀 BREW Coffee Platform — Production Cloud Run Deployment"
echo "Project : $PROJECT_ID"
echo "Region  : $REGION"
echo "Service : $SERVICE_NAME"
echo "=========================================================="

# 1. Ensure gcloud CLI is configured to target project
gcloud config set project "$PROJECT_ID"

# 2. Check if required GCP APIs are enabled
echo "Checking GCP service API status..."
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com --project "$PROJECT_ID"

# 3. Deploy container via Google Cloud Build & Cloud Run
# Uses multi-stage Dockerfile with standalone Next.js 16 runner
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 10 \
  --concurrency 80 \
  --timeout 60s \
  --memory 2Gi \
  --cpu 2 \
  --set-env-vars NODE_ENV=production,NEXT_PUBLIC_SITE_URL=https://brew-coffee.cafe,FIREBASE_PROJECT_ID=brew-2621e

echo ""
echo "🎉 BREW container successfully deployed to Google Cloud Run!"
echo "Check your live service URL via: gcloud run services describe $SERVICE_NAME --region $REGION --format 'value(status.url)'"
