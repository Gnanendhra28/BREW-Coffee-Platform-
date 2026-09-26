// Sentry Error Monitoring & Exception Tracking Layer
// Captures uncaught client-side and server-side exceptions with breadcrumbs and stack traces.

import { logger } from "./logger";

export interface ErrorBreadcrumb {
  category: string;
  message: string;
  level?: "info" | "warning" | "error";
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface UserContext {
  id?: string;
  role?: string;
  phone?: string;
}

class SentryClient {
  private dsn: string | null = null;
  private breadcrumbs: ErrorBreadcrumb[] = [];
  private currentUser: UserContext | null = null;

  constructor() {
    this.dsn =
      process.env.NEXT_PUBLIC_SENTRY_DSN ||
      process.env.SENTRY_DSN ||
      null;
  }

  setUser(user: UserContext | null): void {
    this.currentUser = user;
    this.addBreadcrumb("auth", `User context updated: role=${user?.role || "anonymous"}`);
  }

  addBreadcrumb(
    category: string,
    message: string,
    data?: Record<string, unknown>,
    level: "info" | "warning" | "error" = "info"
  ): void {
    const crumb: ErrorBreadcrumb = {
      category,
      message,
      level,
      timestamp: new Date().toISOString(),
      data,
    };

    this.breadcrumbs.push(crumb);
    // Keep last 25 breadcrumbs
    if (this.breadcrumbs.length > 25) {
      this.breadcrumbs.shift();
    }
  }

  captureException(error: unknown, context?: Record<string, unknown>): string {
    const errorId = `err_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    // 1. Structured log
    logger.error(`[SENTRY] Captured Exception ${errorId}: ${errorMessage}`, error, {
      traceId: errorId,
      context: {
        ...context,
        user: this.currentUser,
        breadcrumbs: [...this.breadcrumbs],
      },
    });

    // 2. Dispatch to live Sentry ingest endpoint if DSN is configured
    if (this.dsn && typeof window !== "undefined") {
      try {
        const payload = {
          event_id: errorId,
          timestamp: new Date().toISOString(),
          message: errorMessage,
          exception: {
            values: [
              {
                type: error instanceof Error ? error.name : "Error",
                value: errorMessage,
                stacktrace: errorStack,
              },
            ],
          },
          breadcrumbs: this.breadcrumbs,
          user: this.currentUser,
          extra: context,
        };

        // Asynchronous non-blocking beacon to Sentry
        if ("sendBeacon" in navigator) {
          navigator.sendBeacon("/api/sentry-ingest", JSON.stringify(payload));
        }
      } catch {
        // Fallback
      }
    }

    return errorId;
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error" = "info",
    context?: Record<string, unknown>
  ): void {
    if (level === "error") {
      logger.error(`[SENTRY] ${message}`, undefined, { context });
    } else if (level === "warning") {
      logger.warn(`[SENTRY] ${message}`, { context });
    } else {
      logger.info(`[SENTRY] ${message}`, { context });
    }
  }
}

export const sentry = new SentryClient();
