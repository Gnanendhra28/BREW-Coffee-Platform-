variable "project_id" {
  description = "Google Cloud Project ID"
  type        = string
  default     = "hiring-ai-507307"
}

variable "region" {
  description = "Deployment region for the serverless containers"
  type        = string
  default     = "asia-south1" # Mumbai / Hyderabad low latency
}

variable "environment" {
  description = "Deployment environment (production or staging)"
  type        = string
  default     = "production"
}

variable "container_image" {
  description = "Container image URI in Artifact Registry or ECR"
  type        = string
  default     = "gcr.io/brew-coffee-platform/brew-web:latest"
}

variable "domain_name" {
  description = "Custom domain for the platform"
  type        = string
  default     = "brew-coffee.cafe"
}

variable "min_instances" {
  description = "Minimum container instances to prevent cold starts during rush hour"
  type        = number
  default     = 1
}

variable "max_instances" {
  description = "Maximum container instances for peak concurrency"
  type        = number
  default     = 10
}
