#!/bin/bash
set -e

# ==============================================================================
# ☕ BREW Mobile Coffee Platform — Deploy to Google Cloud Run (GCP)
# ==============================================================================

PROJECT_ID="hiring-ai-507307"
REGION="asia-south1"
SERVICE_NAME="brew-coffee-platform"

echo "=========================================================="
echo "🚀 Deploying BREW Coffee Platform to Google Cloud Run"
echo "Project : $PROJECT_ID"
echo "Region  : $REGION"
echo "Service : $SERVICE_NAME"
echo "=========================================================="

# Ensure gcloud CLI is configured
gcloud config set project "$PROJECT_ID"

# Deploy container via Google Cloud Build & Cloud Run
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --min-instances 1 \
  --max-instances 10 \
  --memory 2Gi \
  --cpu 2 \
  --set-env-vars NODE_ENV=production,NEXT_PUBLIC_SITE_URL=https://brew-coffee.cafe

echo ""
echo "🎉 BREW successfully deployed to Google Cloud Run!"
echo "Check your live service URL above."
