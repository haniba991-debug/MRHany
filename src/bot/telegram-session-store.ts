import crypto from "crypto";
import fs from "fs";
import path from "path";

type ServiceAccount = { client_email: string; private_key: string };
type SessionRecord = {
  language: "ar" | "en";
  history: Array<{ role: "user" | "model"; content: string }>;
  activeSkill?: string;
  memorySummary?: string;
  memoryTopics?: string[];
  memoryUpdatedAt?: number;
  referenceTemplate?: { fileName: string; blueprint: string; savedAt: number };
  updatedAt: number;
};

/** Firestore-backed session storage. Uses Cloud Run metadata identity or a service account secret. */
class TelegramSessionStore {
  private cachedToken: { value: string; expiresAt: number } | null = null;
  private serviceAccount: ServiceAccount | null | undefined;
  private config: { projectId: string; databaseId: string } | null | undefined;

  public isConfigured(): boolean {
    return Boolean(this.getConfig() && (process.env.K_SERVICE || this.getServiceAccount()));
  }

  private getConfig() {
    if (this.config !== undefined) return this.config;
    try {
      const configPath = path.join(process.cwd(), "firebase-applet-config.json");
      const file = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
      const projectId = process.env.GCP_PROJECT_ID || file.projectId;
      this.config = projectId
        ? { projectId, databaseId: process.env.FIRESTORE_DATABASE_ID || file.firestoreDatabaseId || "(default)" }
        : null;
    } catch {
      this.config = null;
    }
    return this.config;
  }

  private getServiceAccount(): ServiceAccount | null {
    if (this.serviceAccount !== undefined) return this.serviceAccount;
    try {
      const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
      const raw = encoded ? Buffer.from(encoded, "base64").toString("utf8") : process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
      if (!raw) {
        this.serviceAccount = null;
      } else {
        const parsed = JSON.parse(raw);
        this.serviceAccount = parsed.client_email && parsed.private_key
          ? { client_email: parsed.client_email, private_key: parsed.private_key }
          : null;
      }
    } catch {
      this.serviceAccount = null;
    }
    return this.serviceAccount;
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.cachedToken && this.cachedToken.expiresAt > Date.now() + 60_000) return this.cachedToken.value;

    if (process.env.K_SERVICE || process.env.USE_GCP_METADATA_TOKEN === "true") {
      try {
        const response = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
          headers: { "Metadata-Flavor": "Google" },
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const data = await response.json() as { access_token?: string; expires_in?: number };
          if (data.access_token) {
            this.cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3500) * 1000 };
            return data.access_token;
          }
        }
      } catch {
        // Use a configured service account when running outside Google Cloud.
      }
    }

    const account = this.getServiceAccount();
    if (!account) return null;
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/datastore",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(unsigned);
    const assertion = `${unsigned}.${signer.sign(account.private_key, "base64url")}`;
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Firestore credential exchange failed (${response.status})`);
    const data = await response.json() as { access_token: string; expires_in?: number };
    this.cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 3500) * 1000 };
    return data.access_token;
  }

  private documentUrl(uid: number) {
    const config = this.getConfig();
    if (!config) return null;
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(config.projectId)}/databases/${encodeURIComponent(config.databaseId)}/documents/telegram_sessions/${uid}`;
  }

  public async load(uid: number): Promise<SessionRecord | null> {
    const url = this.documentUrl(uid);
    const token = await this.getAccessToken();
    if (!url || !token) return null;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Firestore session read failed (${response.status})`);
    const data = await response.json() as { fields?: { payload?: { stringValue?: string } } };
    if (!data.fields?.payload?.stringValue) return null;
    try {
      const parsed = JSON.parse(data.fields.payload.stringValue) as Partial<SessionRecord>;
      if (!Array.isArray(parsed.history) || (parsed.language !== "ar" && parsed.language !== "en")) return null;
      return {
        language: parsed.language,
        history: parsed.history
          .filter((item) => item && (item.role === "user" || item.role === "model") && typeof item.content === "string")
          .slice(-40)
          .map((item) => ({ role: item.role!, content: item.content!.slice(0, 6000) })),
        activeSkill: typeof parsed.activeSkill === "string" ? parsed.activeSkill : undefined,
        memorySummary: typeof parsed.memorySummary === "string" ? parsed.memorySummary.slice(0, 5000) : "",
        memoryTopics: Array.isArray(parsed.memoryTopics)
          ? parsed.memoryTopics.filter((topic): topic is string => typeof topic === "string").slice(0, 20)
          : [],
        memoryUpdatedAt: typeof parsed.memoryUpdatedAt === "number" ? parsed.memoryUpdatedAt : undefined,
        referenceTemplate: parsed.referenceTemplate &&
          typeof parsed.referenceTemplate.fileName === "string" &&
          typeof parsed.referenceTemplate.blueprint === "string"
          ? {
              fileName: parsed.referenceTemplate.fileName.slice(0, 180),
              blueprint: parsed.referenceTemplate.blueprint.slice(0, 8000),
              savedAt: typeof parsed.referenceTemplate.savedAt === "number" ? parsed.referenceTemplate.savedAt : Date.now(),
            }
          : undefined,
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      };
    } catch { return null; }
  }

  public async save(uid: number, session: SessionRecord): Promise<void> {
    const url = this.documentUrl(uid);
    const token = await this.getAccessToken();
    if (!url || !token) return;
    const safeSession = { ...session } as SessionRecord & { batchInspection?: unknown; awaitingReference?: unknown };
    // Uploaded images and source templates are temporary working material and
    // must never be serialized into the persistent conversation document.
    delete safeSession.batchInspection;
    delete safeSession.awaitingReference;
    const response = await fetch(url, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          payload: {
            stringValue: JSON.stringify({
              ...safeSession,
              history: safeSession.history.slice(-40).map((item) => ({
                role: item.role,
                content: item.content.slice(0, 6000),
              })),
              memorySummary: (safeSession.memorySummary || "").slice(0, 5000),
              memoryTopics: (safeSession.memoryTopics || []).slice(0, 20),
              referenceTemplate: safeSession.referenceTemplate
                ? {
                    fileName: safeSession.referenceTemplate.fileName.slice(0, 180),
                    blueprint: safeSession.referenceTemplate.blueprint.slice(0, 8000),
                    savedAt: safeSession.referenceTemplate.savedAt,
                  }
                : undefined,
            }),
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Firestore session write failed (${response.status})`);
  }

  public async delete(uid: number): Promise<void> {
    const url = this.documentUrl(uid);
    const token = await this.getAccessToken();
    if (!url || !token) return;
    const response = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok && response.status !== 404) throw new Error(`Firestore session delete failed (${response.status})`);
  }
}

export const telegramSessionStore = new TelegramSessionStore();
