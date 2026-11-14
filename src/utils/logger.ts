type LogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const SECRET_KEYS = [
  "GEMINI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "ADMIN_SECRET",
  "DATABASE_URL",
  "REDIS_URL",
];

function redactSecrets(input: string): string {
  let output = input;
  // Redact Telegram Bot Tokens anywhere in strings
  output = output.replace(/\b\d{7,14}:[A-Za-z0-9_-]{25,60}\b/g, "[REDACTED_TG_TOKEN]");
  // Redact Google API Keys (AIza...)
  output = output.replace(/\bAIza[0-9A-Za-z_-]{30,45}\b/g, "[REDACTED_API_KEY]");
  // Redact active env secret values if somehow included verbatim
  for (const key of SECRET_KEYS) {
    const val = process.env[key];
    if (val && val.length >= 8 && !val.startsWith("MY_") && !val.startsWith("YOUR_")) {
      output = output.split(val).join(`[REDACTED_${key}]`);
    }
  }
  return output;
}

function sanitizeMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  try {
    const serialized = JSON.stringify(meta, (_key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: redactSecrets(value.message),
          stack: value.stack ? redactSecrets(value.stack) : undefined,
        };
      }
      if (typeof value === "string") {
        return redactSecrets(value);
      }
      return value;
    });
    return JSON.parse(serialized);
  } catch {
    return { note: "unserializable_meta" };
  }
}

class CloudLogger {
  private isStructured(): boolean {
    return (
      process.env.NODE_ENV === "production" ||
      Boolean(process.env.K_SERVICE) ||
      process.env.LOG_FORMAT === "json"
    );
  }

  private emit(severity: LogSeverity, message: string, meta?: Record<string, unknown>) {
    const cleanMessage = redactSecrets(String(message));
    const cleanMeta = sanitizeMeta(meta);
    const timestamp = new Date().toISOString();

    if (this.isStructured()) {
      // Google Cloud Run structured logging format
      const entry = {
        severity,
        message: cleanMessage,
        timestamp,
        service: process.env.K_SERVICE || "mr-hany-telegram-bot",
        revision: process.env.K_REVISION || "local",
        ...(cleanMeta || {}),
      };
      const line = JSON.stringify(entry);
      if (severity === "ERROR") {
        console.error(line);
      } else if (severity === "WARNING") {
        console.warn(line);
      } else {
        console.log(line);
      }
      return;
    }

    const metaSuffix = cleanMeta ? ` ${JSON.stringify(cleanMeta)}` : "";
    const formatted = `[${timestamp}] [${severity}] ${cleanMessage}${metaSuffix}`;
    if (severity === "ERROR") {
      console.error(formatted);
    } else if (severity === "WARNING") {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }
  }

  public debug(message: string, meta?: Record<string, unknown>) {
    if (process.env.LOG_LEVEL === "debug") {
      this.emit("DEBUG", message, meta);
    }
  }

  public info(message: string, meta?: Record<string, unknown>) {
    this.emit("INFO", message, meta);
  }

  public warn(message: string, meta?: Record<string, unknown>) {
    this.emit("WARNING", message, meta);
  }

  public error(message: string, meta?: Record<string, unknown>) {
    this.emit("ERROR", message, meta);
  }
}

export const logger = new CloudLogger();
