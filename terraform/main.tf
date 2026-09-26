# ==============================================================================
# ☕ BREW Mobile Coffee Platform — Infrastructure as Code (Terraform)
# Provisions Google Cloud Run Serverless Container, Custom Domain & IAM
# ==============================================================================

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# 1. Enable Required Cloud APIs
resource "google_project_service" "cloud_run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "secret_manager" {
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

# 2. Serverless Cloud Run v2 Service (Auto-scaling & Zero-Downtime Revisions)
resource "google_cloud_run_v2_service" "brew_service" {
  name     = "brew-coffee-${var.environment}"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    containers {
      image = var.container_image

      resources {
        limits = {
          cpu    = "2000m"
          memory = "2Gi"
        }
        cpu_idle = false
      }

      ports {
        container_port = 3000
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "NEXT_PUBLIC_SITE_URL"
        value = "https://${var.domain_name}"
      }

      startup_probe {
        initial_delay_seconds = 5
        timeout_seconds       = 2
        period_seconds        = 5
        failure_threshold     = 3
        http_get {
          path = "/api/health"
          port = 3000
        }
      }

      liveness_probe {
        timeout_seconds = 2
        period_seconds  = 15
        http_get {
          path = "/api/health"
          port = 3000
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  depends_on = [google_project_service.cloud_run]
}

# 3. Public IAM Policy: Allow Unauthenticated Invocation
resource "google_cloud_run_service_iam_member" "public_access" {
  location = google_cloud_run_v2_service.brew_service.location
  service  = google_cloud_run_v2_service.brew_service.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# 4. Custom Domain Mapping & Managed SSL Certificate
resource "google_cloud_run_domain_mapping" "custom_domain" {
  location = var.region
  name     = var.domain_name

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.brew_service.name
  }
}

output "service_url" {
  description = "The default Cloud Run service URL"
  value       = google_cloud_run_v2_service.brew_service.uri
}

output "custom_domain_dns_records" {
  description = "DNS records to configure at your registrar for brew-coffee.cafe"
  value       = google_cloud_run_domain_mapping.custom_domain.status[0].resource_records
}
