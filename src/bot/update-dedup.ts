import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

export type AcquireResult = "acquired" | "duplicate_processing" | "duplicate_done";

interface DedupEntry {
  status: "processing" | "done";
  createdAt: number;
  expiresAt: number;
  messageKey?: string;
}

/**
 * Prevents duplicate execution of repeated Telegram webhook updates.
 * Layer 1: Atomic in-memory TTL lock by update_id AND secondary (chatId:messageId) key.
 * Layer 2 (Optional on Cloud Run): Distributed Firestore REST lock when ENABLE_FIRESTORE_DEDUP=true.
 */
export class UpdateDeduplicator {
  private updateEntries = new Map<number, DedupEntry>();
  private messageKeyEntries = new Map<string, { updateId: number; status: "processing" | "done"; expiresAt: number }>();
  private readonly ttlMs: number;
  private deduplicatedCount = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private firebaseConfig: { projectId?: string; firestoreDatabaseId?: string } | null = null;

  constructor(ttlMs: number = 24 * 60 * 60 * 1000) {
    this.ttlMs = ttlMs;
    this.loadFirebaseConfig();
    this.cleanupTimer = setInterval(() => this.pruneExpired(), 10 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  private loadFirebaseConfig() {
    try {
      const cfgPath = path.join(process.cwd(), "firebase-applet-config.json");
      if (fs.existsSync(cfgPath)) {
        const parsed = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        this.firebaseConfig = {
          projectId: process.env.GCP_PROJECT_ID || parsed.projectId,
          firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || parsed.firestoreDatabaseId || "(default)",
        };
      } else if (process.env.GCP_PROJECT_ID) {
        this.firebaseConfig = {
          projectId: process.env.GCP_PROJECT_ID,
          firestoreDatabaseId: process.env.FIRESTORE_DATABASE_ID || "(default)",
        };
      }
    } catch {
      this.firebaseConfig = null;
    }
  }

  public pruneExpired() {
    const now = Date.now();
    for (const [id, entry] of this.updateEntries.entries()) {
      if (entry.expiresAt <= now) {
        this.updateEntries.delete(id);
      }
    }
    for (const [key, entry] of this.messageKeyEntries.entries()) {
      if (entry.expiresAt <= now) {
        this.messageKeyEntries.delete(key);
      }
    }
  }

  private async getCloudRunAccessToken(): Promise<string | null> {
    if (process.env.ENABLE_FIRESTORE_DEDUP !== "true") return null;
    if (!process.env.K_SERVICE && !process.env.USE_GCP_METADATA_TOKEN) return null;

    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 1500);
      const res = await fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        {
          headers: { "Metadata-Flavor": "Google" },
          signal: controller.signal,
        }
      );
      clearTimeout(t);
      if (!res.ok) return null;
      const data = (await res.json()) as { access_token?: string };
      return data.access_token || null;
    } catch {
      return null;
    }
  }

  /**
   * Distributed Firestore create-if-not-exists check for multi-instance Cloud Run scaling.
   * Returns true if acquired or unavailable (fail-open to memory lock), false if already exists in Firestore.
   */
  private async tryAcquireDistributed(updateId: number, messageKey?: string): Promise<boolean> {
    if (process.env.ENABLE_FIRESTORE_DEDUP !== "true" || !this.firebaseConfig?.projectId) {
      return true;
    }
    const token = await this.getCloudRunAccessToken();
    if (!token) {
      return true;
    }

    const dbId = this.firebaseConfig.firestoreDatabaseId || "(default)";
    const url =
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(this.firebaseConfig.projectId)}` +
      `/databases/${encodeURIComponent(dbId)}/documents/telegram_updates?documentId=upd_${updateId}`;

    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fields: {
            updateId: { integerValue: String(updateId) },
            messageKey: { stringValue: messageKey || "" },
            createdAt: { timestampValue: new Date().toISOString() },
            revision: { stringValue: process.env.K_REVISION || "cloudrun" },
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(t);

      if (res.status === 409) {
        return false;
      }
      return true;
    } catch (err: any) {
      logger.warn("Distributed Firestore dedup fallback to in-memory lock", {
        updateId,
        error: err?.message,
      });
      return true;
    }
  }

  public async tryAcquire(updateId: number, messageKey?: string): Promise<AcquireResult> {
    this.pruneExpired();
    const now = Date.now();

    const existingUpdate = this.updateEntries.get(updateId);
    if (existingUpdate && existingUpdate.expiresAt > now) {
      this.deduplicatedCount += 1;
      return existingUpdate.status === "done" ? "duplicate_done" : "duplicate_processing";
    }

    if (messageKey) {
      const existingMsg = this.messageKeyEntries.get(messageKey);
      if (existingMsg && existingMsg.expiresAt > now) {
        this.deduplicatedCount += 1;
        return existingMsg.status === "done" ? "duplicate_done" : "duplicate_processing";
      }
    }

    // Reserve synchronously BEFORE awaiting distributed check to prevent concurrent race conditions on same instance
    const entry: DedupEntry = {
      status: "processing",
      createdAt: now,
      expiresAt: now + this.ttlMs,
      messageKey,
    };
    this.updateEntries.set(updateId, entry);
    if (messageKey) {
      this.messageKeyEntries.set(messageKey, {
        updateId,
        status: "processing",
        expiresAt: now + this.ttlMs,
      });
    }

    const acquiredRemote = await this.tryAcquireDistributed(updateId, messageKey);
    if (!acquiredRemote) {
      entry.status = "done";
      if (messageKey) {
        this.messageKeyEntries.set(messageKey, {
          updateId,
          status: "done",
          expiresAt: now + this.ttlMs,
        });
      }
      this.deduplicatedCount += 1;
      return "duplicate_done";
    }

    return "acquired";
  }

  public markDone(updateId: number, messageKey?: string) {
    const existing = this.updateEntries.get(updateId);
    if (existing) {
      existing.status = "done";
    }
    if (messageKey) {
      const msgEntry = this.messageKeyEntries.get(messageKey);
      if (msgEntry) {
        msgEntry.status = "done";
      }
    }
  }

  public markFailed(updateId: number, messageKey?: string, allowRetry: boolean = false) {
    if (allowRetry) {
      this.updateEntries.delete(updateId);
      if (messageKey) {
        this.messageKeyEntries.delete(messageKey);
      }
    } else {
      this.markDone(updateId, messageKey);
    }
  }

  public getStats() {
    this.pruneExpired();
    return {
      deduplicatedCount: this.deduplicatedCount,
      trackedUpdates: this.updateEntries.size,
    };
  }

  public stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
