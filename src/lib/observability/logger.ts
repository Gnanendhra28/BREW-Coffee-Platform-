// Structured Logging Engine (Axiom / Pino JSON Standard)
// Emits structured JSON events for searchable serverless log aggregators (Axiom, Datadog, GCP Logging).

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  traceId?: string;
  path?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  context?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

class StructuredLogger {
  private formatLog(
    level: LogLevel,
    message: string,
    metadata?: Partial<LogEntry>
  ): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      traceId: metadata?.traceId || crypto.randomUUID().slice(0, 8),
      ...metadata,
    };

    if (metadata?.context) {
      entry.context = metadata.context;
    }

    return entry;
  }

  private output(entry: LogEntry): void {
    const isDev = process.env.NODE_ENV !== "production";

    if (isDev) {
      const colors: Record<LogLevel, string> = {
        debug: "\x1b[34m[DEBUG]\x1b[0m",
        info: "\x1b[32m[INFO]\x1b[0m",
        warn: "\x1b[33m[WARN]\x1b[0m",
        error: "\x1b[31m[ERROR]\x1b[0m",
      };

      const metaStr = entry.durationMs ? ` (${entry.durationMs}ms)` : "";
      const pathStr = entry.path ? ` ${entry.method || "GET"} ${entry.path}` : "";
      console.log(
        `${colors[entry.level]} [${entry.traceId}] ${entry.message}${pathStr}${metaStr}`
      );

      if (entry.error?.stack) {
        console.error(entry.error.stack);
      }
    } else {
      // Production: emit single-line JSON log for Axiom, CloudWatch, Datadog
      console.log(JSON.stringify(entry));
    }
  }

  debug(message: string, metadata?: Partial<LogEntry>): void {
    this.output(this.formatLog("debug", message, metadata));
  }

  info(message: string, metadata?: Partial<LogEntry>): void {
    this.output(this.formatLog("info", message, metadata));
  }

  warn(message: string, metadata?: Partial<LogEntry>): void {
    this.output(this.formatLog("warn", message, metadata));
  }

  error(message: string, err?: unknown, metadata?: Partial<LogEntry>): void {
    let errorDetails: LogEntry["error"] | undefined;

    if (err instanceof Error) {
      errorDetails = {
        name: err.name,
        message: err.message,
        stack: err.stack,
      };
    } else if (err) {
      errorDetails = {
        name: "UnknownError",
        message: String(err),
      };
    }

    this.output(this.formatLog("error", message, { ...metadata, error: errorDetails }));
  }

  request(options: {
    method: string;
    path: string;
    status: number;
    durationMs: number;
    traceId?: string;
    clientIp?: string;
  }): void {
    const level: LogLevel = options.status >= 500 ? "error" : options.status >= 400 ? "warn" : "info";
    this.output(
      this.formatLog(level, `HTTP Request ${options.method} ${options.path} -> ${options.status}`, {
        method: options.method,
        path: options.path,
        status: options.status,
        durationMs: options.durationMs,
        traceId: options.traceId,
        context: { clientIp: options.clientIp },
      })
    );
  }
}

export const logger = new StructuredLogger();
