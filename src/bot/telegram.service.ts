import crypto from "crypto";
import sharp from "sharp";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { serverGemini } from "../ai/gemini.service";
import { agentOrchestrator } from "../agents/orchestrator";
import { DocumentParser } from "../documents/document.parser";
import { DocxGenerator } from "../generators/docx.generator";
import { FileValidator } from "../generators/file-validator";
import { TempFileStorage } from "../generators/file-storage";
import { logger } from "../utils/logger";
import { withRetry } from "../utils/retry";
import { UpdateDeduplicator } from "./update-dedup";
import { telegramSessionStore } from "./telegram-session-store";

export interface TelegramActivityItem {
  id: string;
  timestamp: string;
  fromUser: string;
  userInput: string;
  skillUsed: string;
  replyPreview: string;
  generatedFileName?: string;
}

export interface TelegramBotStatus {
  connected: boolean;
  botUsername?: string;
  botFirstName?: string;
  botLink?: string;
  mode: "webhook" | "polling" | "simulator_ready";
  executionMode: "async" | "sync";
  webhookUrl?: string;
  webhookSecretConfigured: boolean;
  processedTelegramMessages: number;
  deduplicatedUpdates: number;
  inFlightJobs: number;
  completedJobs: number;
  failedJobs: number;
  recentActivity: TelegramActivityItem[];
  lastError?: string;
}

export interface WebhookHandleResult {
  accepted: boolean;
  duplicate?: boolean;
  status: "queued" | "processed" | "duplicate" | "rejected";
  reason?: string;
}

interface TelegramUserSession {
  activeSkill?: string;
  language: "ar" | "en";
  history: Array<{ role: "user" | "model"; content: string }>;
  memorySummary: string;
  memoryTopics: string[];
  memoryUpdatedAt?: number;
  referenceTemplate?: { fileName: string; blueprint: string; savedAt: number };
  awaitingReference?: boolean;
  batchInspection?: {
    photos: Array<{ buffer: Buffer; fileName: string; mimeType: string; note?: string }>;
    totalBytes: number;
    templateText?: string;
    templateFileName?: string;
    processing?: boolean;
  };
  updatedAt: number;
}

type InspectionOutputFormat = "word" | "excel" | "pdf";
const MAX_BATCH_PHOTOS = 300;

const DEFAULT_ROOM_DEFECTS_REFERENCE = [
  "عنوان عربي في أعلى المستند: تقرير ملاحظات الغرف مع نطاق أرقام الغرف.",
  "تخطيط أدلة الصور في شبكة من عمودين وصفين (أربع صور بكل مجموعة)، مع وصف قصير ملاصق لكل صورة.",
  "كل ملاحظة تربط رقم الغرفة والعنصر/الموقع ووصف العيب بصورة دليل واضحة.",
  "استخدم عناوين قصيرة بالعربية، واتجاه كتابة من اليمين إلى اليسار، وحدود خفيفة للجداول.",
  "لا تنقل أرقام الغرف أو أسماء العناصر أو العيوب من التقرير المرجعي؛ استخدم فقط ما يظهر أو ما يكتبه المستخدم في الدفعة الجديدة.",
].join("\n");

class TelegramBotManager {
  private bot: Bot | null = null;
  private activeToken: string = "";
  private initPromise: Promise<TelegramBotStatus> | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private deduplicator = new UpdateDeduplicator();
  private inFlightTasks = new Set<Promise<void>>();
  private isDraining = false;

  private status: TelegramBotStatus = {
    connected: false,
    mode: "simulator_ready",
    executionMode: this.getExecutionMode(),
    webhookSecretConfigured: this.isWebhookSecretConfigured(),
    processedTelegramMessages: 0,
    deduplicatedUpdates: 0,
    inFlightJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    recentActivity: [],
  };

  private userSessions = new Map<number, TelegramUserSession>();
  private memoryCompactions = new Set<number>();

  public getExecutionMode(): "async" | "sync" {
    return process.env.WEBHOOK_EXECUTION_MODE === "sync" ? "sync" : "async";
  }

  public isWebhookSecretConfigured(): boolean {
    const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    return Boolean(secret && secret.length >= 8 && !secret.startsWith("YOUR_"));
  }

  private getWebhookUrl(): string {
    const configuredUrl = (process.env.TELEGRAM_WEBHOOK_URL || "").trim();
    if (configuredUrl) return configuredUrl;
    // Render provides the public HTTPS origin automatically for free web services.
    const renderUrl = (process.env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
    return renderUrl ? `${renderUrl}/telegram/webhook` : "";
  }

  public resolveTargetMode(): "webhook" | "polling" {
    const configured = (process.env.TELEGRAM_MODE || "auto").toLowerCase().trim();
    if (configured === "webhook") return "webhook";
    if (configured === "polling") return "polling";
    // Auto mode: use HTTPS webhook in production or whenever TELEGRAM_WEBHOOK_URL is explicitly configured
    if (
      process.env.NODE_ENV === "production" ||
      Boolean(process.env.TELEGRAM_WEBHOOK_URL)
    ) {
      return "webhook";
    }
    return "polling";
  }

  public verifyWebhookSecret(receivedHeader?: string): boolean {
    const expected = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    if (!expected || !receivedHeader) {
      return false;
    }
    const a = Buffer.from(receivedHeader.trim(), "utf-8");
    const b = Buffer.from(expected, "utf-8");
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(a, b);
  }

  public getMainMenuKeyboard(lang: "ar" | "en" = "ar"): InlineKeyboard {
    if (lang === "en") {
      return new InlineKeyboard()
        .text("1. AI Chat 💬", "menu_chat")
        .text("2. Read Documents 📄", "menu_doc")
        .row()
        .text("3. Analyze Images 🖼️", "menu_img")
        .text("4. Voice Assistant 🎙️", "menu_voice")
        .row()
        .text("5. Create Word 📝", "menu_word")
        .text("6. Create Excel 📊", "menu_excel")
        .row()
        .text("7. Create PDF 📑", "menu_pdf")
        .text("8. Create PowerPoint 📽️", "menu_ppt")
        .row()
        .text("9. Data Analysis 📈", "menu_data")
        .text("10. Engineering Assistant 📐", "menu_eng")
        .row()
        .text("11. Conversation History 📜", "menu_history")
        .text("12. Settings ⚙️", "menu_settings")
        .row()
        .text("13. Help ❓", "menu_help");
    }

    return new InlineKeyboard()
      .text("1. المحادثة الذكية 💬", "menu_chat")
      .text("2. قراءة المستندات 📄", "menu_doc")
      .row()
      .text("3. تحليل الصور 🖼️", "menu_img")
      .text("4. المساعد الصوتي 🎙️", "menu_voice")
      .row()
      .text("5. إنشاء ملف Word 📝", "menu_word")
      .text("6. إنشاء ملف Excel 📊", "menu_excel")
      .row()
      .text("7. إنشاء ملف PDF 📑", "menu_pdf")
      .text("8. عروض PowerPoint 📽️", "menu_ppt")
      .row()
      .text("9. تحليل البيانات 📈", "menu_data")
      .text("10. المساعد الهندسي 📐", "menu_eng")
      .row()
      .text("11. سجل المحادثات 📜", "menu_history")
      .text("12. الإعدادات ⚙️", "menu_settings")
      .row()
      .text("13. المساعدة ❓", "menu_help");
  }

  public getStatus(): TelegramBotStatus {
    const dedupStats = this.deduplicator.getStats();
    return {
      ...this.status,
      executionMode: this.getExecutionMode(),
      webhookSecretConfigured: this.isWebhookSecretConfigured(),
      webhookUrl: this.getWebhookUrl() || this.status.webhookUrl,
      deduplicatedUpdates: dedupStats.deduplicatedCount,
      inFlightJobs: this.inFlightTasks.size,
    };
  }

  private sanitizeToken(raw?: string): string {
    if (!raw) return "";
    const cleaned = raw.trim().replace(/^["']|["']$/g, "");
    const tokenMatch = cleaned.match(/(\d{7,14}:[A-Za-z0-9_-]{30,50})/);
    if (tokenMatch) {
      return tokenMatch[1];
    }
    return cleaned;
  }

  public async verifyConnectionOnly(customToken?: string): Promise<TelegramBotStatus> {
    if (this.status.connected && this.bot && !customToken) {
      try {
        const me = await withRetry(() => this.bot!.api.getMe(), {
          label: "telegram:getMe",
          maxAttempts: 2,
        });
        return {
          ...this.getStatus(),
          connected: true,
          botUsername: me.username,
          botFirstName: me.first_name,
          botLink: `https://t.me/${me.username}`,
        };
      } catch (err: any) {
        return {
          ...this.getStatus(),
          connected: false,
          lastError: err?.message || String(err),
        };
      }
    }

    const rawToken = customToken || process.env.TELEGRAM_BOT_TOKEN;
    const token = this.sanitizeToken(rawToken);
    if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN" || token.length < 15) {
      return {
        ...this.getStatus(),
        connected: false,
        mode: "simulator_ready",
        lastError: "TELEGRAM_BOT_TOKEN is not configured.",
      };
    }

    try {
      const probeBot = new Bot(token);
      const me = await withRetry(() => probeBot.api.getMe(), {
        label: "telegram:probeGetMe",
        maxAttempts: 2,
      });
      return {
        ...this.getStatus(),
        connected: true,
        botUsername: me.username,
        botFirstName: me.first_name,
        botLink: `https://t.me/${me.username}`,
        mode: this.resolveTargetMode(),
        lastError: undefined,
      };
    } catch (err: any) {
      return {
        ...this.getStatus(),
        connected: false,
        mode: "simulator_ready",
        lastError: err?.message || String(err),
      };
    }
  }

  public async initialize(customToken?: string): Promise<TelegramBotStatus> {
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.performInitialize(customToken).finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private launchPollingSafely(
    botInstance: Bot,
    me: { username: string; first_name: string },
    retryCount: number = 0
  ) {
    if (this.bot !== botInstance || this.isDraining) return;

    botInstance
      .start({
        drop_pending_updates: retryCount === 0,
        onStart: () => {
          logger.info("Telegram polling started", { botUsername: me.username });
          this.status = {
            ...this.status,
            connected: true,
            botUsername: me.username,
            botFirstName: me.first_name,
            botLink: `https://t.me/${me.username}`,
            mode: "polling",
            lastError: undefined,
          };
        },
      })
      .catch((err: any) => {
        if (this.bot !== botInstance || this.isDraining) return;
        const msg = String(err?.message || err || "");
        const isConflict409 =
          err?.error_code === 409 || msg.includes("409") || msg.includes("Conflict");

        if (isConflict409 && retryCount < 5) {
          const delayMs = Math.min(6000 * (retryCount + 1), 30000);
          logger.warn("Telegram polling 409 conflict detected; scheduling backoff retry", {
            retryCount: retryCount + 1,
            delayMs,
          });
          if (this.retryTimer) clearTimeout(this.retryTimer);
          this.retryTimer = setTimeout(() => {
            this.launchPollingSafely(botInstance, me, retryCount + 1);
          }, delayMs);
          return;
        }

        logger.warn("Telegram polling stopped", { error: msg });
      });
  }

  private async performInitialize(customToken?: string): Promise<TelegramBotStatus> {
    const rawToken = customToken || process.env.TELEGRAM_BOT_TOKEN;
    const token = this.sanitizeToken(rawToken);
    const targetMode = this.resolveTargetMode();

    if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN" || token.length < 15) {
      this.status = {
        ...this.status,
        connected: false,
        mode: "simulator_ready",
      };
      return this.getStatus();
    }

    if (
      token.startsWith("http://") ||
      token.startsWith("https://") ||
      token.includes("t.me/") ||
      token.includes("telegram.me/") ||
      token.startsWith("@")
    ) {
      const extractedUsername = token
        .replace(/^.*?t\.me\//i, "")
        .replace(/^.*?telegram\.me\//i, "")
        .replace(/^@/, "")
        .split(/[/?#\s]/)[0];

      this.status = {
        ...this.status,
        connected: false,
        botUsername: extractedUsername || undefined,
        botLink: extractedUsername ? `https://t.me/${extractedUsername}` : undefined,
        mode: "simulator_ready",
        lastError: `Provided value is a Telegram URL/username (@${extractedUsername}), not a @BotFather HTTP API Token.`,
      };
      return this.getStatus();
    }

    if (
      this.bot &&
      this.status.connected &&
      this.activeToken === token &&
      this.status.mode === targetMode
    ) {
      return this.getStatus();
    }

    try {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }

      if (this.bot) {
        const oldBot = this.bot;
        this.bot = null;
        try {
          await oldBot.stop();
        } catch {
          // Ignore stop errors on previous instance
        }
      }

      const newBot = new Bot(token);
      newBot.catch((err) => {
        logger.error("Telegram bot middleware error", {
          error: err.message || String(err),
          updateId: err.ctx?.update?.update_id,
          chatId: err.ctx?.chat?.id,
        });
      });

      // Initialize botInfo synchronously via Telegram getMe/init (mandatory before handleUpdate in webhook mode)
      await withRetry(() => newBot.init(), {
        label: "telegram:init",
        maxAttempts: 3,
      });
      const me = newBot.botInfo;
      this.activeToken = token;

      // Register bot commands cleanly (rate-limit resilient)
      await withRetry(
        () =>
          newBot.api.setMyCommands([
            { command: "start", description: "تشغيل مستر هاني والقائمة الرئيسية / Start Mr. Hany" },
            { command: "help", description: "عرض المزايا والأوامر / Show available features" },
            { command: "chat", description: "بدء محادثة ذكية / Start AI conversation" },
            { command: "document", description: "تحليل المستندات / Analyze documents" },
            { command: "image", description: "تحليل الصور والمخططات / Analyze images" },
            { command: "voice", description: "المساعد الصوتي / Voice assistant" },
            { command: "word", description: "إنشاء مستند Word / Generate DOCX" },
            { command: "excel", description: "إنشاء جدول Excel / Generate XLSX" },
            { command: "pdf", description: "إنشاء تقرير PDF / Generate PDF" },
            { command: "ppt", description: "إنشاء عرض PowerPoint / Generate PPTX" },
            { command: "history", description: "سجل المحادثات / View conversation history" },
            { command: "memory", description: "ما الذي يتذكره البوت / View long-term memory" },
            { command: "batch", description: "بدء تجميع صور الفحص / Start a photo inspection batch" },
            { command: "finish", description: "تحليل الصور وإصدار التقرير / Finish batch and create report" },
            { command: "cancelbatch", description: "إلغاء تجميع الصور / Cancel photo batch" },
            { command: "saveref", description: "حفظ ملف كنموذج مرجعي / Save a report template" },
            { command: "refs", description: "عرض النموذج المرجعي / View saved template" },
            { command: "forgetref", description: "حذف النموذج المرجعي / Remove saved template" },
            { command: "settings", description: "إدارة الإعدادات / Manage settings" },
            { command: "clear", description: "مسح المحادثة الحالية / Clear context" },
          ]),
        { label: "telegram:setMyCommands", maxAttempts: 2 }
      ).catch((err) => {
        logger.warn("setMyCommands notice (non-fatal)", { error: err?.message });
      });

      this.registerHandlers(newBot);
      this.bot = newBot;

      if (targetMode === "webhook") {
        // Webhook mode: NEVER start long polling (which causes 409 conflicts across Cloud Run instances)
        const webhookUrl = this.getWebhookUrl();
        this.status = {
          ...this.status,
          connected: true,
          botUsername: me.username,
          botFirstName: me.first_name,
          botLink: `https://t.me/${me.username}`,
          mode: "webhook",
          webhookUrl: webhookUrl || undefined,
          lastError: undefined,
        };

        if (webhookUrl && process.env.TELEGRAM_AUTO_SET_WEBHOOK === "true") {
          await this.setWebhook(webhookUrl, process.env.TELEGRAM_WEBHOOK_SECRET);
        }

        logger.info("Telegram Bot initialized in HTTPS Webhook mode", {
          botUsername: me.username,
          webhookUrl: webhookUrl || "not_set",
          secretConfigured: this.isWebhookSecretConfigured(),
          executionMode: this.getExecutionMode(),
        });

        return this.getStatus();
      }

      // Polling mode (local development / AI Studio preview)
      await withRetry(() => newBot.api.deleteWebhook({ drop_pending_updates: false }), {
        label: "telegram:deleteWebhookForPolling",
        maxAttempts: 2,
      });

      this.status = {
        ...this.status,
        connected: true,
        botUsername: me.username,
        botFirstName: me.first_name,
        botLink: `https://t.me/${me.username}`,
        mode: "polling",
        lastError: undefined,
      };

      this.launchPollingSafely(newBot, me, 0);
      return this.getStatus();
    } catch (err: any) {
      logger.error("Telegram Bot initialization failed", { error: err?.message });
      this.status = {
        ...this.status,
        connected: false,
        mode: "simulator_ready",
        lastError: err.message || "Invalid Telegram Bot Token",
      };
      return this.getStatus();
    }
  }

  /**
   * Registers the HTTPS Webhook URL with Telegram Bot API (including secret_token verification).
   */
  public async setWebhook(url: string, secretToken?: string) {
    if (!this.bot) {
      await this.initialize();
    }
    if (!this.bot) {
      throw new Error("Telegram Bot is not initialized (missing TELEGRAM_BOT_TOKEN).");
    }
    const cleanUrl = url.trim().replace(/\/+$/, "");
    const finalUrl =
      cleanUrl.endsWith("/telegram/webhook") || cleanUrl.endsWith("/api/telegram/webhook")
        ? cleanUrl
        : `${cleanUrl}/telegram/webhook`;

    const secret = (secretToken || process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    if (!secret || secret.length < 8) {
      throw new Error(
        "TELEGRAM_WEBHOOK_SECRET must be at least 8 characters before registering a webhook."
      );
    }

    await withRetry(
      () =>
        this.bot!.api.setWebhook(finalUrl, {
          secret_token: secret,
          drop_pending_updates: false,
          max_connections: 40,
          allowed_updates: ["message", "callback_query"],
        }),
      { label: "telegram:setWebhook", maxAttempts: 3 }
    );

    this.status.webhookUrl = finalUrl;
    logger.info("Telegram Webhook registered successfully", { webhookUrl: finalUrl });
    return await this.getWebhookInfo();
  }

  public async deleteWebhook(dropPendingUpdates: boolean = false) {
    const token = this.activeToken || this.sanitizeToken(process.env.TELEGRAM_BOT_TOKEN);
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");
    const api = this.bot?.api || new Bot(token).api;
    await withRetry(() => api.deleteWebhook({ drop_pending_updates: dropPendingUpdates }), {
      label: "telegram:deleteWebhook",
      maxAttempts: 2,
    });
    this.status.webhookUrl = undefined;
    logger.info("Telegram Webhook deleted");
  }

  public async getWebhookInfo() {
    const token = this.activeToken || this.sanitizeToken(process.env.TELEGRAM_BOT_TOKEN);
    if (!token) {
      return { configured: false, reason: "TELEGRAM_BOT_TOKEN missing" };
    }
    const api = this.bot?.api || new Bot(token).api;
    const info = await withRetry(() => api.getWebhookInfo(), {
      label: "telegram:getWebhookInfo",
      maxAttempts: 2,
    });
    return {
      configured: Boolean(info.url),
      url: info.url,
      hasCustomCertificate: info.has_custom_certificate,
      pendingUpdateCount: info.pending_update_count,
      lastErrorDate: info.last_error_date,
      lastErrorMessage: info.last_error_message,
      maxConnections: info.max_connections,
      ipAddress: info.ip_address,
    };
  }

  private extractDeduplicationKeys(update: any): { updateId: number; messageKey?: string; chatId?: number } {
    const updateId = Number(update?.update_id);
    const msg = update?.message || update?.edited_message;
    const cb = update?.callback_query;
    const chatId = msg?.chat?.id ?? cb?.message?.chat?.id;
    let messageKey: string | undefined;

    if (msg?.chat?.id !== undefined && msg?.message_id !== undefined) {
      messageKey = `chat:${msg.chat.id}:msg:${msg.message_id}`;
    } else if (cb?.id) {
      messageKey = `cb:${cb.id}`;
    }

    return { updateId, messageKey, chatId };
  }

  /**
   * Handles incoming HTTPS webhook updates from Telegram:
   * 1. Deduplicates repeated update_id / message keys.
   * 2. Returns within milliseconds so Telegram never times out or retries unnecessarily.
   * 3. Tracks long-running AI/file tasks in inFlightTasks for Cloud Run graceful drain.
   */
  public async handleWebhookUpdate(update: any): Promise<WebhookHandleResult> {
    if (!update || typeof update.update_id !== "number" || !Number.isFinite(update.update_id)) {
      return { accepted: false, status: "rejected", reason: "Invalid update_id payload" };
    }

    if (this.isDraining) {
      return { accepted: false, status: "rejected", reason: "Server is draining for shutdown" };
    }

    const { updateId, messageKey, chatId } = this.extractDeduplicationKeys(update);
    const acquireResult = await this.deduplicator.tryAcquire(updateId, messageKey);

    if (acquireResult !== "acquired") {
      logger.info("Ignored duplicate Telegram webhook update", {
        updateId,
        messageKey,
        acquireResult,
      });
      return {
        accepted: true,
        duplicate: true,
        status: "duplicate",
      };
    }

    if (!this.bot) {
      await this.initialize();
    }

    if (!this.bot) {
      this.deduplicator.markFailed(updateId, messageKey, true);
      return {
        accepted: false,
        status: "rejected",
        reason: "Telegram bot token not configured or bot unavailable",
      };
    }

    const activeBot = this.bot;

    const processTask = async () => {
      const startedAt = Date.now();
      logger.info("Processing Telegram webhook update", {
        updateId,
        chatId,
        hasMessage: Boolean(update.message),
        hasCallback: Boolean(update.callback_query),
      });

      try {
        await activeBot.handleUpdate(update);
        this.deduplicator.markDone(updateId, messageKey);
        this.status.completedJobs += 1;
        logger.info("Completed Telegram webhook update", {
          updateId,
          chatId,
          durationMs: Date.now() - startedAt,
        });
      } catch (err: any) {
        this.status.failedJobs += 1;
        this.deduplicator.markFailed(updateId, messageKey, false);
        logger.error("Failed processing Telegram webhook update", {
          updateId,
          chatId,
          durationMs: Date.now() - startedAt,
          error: err?.message || String(err),
        });
        if (chatId) {
          await withRetry(
            () =>
              activeBot.api.sendMessage(
                chatId,
                "عذراً، حدث خطأ غير متوقع أثناء معالجة رسالتك. يرجى المحاولة مرة أخرى."
              ),
            { label: "telegram:fallbackErrorReply", maxAttempts: 2 }
          ).catch(() => {});
        }
      }
    };

    const executionMode = this.getExecutionMode();
    const trackedPromise = processTask().finally(() => {
      this.inFlightTasks.delete(trackedPromise);
      this.status.inFlightJobs = this.inFlightTasks.size;
    });
    this.inFlightTasks.add(trackedPromise);
    this.status.inFlightJobs = this.inFlightTasks.size;

    if (executionMode === "sync") {
      await trackedPromise;
      return { accepted: true, duplicate: false, status: "processed" };
    }

    // Async mode: return immediately so HTTP 200 OK reaches Telegram within <10ms
    return { accepted: true, duplicate: false, status: "queued" };
  }

  /**
   * Graceful Cloud Run SIGTERM/SIGINT shutdown drain.
   * Stops polling (if running) and waits for active long-running AI/file tasks to finish.
   */
  public async drain(timeoutMs: number = 25000): Promise<void> {
    this.isDraining = true;
    logger.info("Draining TelegramBotManager", {
      inFlightJobs: this.inFlightTasks.size,
      mode: this.status.mode,
    });

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.bot && this.status.mode === "polling") {
      await this.bot.stop().catch(() => {});
    }

    if (this.inFlightTasks.size > 0) {
      const waitAll = Promise.allSettled(Array.from(this.inFlightTasks));
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
      await Promise.race([waitAll, timeout]);
    }

    this.deduplicator.stop();
    logger.info("TelegramBotManager drain complete", {
      remainingJobs: this.inFlightTasks.size,
    });
  }

  private async downloadTelegramFile(fileId: string): Promise<Buffer> {
    if (!this.bot || !this.activeToken) {
      throw new Error("Telegram Bot is not initialized");
    }
    const fileInfo = await withRetry(() => this.bot!.api.getFile(fileId), {
      label: "telegram:getFile",
      maxAttempts: 3,
    });
    if (!fileInfo.file_path) {
      throw new Error("Unable to resolve file_path from Telegram API");
    }
    const maxFileBytes = Number(process.env.TELEGRAM_MAX_FILE_BYTES) || 20 * 1024 * 1024;
    if (fileInfo.file_size && fileInfo.file_size > maxFileBytes) {
      throw new Error(`Telegram file exceeds the ${Math.floor(maxFileBytes / (1024 * 1024))} MB processing limit.`);
    }
    const url = `https://api.telegram.org/file/bot${this.activeToken}/${fileInfo.file_path}`;
    return await withRetry(
      async () => {
        const response = await fetch(url);
        if (!response.ok) {
          const err: any = new Error(`Failed to download file from Telegram (${response.status})`);
          err.status = response.status;
          throw err;
        }
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > maxFileBytes) {
          throw new Error(`Telegram file exceeds the ${Math.floor(maxFileBytes / (1024 * 1024))} MB processing limit.`);
        }
        const arrayBuf = await response.arrayBuffer();
        if (arrayBuf.byteLength > maxFileBytes) {
          throw new Error(`Telegram file exceeds the ${Math.floor(maxFileBytes / (1024 * 1024))} MB processing limit.`);
        }
        return Buffer.from(arrayBuf);
      },
      { label: "telegram:downloadFile", maxAttempts: 3 }
    );
  }

  private async replyWithRetry(ctx: Context, text: string, extra?: any) {
    return await withRetry(() => ctx.reply(text, extra), {
      label: "telegram:reply",
      maxAttempts: 3,
    });
  }

  private async replyDocumentWithRetry(ctx: Context, file: InputFile, extra?: any) {
    return await withRetry(() => ctx.replyWithDocument(file, extra), {
      label: "telegram:replyWithDocument",
      maxAttempts: 3,
    });
  }

  private async replyAudioWithRetry(ctx: Context, file: InputFile, extra?: any) {
    return await withRetry(() => ctx.replyWithAudio(file, extra), {
      label: "telegram:replyWithAudio",
      maxAttempts: 3,
    });
  }

  private getSession(uid: number): TelegramUserSession {
    const existing = this.userSessions.get(uid);
    if (existing) {
      existing.updatedAt = Date.now();
      return existing;
    }
    const fresh: TelegramUserSession = {
      language: "ar",
      history: [],
      memorySummary: "",
      memoryTopics: [],
      referenceTemplate: undefined,
      updatedAt: Date.now(),
    };
    this.userSessions.set(uid, fresh);
    // Keep session map bounded in long-lived Cloud Run instances
    if (this.userSessions.size > 2000) {
      const oldestKey = this.userSessions.keys().next().value;
      if (oldestKey !== undefined) {
        this.userSessions.delete(oldestKey);
      }
    }
    return fresh;
  }

  private recordActivity(item: Omit<TelegramActivityItem, "id" | "timestamp">) {
    const newEntry: TelegramActivityItem = {
      id: `tg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      ...item,
    };
    this.status.processedTelegramMessages += 1;
    this.status.recentActivity = [newEntry, ...this.status.recentActivity.slice(0, 19)];
  }

  private async compactLongTermMemory(uid: number, session: TelegramUserSession): Promise<void> {
    const keepTurns = 24;
    if (
      session.history.length <= 40 ||
      this.memoryCompactions.has(uid) ||
      !telegramSessionStore.isConfigured()
    ) return;

    this.memoryCompactions.add(uid);
    const archiveCount = session.history.length - keepTurns;
    const archivedTurns = session.history.slice(0, archiveCount);
    try {
      const memory = await serverGemini.summarizeLongTermMemory({
        currentSummary: session.memorySummary,
        archivedTurns,
        language: session.language,
      });

      // Avoid overwriting turns that arrived while the summary was being generated.
      const sameArchivedPrefix = archivedTurns.every((turn, index) => {
        const current = session.history[index];
        return current?.role === turn.role && current.content === turn.content;
      });
      if (this.userSessions.get(uid) !== session || !sameArchivedPrefix) return;

      session.memorySummary = memory.summary;
      session.memoryTopics = memory.topics;
      session.memoryUpdatedAt = Date.now();
      session.history = session.history.slice(archiveCount);
      session.updatedAt = Date.now();
      await telegramSessionStore.save(uid, session);
      logger.info("Long-term Telegram memory compacted", {
        userId: uid,
        archivedTurns: archiveCount,
        topicCount: memory.topics.length,
      });
    } catch (err: any) {
      logger.warn("Long-term Telegram memory compaction failed", {
        userId: uid,
        error: err?.message || String(err),
      });
    } finally {
      this.memoryCompactions.delete(uid);
    }
  }

  private async extractReferenceBlueprint(
    fileId: string,
    fileName: string,
    mimeType: string
  ): Promise<string> {
    const lowerName = fileName.toLowerCase();
    const buffer = await this.downloadTelegramFile(fileId);
    let extracted = "";

    if (lowerName.endsWith(".pdf") || mimeType.includes("pdf")) {
      const result = await serverGemini.analyzeImage({
        base64Data: buffer.toString("base64"),
        mimeType: "application/pdf",
        prompt: "استخرج بنية هذا النموذج فقط: عنوانه، ترتيب الأقسام، أسماء الجداول والأعمدة، وأنواع الخانات. لا تنقل الأسماء أو الأرقام أو بيانات الأشخاص الموجودة فيه.",
      });
      extracted = result.text;
    } else {
      const parsed = await DocumentParser.extractDocument(buffer, mimeType, fileName);
      extracted = parsed.extractedText;
    }

    if (!extracted.trim()) {
      throw new Error("الملف النموذجي لا يحتوي على نص أو جداول قابلة للاستخراج.");
    }
    return extracted.slice(0, 8000);
  }

  private async captureInspectionTemplate(
    ctx: Context,
    session: TelegramUserSession,
    fileId: string,
    fileName: string,
    mimeType: string
  ): Promise<void> {
    const batch = session.batchInspection;
    if (!batch) return;
    batch.templateText = await this.extractReferenceBlueprint(fileId, fileName, mimeType);
    batch.templateFileName = fileName.slice(0, 180);
    this.userSessions.set(ctx.from?.id || 0, session);
    await this.replyWithRetry(
      ctx,
      `✅ حفظت شكل الملف النموذجي (${fileName}). هستخدم ترتيب الأقسام والجداول فقط، وبعدها ابعت صور المعاينة.`
    );
  }

  private async saveReferenceTemplate(
    ctx: Context,
    session: TelegramUserSession,
    fileId: string,
    fileName: string,
    mimeType: string
  ): Promise<void> {
    const blueprint = await this.extractReferenceBlueprint(fileId, fileName, mimeType);
    session.referenceTemplate = { fileName: fileName.slice(0, 180), blueprint, savedAt: Date.now() };
    session.awaitingReference = false;
    this.userSessions.set(ctx.from?.id || 0, session);
    const persistenceNote = telegramSessionStore.isConfigured()
      ? "تقدر تبدأ دفعة صور بـ /batch، وهستخدم المرجع تلقائيًا."
      : "المرجع متاح في الجلسة الحالية، لكن الحفظ بعد إعادة تشغيل الخدمة يتطلب إكمال ربط Firestore في Render.";
    await this.replyWithRetry(
      ctx,
      `✅ حفظت بنية الملف «${fileName}» كمرجع لحسابك. ${persistenceNote} لتغييره ارفع مرجعًا جديدًا بـ /saveref.`
    );
  }

  private async captureInspectionPhoto(
    ctx: Context,
    session: TelegramUserSession,
    fileId: string,
    fileName: string,
    mimeType: string = "image/jpeg",
    note?: string
  ): Promise<void> {
    const batch = session.batchInspection;
    if (!batch) return;
    if (batch.processing) {
      await this.replyWithRetry(ctx, "بدأ تحليل الدفعة بالفعل؛ استنى النتيجة قبل إضافة صور جديدة.");
      return;
    }
    if (batch.photos.length >= MAX_BATCH_PHOTOS) {
      await this.replyWithRetry(ctx, `وصلت للحد الأقصى وهو ${MAX_BATCH_PHOTOS} صورة. اكتب /finish word أو /finish excel أو /finish pdf.`);
      return;
    }

    if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
      await this.replyWithRetry(ctx, "صيغة الصورة غير مدعومة؛ ابعتها JPEG أو PNG أو WebP.");
      return;
    }
    const buffer = await this.downloadTelegramFile(fileId);
    const optimized = await sharp(buffer, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
    const maxPhotoBytes = 768 * 1024;
    const maxBatchBytes = 45 * 1024 * 1024;
    if (optimized.length > maxPhotoBytes) {
      await this.replyWithRetry(ctx, "تعذر ضغط الصورة للحجم المناسب. جرّب صورة أصغر أو أقل دقة.");
      return;
    }
    if (batch.totalBytes + optimized.length > maxBatchBytes) {
      await this.replyWithRetry(ctx, "وصلت الدفعة إلى حد 45 ميجابايت بعد الضغط. ابدأ تحليل الصور الحالية بـ /finish أو ألغها بـ /cancelbatch.");
      return;
    }

    batch.photos.push({ buffer: optimized, fileName: fileName.slice(0, 120), mimeType: "image/jpeg", note: note?.slice(0, 500) });
    batch.totalBytes += optimized.length;
    this.userSessions.set(ctx.from?.id || 0, session);
    await this.replyWithRetry(ctx, `📸 تم استلام الصورة ${batch.photos.length}/${MAX_BATCH_PHOTOS}.`);
  }

  private async processInspectionBatch(
    ctx: Context,
    uid: number,
    session: TelegramUserSession,
    format: InspectionOutputFormat
  ): Promise<void> {
    const batch = session.batchInspection;
    if (!batch) return;
    if (batch.photos.length === 0) {
      await this.replyWithRetry(ctx, "لسه ما استلمتش صور. ابعت صورة واحدة أو ألبوم، وبعدها اختار نوع الملف بـ /finish.");
      return;
    }
    if (batch.processing) {
      await this.replyWithRetry(ctx, "تحليل الصور شغال بالفعل، أول ما يخلص هبعت لك الملف.");
      return;
    }

    batch.processing = true;
    const formatSkills: Record<InspectionOutputFormat, string> = {
      word: "WordSkill",
      excel: "ExcelSkill",
      pdf: "PdfSkill",
    };
    const groupSize = 10;
    const groupCount = Math.ceil(batch.photos.length / groupSize);
    let progressMessage: any;

    try {
      progressMessage = await this.replyWithRetry(
        ctx,
        `⏳ بدأت تحليل ${batch.photos.length} صورة على ${groupCount} مجموعات، وبعدها هجهز ملف ${format.toUpperCase()}. ممكن ياخد بضع دقائق.`
      );

      const findings: string[] = [];
      for (let offset = 0; offset < batch.photos.length; offset += groupSize) {
        if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 4000));
        const group = batch.photos.slice(offset, offset + groupSize);
        const firstIndex = offset + 1;
        const lastIndex = offset + group.length;
        const analysis = await serverGemini.analyzeImage({
          base64Data: group[0].buffer.toString("base64"),
          mimeType: group[0].mimeType,
          images: group.map((photo) => ({
            base64Data: photo.buffer.toString("base64"),
            mimeType: photo.mimeType,
          })),
          isEngineeringMode: true,
          prompt: `حلل صور المعاينة من رقم ${firstIndex} إلى ${lastIndex}، بالترتيب. ملاحظات المستخدم على الصور (إن وجدت): ${group.map((photo, index) => photo.note ? `الصورة ${firstIndex + index}: ${photo.note}` : "").filter(Boolean).join(" | ") || "لا توجد ملاحظات نصية"}. لكل عيب مرئي اذكر رقم الصورة، رقم الغرفة أو المكان/العنصر إذا ظهر بالصورة أو كتبه المستخدم، وصف الدليل المرئي، درجة الخطورة (منخفضة/متوسطة/عالية)، والتوصية. ميّز بين العيب المؤكد والاحتمال، ولا تخترع أبعادًا أو تفاصيل غير ظاهرة. إذا لم يظهر عيب في صورة فاذكر ذلك. أجب بالعربية وبنقاط منظمة.`,
        });
        findings.push(`نتائج الصور ${firstIndex}-${lastIndex}:\n${analysis.text}`);

        const completed = Math.floor(offset / groupSize) + 1;
        if (progressMessage && (completed === groupCount || completed % 2 === 0)) {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            progressMessage.message_id,
            `⏳ تحليل الصور: ${completed}/${groupCount} مجموعات اكتملت.`
          ).catch(() => {});
        }
      }

      const outputLabel = format === "word" ? "Word" : format === "excel" ? "Excel" : "PDF";
      const templateContext = batch.templateText
        ? `\n\nاتبع بنية الملف النموذجي (${batch.templateFileName || "ملف مرفق"}) من حيث ترتيب الأقسام والعناوين وأسماء الأعمدة فقط. لا تنقل أي أسماء أو أرقام أو نتائج من محتوى النموذج.\nبنية النموذج المستخرجة:\n${batch.templateText}`
        : "";
      const reportPrompt = `أنشئ تقرير معاينة احترافي بصيغة ${outputLabel} اعتمادًا على نتائج فحص ${batch.photos.length} صورة مرفقة أدناه. اجعل كل ملاحظة مرتبطة برقم الصورة، واجمع العيوب المتشابهة دون تكرار، ورتبها حسب الخطورة. أضف ملخصًا تنفيذيًا، وجدولًا منظمًا للعيوب، والتوصيات، وحدود المعاينة. لا تضف عيوبًا أو قياسات أو بيانات غير موجودة في نتائج التحليل.\n\nنتائج التحليل:\n${findings.join("\n\n")}${templateContext}`;
      const generated = await agentOrchestrator.execute({
        prompt: reportPrompt,
        language: session.language,
        explicitSkill: formatSkills[format],
        history: session.history.slice(-8),
        memoryContext: session.memorySummary,
      });

      if (format === "word" && generated.generatedFile?.fileType === "docx") {
        const docxBuffer = await DocxGenerator.generate({
          ...(generated.generatedFile.structuredSpec || {}),
          isRtl: session.language === "ar",
          inspectionPhotos: batch.photos.map((photo, index) => ({
            photoNumber: index + 1,
            caption: `صورة ${index + 1}`,
            imageBase64: photo.buffer.toString("base64"),
            mimeType: photo.mimeType,
          })),
        });
        const validation = await FileValidator.validateDocx(docxBuffer);
        if (!validation.valid) throw new Error(validation.error || "فشل التحقق من تقرير Word");
        const stored = TempFileStorage.saveGeneratedFile(docxBuffer, generated.generatedFile.fileName);
        generated.generatedFile.fileName = stored.fileName;
        generated.generatedFile.filePath = stored.filePath;
        generated.generatedFile.savedFilePath = stored.filePath;
        generated.generatedFile.base64Data = docxBuffer.toString("base64");
      }

      if (progressMessage) {
        await ctx.api.editMessageText(ctx.chat!.id, progressMessage.message_id, "✅ اكتمل تحليل الصور وتجهيز التقرير.").catch(() => {});
      }
      if (generated.replyText) await this.replyWithRetry(ctx, generated.replyText.slice(0, 3500));
      if (generated.generatedFile) {
        const buffer = Buffer.from(generated.generatedFile.base64Data, "base64");
        await this.replyDocumentWithRetry(
          ctx,
          new InputFile(buffer, generated.generatedFile.fileName),
          { caption: `📄 تقرير معاينة ${batch.photos.length} صورة — ${generated.generatedFile.fileName}`.slice(0, 950) }
        );
      }

      session.history.push(
        { role: "user", content: `تحليل دفعة صور (${batch.photos.length}) وإنشاء تقرير ${outputLabel}${batch.templateFileName ? ` على نمط ${batch.templateFileName}` : ""}.` },
        { role: "model", content: generated.replyText.slice(0, 3000) }
      );
      session.batchInspection = undefined;
      this.userSessions.set(uid, session);
      await telegramSessionStore.save(uid, session).catch(() => {});
      this.recordActivity({
        fromUser: ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || "Telegram User",
        userInput: `Batch inspection: ${batch.photos.length} photos (${format})`,
        skillUsed: `ImageSkill + ${formatSkills[format]}`,
        replyPreview: generated.replyText.slice(0, 140),
        generatedFileName: generated.generatedFile?.fileName,
      });
    } catch (err: any) {
      batch.processing = false;
      logger.error("Telegram batch photo inspection failed", {
        error: err?.message || String(err),
        photoCount: batch.photos.length,
      });
      await this.replyWithRetry(
        ctx,
        "تعذر إكمال تقرير الصور الآن. الصور ما زالت محفوظة مؤقتًا؛ جرّب /finish بنفس الصيغة مرة أخرى بعد قليل، أو /cancelbatch لإلغائها."
      );
    }
  }

  private registerHandlers(bot: Bot) {
    // Polling safety net: ensure update_id deduplication even in polling mode
    bot.use(async (ctx, next) => {
      if (this.status.mode === "polling" && ctx.update?.update_id) {
        const { updateId, messageKey } = this.extractDeduplicationKeys(ctx.update);
        const res = await this.deduplicator.tryAcquire(updateId, messageKey);
        if (res !== "acquired") {
          logger.info("Skipped duplicate update in polling middleware", { updateId });
          return;
        }
        try {
          await next();
          this.deduplicator.markDone(updateId, messageKey);
        } catch (err) {
          this.deduplicator.markFailed(updateId, messageKey, false);
          throw err;
        }
        return;
      }
      await next();
    });

    // Hydrate and persist Telegram user context so restarts and horizontal workers don't erase it.
    bot.use(async (ctx, next) => {
      const uid = ctx.from?.id;
      if (!uid) return next();

      if (!this.userSessions.has(uid)) {
        try {
          const saved = await telegramSessionStore.load(uid);
          if (saved) {
            this.userSessions.set(uid, {
              ...saved,
              memorySummary: saved.memorySummary || "",
              memoryTopics: saved.memoryTopics || [],
              referenceTemplate: saved.referenceTemplate,
            });
          }
        } catch (err: any) {
          logger.warn("Telegram session restore failed; continuing with an in-memory session", {
            userId: uid,
            error: err?.message || String(err),
          });
        }
      }

      try {
        await next();
      } finally {
        const session = this.userSessions.get(uid);
        try {
          if (session) await telegramSessionStore.save(uid, session);
          else await telegramSessionStore.delete(uid);
        } catch (err: any) {
          logger.warn("Telegram session persistence failed", {
            userId: uid,
            error: err?.message || String(err),
          });
        }
      }
    });

    // 1. /start command
    bot.command("start", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      session.activeSkill = undefined;
      this.userSessions.set(uid, session);

      await this.replyWithRetry(
        ctx,
        "مرحباً بك! أنا **مستر هاني (Mr. Hany)**، مساعدك الذكي المتطور والمهندس الاستشاري.\n\nاختر إحدى المهارات من القائمة التفاعلية أدناه، أو أرسل رسالتك أو ملفك (PDF, Word, Excel, صورة مخطط، أو رسالة صوتية) مباشرة:",
        {
          reply_markup: this.getMainMenuKeyboard(session.language),
        }
      );
    });

    // 2. /help command
    bot.command("help", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      await this.replyWithRetry(
        ctx,
        "📋 دليل أوامر ومهارات مستر هاني (Mr. Hany):\n\n" +
          "/start - القائمة التفاعلية الرئيسية\n" +
          "/chat - المحادثة الذكية وحل المشكلات\n" +
          "/document - قراءة وتحليل ملفات PDF, DOCX, XLSX, CSV, TXT\n" +
          "/image - تحليل الصور والمخططات الهندسية\n" +
          "/voice - المساعد الصوتي وتفريغ الصوت\n" +
          "/word - توليد مستندات Word (DOCX)\n" +
          "/excel - توليد جداول Excel (XLSX)\n" +
          "/pdf - توليد تقارير PDF رسمية\n" +
          "/ppt - توليد عروض PowerPoint (PPTX)\n" +
          "/batch - تجميع حتى 300 صورة للمعاينة\n" +
          "/finish word|excel|pdf - إنشاء تقرير من الصور\n" +
          "/cancelbatch - إلغاء دفعة الصور\n" +
          "/saveref - حفظ ملف كنموذج مرجعي\n" +
          "/refs - عرض النموذج المرجعي\n" +
          "/forgetref - حذف النموذج الشخصي\n" +
          "/memory - عرض الذاكرة طويلة الأمد\n" +
          "/history - عرض سجل المحادثات\n" +
          "/settings - إعدادات اللغة والنموذج\n" +
          "/clear - مسح سياق المحادثة الحالي",
        { reply_markup: this.getMainMenuKeyboard(session.language) }
      );
    });

    // 3. /clear command
    bot.command("clear", async (ctx) => {
      if (ctx.from) {
        this.userSessions.delete(ctx.from.id);
      }
      await this.replyWithRetry(
        ctx,
        "✅ تم مسح سجل المحادثة والذاكرة طويلة الأمد. كيف يمكنني مساعدتك الآن؟"
      );
    });

    // 4. /history command
    bot.command("history", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.userSessions.get(uid);
      if (!session || session.history.length === 0) {
        await this.replyWithRetry(ctx, "📜 لا توجد رسائل سابقة مسجلة في هذه الجلسة.");
        return;
      }
      const formatted = session.history
        .slice(-8)
        .map((m) => `${m.role === "user" ? "👤 أنت" : "🤖 مستر هاني"}: ${m.content.slice(0, 120)}`)
        .join("\n\n");
      await this.replyWithRetry(ctx, `📜 آخر المحادثات المسجلة:\n\n${formatted}`);
    });

    bot.command("memory", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      if (!telegramSessionStore.isConfigured()) {
        await this.replyWithRetry(
          ctx,
          "🧠 الذاكرة طويلة الأمد غير مفعّلة بعد؛ يلزم ربط بيانات اعتماد Firestore الآمنة في إعدادات الاستضافة."
        );
        return;
      }
      const summary = session.memorySummary.trim();
      const topics = session.memoryTopics.length ? `\n\nالمواضيع: ${session.memoryTopics.join("، ")}` : "";
      await this.replyWithRetry(
        ctx,
        summary
          ? `🧠 دي خلاصة المعلومات والمواضيع اللي محتفظ بيها عشان أفتكرها في المحادثات القادمة:\n\n${summary}${topics}\n\nلمسحها استخدم /clear.`
          : "🧠 لسه مفيش ملخص طويل الأمد. هحفظ تفضيلاتك ومشاريعك ومواضيع المتابعة المهمة تلقائيًا مع استمرار المحادثة. استخدم /clear لمسح الذاكرة."
      );
    });

    bot.command("batch", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      session.batchInspection = {
        photos: [],
        totalBytes: 0,
        templateText: session.referenceTemplate?.blueprint || DEFAULT_ROOM_DEFECTS_REFERENCE,
        templateFileName: session.referenceTemplate?.fileName || "نموذج تقرير ملاحظات الغرف",
      };
      this.userSessions.set(uid, session);
      await this.replyWithRetry(
        ctx,
        `📸 بدأ تجميع صور المعاينة. ابعت لحد ${MAX_BATCH_PHOTOS} صورة، صورة واحدة أو ألبومات. هضغط الصور تلقائيًا. لو عايز نموذج مختلف، ارفع ملف Word أو Excel أو PDF أثناء التجميع. لما تخلص اكتب /finish word أو /finish excel أو /finish pdf. الحد 45 ميجابايت بعد الضغط؛ للإلغاء استخدم /cancelbatch.`
      );
    });

    bot.command("saveref", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      session.awaitingReference = true;
      this.userSessions.set(uid, session);
      await this.replyWithRetry(
        ctx,
        "📄 ابعت دلوقتي ملف Word أو Excel أو PDF أو CSV أو TXT اللي عايزني أحفظ بنيته كمرجع. هحفظ شكل العناوين والجداول فقط، مش ملف الصور نفسه."
      );
    });

    bot.command("refs", async (ctx) => {
      const session = this.getSession(ctx.from?.id || 0);
      const saved = session.referenceTemplate;
      await this.replyWithRetry(
        ctx,
        saved
          ? `📚 النموذج المرجعي المحفوظ: ${saved.fileName}\nاستخدم /batch لعمل تقرير جديد على نفس بنيته، أو /saveref لاستبداله، أو /forgetref لحذفه.`
          : `📚 مفيش نموذج شخصي محفوظ. قالب تقارير ملاحظات الغرف المرفق مفعّل افتراضيًا. استخدم /saveref لحفظ نموذج آخر.`
      );
    });

    bot.command("forgetref", async (ctx) => {
      const session = this.getSession(ctx.from?.id || 0);
      session.referenceTemplate = undefined;
      this.userSessions.set(ctx.from?.id || 0, session);
      await this.replyWithRetry(ctx, "تم حذف النموذج الشخصي المحفوظ. قالب تقارير الغرف الافتراضي ما زال متاحًا.");
    });

    bot.command("finish", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.userSessions.get(uid);
      const batch = session?.batchInspection;
      if (!session || !batch) {
        await this.replyWithRetry(ctx, "مفيش تجميع صور شغال. ابدأ بـ /batch الأول.");
        return;
      }
      const formatText = String(ctx.match || "").trim().toLowerCase();
      const formatAliases: Record<string, InspectionOutputFormat> = {
        word: "word", docx: "word", وورد: "word",
        excel: "excel", xlsx: "excel", إكسل: "excel", اكسل: "excel",
        pdf: "pdf", "بي دي اف": "pdf",
      };
      const format = formatAliases[formatText];
      if (!format) {
        await this.replyWithRetry(ctx, "اختار نوع الملف في الأمر: /finish word أو /finish excel أو /finish pdf");
        return;
      }
      await this.processInspectionBatch(ctx, uid, session, format);
    });

    bot.command("cancelbatch", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.userSessions.get(uid);
      if (!session?.batchInspection) {
        await this.replyWithRetry(ctx, "مفيش تجميع صور شغال دلوقتي.");
        return;
      }
      if (session.batchInspection.processing) {
        await this.replyWithRetry(ctx, "التحليل بدأ بالفعل؛ استنى ما يخلص قبل بدء دفعة جديدة.");
        return;
      }
      session.batchInspection = undefined;
      this.userSessions.set(uid, session);
      await this.replyWithRetry(ctx, "تم إلغاء التجميع ومسح الصور المؤقتة من الجلسة.");
    });

    // 5. /settings command
    bot.command("settings", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      const settingsKb = new InlineKeyboard()
        .text("العربية (Default) 🇪🇬🇸🇦", "lang_ar")
        .text("English 🌐", "lang_en")
        .row()
        .text("مسح الذاكرة / Clear Memory 🗑️", "cmd_clear");
      await this.replyWithRetry(
        ctx,
        `⚙️ إعدادات مستر هاني:\n• اللغة الحالية: ${session.language === "ar" ? "العربية" : "English"}\n• يمكنك تغيير اللغة أو مسح سياق المحادثة من هنا.`,
        { reply_markup: settingsKb }
      );
    });

    // 6. Mode-switching commands (/chat, /document, /image, /voice)
    bot.command("chat", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      session.activeSkill = "ChatSkill";
      this.userSessions.set(uid, session);
      await this.replyWithRetry(ctx, "💬 وضع المحادثة الذكية نشط. تفضل بطرح سؤالك أو موضوع البحث:");
    });

    bot.command("document", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      session.activeSkill = "DocumentSkill";
      this.userSessions.set(uid, session);
      await this.replyWithRetry(
        ctx,
        "📄 يرجى إرسال المستند (PDF, DOCX, XLSX, CSV, TXT) الآن لتحليله:"
      );
    });

    bot.command("image", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      session.activeSkill = "ImageSkill";
      this.userSessions.set(uid, session);
      await this.replyWithRetry(
        ctx,
        "🖼️ يرجى إرسال الصورة أو المخطط الهندسي لتحليله بواسطة المساعد الذكي:"
      );
    });

    bot.command("voice", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      session.activeSkill = "VoiceSkill";
      this.userSessions.set(uid, session);
      await this.replyWithRetry(
        ctx,
        "🎙️ أرسل رسالتك الصوتية الآن بالعربية (الفصحى أو المصرية أو الخليجية) أو الإنجليزية:"
      );
    });

    // 7. File Generation commands (/word, /excel, /pdf, /ppt)
    const registerGeneratorCmd = (cmdName: string, skillName: string, promptHint: string) => {
      bot.command(cmdName, async (ctx) => {
        const uid = ctx.from?.id || 0;
        const session = this.getSession(uid);
        const inlineArg = (ctx.match || "").trim();

        if (!inlineArg) {
          session.activeSkill = skillName;
          this.userSessions.set(uid, session);
          await this.replyWithRetry(ctx, promptHint);
          return;
        }

        await this.replyWithRetry(ctx, "جاري إعداد وتوليد الملف الاحترافي بواسطة مستر هاني... ⏳");
        await ctx.replyWithChatAction("upload_document").catch(() => {});
        try {
          const res = await agentOrchestrator.execute({
            prompt: inlineArg,
            language: session.language,
            explicitSkill: skillName,
            history: session.history.slice(-6),
          });
          if (res.replyText) {
            await this.replyWithRetry(ctx, res.replyText.slice(0, 4000));
          }
          if (res.generatedFile) {
            const buf = Buffer.from(res.generatedFile.base64Data, "base64");
            await this.replyDocumentWithRetry(
              ctx,
              new InputFile(buf, res.generatedFile.fileName)
            );
          }
          this.recordActivity({
            fromUser: ctx.from?.username
              ? `@${ctx.from.username}`
              : ctx.from?.first_name || "Telegram User",
            userInput: `/${cmdName} ${inlineArg}`,
            skillUsed: res.skillUsed,
            replyPreview: res.replyText.slice(0, 120),
            generatedFileName: res.generatedFile?.fileName,
          });
        } catch (err: any) {
          logger.error(`Telegram /${cmdName} command failed`, {
            error: err?.message,
            chatId: ctx.chat?.id,
          });
          await this.replyWithRetry(ctx, "عذرًا، تعذّر إنشاء الملف حاليًا. حاول مرة أخرى بعد قليل.");
        }
      });
    };

    registerGeneratorCmd(
      "word",
      "WordSkill",
      "📝 اكتب عنوان وموضوع التقرير المطلوب لتوليد ملف Word (DOCX):"
    );
    registerGeneratorCmd(
      "excel",
      "ExcelSkill",
      "📊 صف جدول البيانات والمعادلات المطلوبة لتوليد ملف Excel (XLSX):"
    );
    registerGeneratorCmd(
      "pdf",
      "PdfSkill",
      "📑 اكتب عنوان ومحتوى التقرير لتوليد ملف PDF رسمي:"
    );
    registerGeneratorCmd(
      "ppt",
      "PowerPointSkill",
      "📽️ اكتب موضوع العرض التقديمي لتوليد ملف PowerPoint (PPTX):"
    );

    // 8. Interactive Inline Menu Callbacks (13 Buttons)
    bot.on("callback_query:data", async (ctx) => {
      const data = ctx.callbackQuery.data;
      const uid = ctx.from.id;
      const session = this.getSession(uid);
      await withRetry(() => ctx.answerCallbackQuery(), {
        label: "telegram:answerCallbackQuery",
        maxAttempts: 2,
      }).catch(() => {});

      if (data === "lang_ar" || data === "lang_en") {
        session.language = data === "lang_en" ? "en" : "ar";
        this.userSessions.set(uid, session);
        await this.replyWithRetry(
          ctx,
          session.language === "ar"
            ? "✅ تم ضبط لغة مستر هاني إلى العربية."
            : "✅ Mr. Hany language set to English.",
          { reply_markup: this.getMainMenuKeyboard(session.language) }
        );
        return;
      }

      if (data === "cmd_clear") {
        this.userSessions.delete(uid);
        await this.replyWithRetry(ctx, "✅ تم مسح الذاكرة وسجل المحادثة بنجاح.");
        return;
      }

      const skillPrompts: Record<string, { skill: string; msg: string }> = {
        menu_chat: {
          skill: "ChatSkill",
          msg: "💬 تم تفعيل المحادثة الذكية. تفضل بطرح سؤالك:",
        },
        menu_doc: {
          skill: "DocumentSkill",
          msg: "📄 أرسل الآن ملف PDF أو Word أو Excel أو CSV أو TXT لتحليله:",
        },
        menu_img: {
          skill: "ImageSkill",
          msg: "🖼️ أرسل الصورة أو لقطة الشاشة أو المخطط لتحليله بدقة:",
        },
        menu_voice: {
          skill: "VoiceSkill",
          msg: "🎙️ أرسل رسالة صوتية الآن بالعربية أو الإنجليزية:",
        },
        menu_word: {
          skill: "WordSkill",
          msg: "📝 اكتب موضوع التقرير المطلوب لتوليد ملف Word (DOCX):",
        },
        menu_excel: {
          skill: "ExcelSkill",
          msg: "📊 صف البيانات أو الجدول المطلوب لتوليد ملف Excel (XLSX):",
        },
        menu_pdf: {
          skill: "PdfSkill",
          msg: "📑 اكتب عنوان ومحتوى التقرير لتوليد ملف PDF رسمي:",
        },
        menu_ppt: {
          skill: "PowerPointSkill",
          msg: "📽️ اكتب موضوع العرض التقديمي لتوليد ملف PowerPoint (PPTX):",
        },
        menu_data: {
          skill: "DataAnalysisSkill",
          msg: "📈 أرسل البيانات أو ملف الجدول لتحليلها إحصائياً:",
        },
        menu_eng: {
          skill: "EngineeringSkill",
          msg: "📐 أرسل المخطط الهندسي (صورة أو PDF) أو أبعاد العناصر لحساب كميات الخرسانة والحديد وإصدار مقايسة BOQ كملف Excel:",
        },
      };

      if (skillPrompts[data]) {
        session.activeSkill = skillPrompts[data].skill;
        this.userSessions.set(uid, session);
        await this.replyWithRetry(ctx, skillPrompts[data].msg);
        return;
      }

      if (data === "menu_history") {
        const lastTurns = session.history
          .slice(-6)
          .map((m) => `${m.role === "user" ? "👤" : "🤖"}: ${m.content.slice(0, 100)}`)
          .join("\n\n");
        await this.replyWithRetry(ctx, lastTurns || "📜 لا توجد رسائل سابقة في هذه الجلسة.");
        return;
      }

      if (data === "menu_settings") {
        const settingsKb = new InlineKeyboard()
          .text("العربية 🇪🇬🇸🇦", "lang_ar")
          .text("English 🌐", "lang_en")
          .row()
          .text("مسح المحادثة / Clear 🗑️", "cmd_clear");
        await this.replyWithRetry(ctx, "⚙️ اختر لغة التخاطب أو إدارة الذاكرة:", {
          reply_markup: settingsKb,
        });
        return;
      }

      if (data === "menu_help") {
        await this.replyWithRetry(
          ctx,
          "اختر أي أداة من القائمة التفاعلية أو أرسل ملفاً أو صورة أو رسالة صوتية مباشرة.",
          { reply_markup: this.getMainMenuKeyboard(session.language) }
        );
      }
    });

    // 9. Universal Multimodal Message Handler (Text, Documents, Photos, Voice, Audio, Video)
    bot.on("message", async (ctx) => {
      const uid = ctx.from?.id || 0;
      const session = this.getSession(uid);
      const msg = ctx.message;
      const text = msg.text || msg.caption || "";

      if (this.isCreatorQuestion(text)) {
        await this.replyWithRetry(
          ctx,
          session.language === "en"
            ? "I was created and developed by Engineer Hany. 👷‍♂️"
            : "مهندس هاني هو اللي عملني وطوّرني 👷‍♂️"
        );
        return;
      }

      if (session.awaitingReference) {
        if (!msg.document) {
          await this.replyWithRetry(ctx, "مستني ملف النموذج المرجعي. ارفعه بصيغة Word أو Excel أو PDF أو CSV أو TXT.");
          return;
        }
        const mime = msg.document.mime_type || "application/octet-stream";
        const name = msg.document.file_name || "report-reference";
        if (!/\.(docx|xlsx|pdf|csv|txt|md)$/i.test(name) && !/pdf|wordprocessingml|spreadsheetml|text\/|csv/i.test(mime)) {
          await this.replyWithRetry(ctx, "الصيغة دي مش مدعومة كمرجع. استخدم Word أو Excel أو PDF أو CSV أو TXT.");
          return;
        }
        try {
          await this.saveReferenceTemplate(ctx, session, msg.document.file_id, name, mime);
        } catch (err: any) {
          session.awaitingReference = false;
          await this.replyWithRetry(ctx, err?.message || "تعذر قراءة الملف المرجعي.");
        }
        return;
      }

      const activeBatch = session.batchInspection;
      if (activeBatch?.processing && (msg.photo || msg.document)) {
        await this.replyWithRetry(ctx, "الدفعة قيد التحليل حاليًا؛ استنى ما يخلص التقرير قبل إضافة صور جديدة.");
        return;
      }
      if (activeBatch && !activeBatch.processing && msg.document) {
        const mime = msg.document.mime_type || "application/octet-stream";
        const name = msg.document.file_name || "inspection-template";
        if (mime.startsWith("image/")) {
          try {
            await this.captureInspectionPhoto(ctx, session, msg.document.file_id, name, mime, msg.caption);
          } catch (err: any) {
            await this.replyWithRetry(ctx, err?.message || "تعذر استلام الصورة. حاول إرسالها كصورة من تيليجرام.");
          }
          return;
        }
        if (/\.(docx|xlsx|pdf|csv|txt|md)$/i.test(name) || /pdf|wordprocessingml|spreadsheetml|text\/|csv/i.test(mime)) {
          try {
            await this.captureInspectionTemplate(ctx, session, msg.document.file_id, name, mime);
          } catch (err: any) {
            await this.replyWithRetry(ctx, err?.message || "تعذر قراءة الملف النموذجي. ارفع DOCX أو XLSX أو PDF أو CSV أو TXT.");
          }
          return;
        }
        await this.replyWithRetry(ctx, "ارفع ملف نموذج بصيغة Word أو Excel أو PDF أو CSV أو TXT، أو ابعت صور المعاينة.");
        return;
      }
      if (activeBatch && !activeBatch.processing && msg.photo?.length) {
        const bestPhoto = msg.photo[msg.photo.length - 1];
        try {
          await this.captureInspectionPhoto(
            ctx,
            session,
            bestPhoto.file_id,
            `inspection_${activeBatch.photos.length + 1}.jpg`,
            "image/jpeg",
            msg.caption
          );
        } catch (err: any) {
          await this.replyWithRetry(ctx, err?.message || "تعذر استلام الصورة. حاول مرة أخرى.");
        }
        return;
      }

      let fileBase64: string | undefined;
      let fileMimeType: string | undefined;
      let fileName: string | undefined;

      await this.replyWithRetry(
        ctx,
        session.language === "en"
          ? "Processing with Mr. Hany AI... ⏳"
          : "جاري التحليل والمعالجة بواسطة مستر هاني... ⏳"
      );
      await ctx.replyWithChatAction("typing").catch(() => {});

      try {
        if (msg.document) {
          const buf = await this.downloadTelegramFile(msg.document.file_id);
          fileBase64 = buf.toString("base64");
          fileMimeType = msg.document.mime_type || "application/octet-stream";
          fileName = msg.document.file_name || "document";
        } else if (msg.photo && msg.photo.length > 0) {
          const bestPhoto = msg.photo[msg.photo.length - 1];
          const buf = await this.downloadTelegramFile(bestPhoto.file_id);
          fileBase64 = buf.toString("base64");
          fileMimeType = "image/jpeg";
          fileName = "telegram_photo.jpg";
        } else if (msg.voice || msg.audio) {
          const media = msg.voice || msg.audio!;
          const buf = await this.downloadTelegramFile(media.file_id);
          fileBase64 = buf.toString("base64");
          fileMimeType = msg.voice ? "audio/ogg" : msg.audio?.mime_type || "audio/mp3";
          fileName = "voice_message.ogg";
        } else if (msg.video) {
          const buf = await this.downloadTelegramFile(msg.video.file_id);
          fileBase64 = buf.toString("base64");
          fileMimeType = msg.video.mime_type || "video/mp4";
          fileName = msg.video.file_name || "video.mp4";
        }

        const res = await agentOrchestrator.execute({
          prompt: text,
          language: session.language,
          explicitSkill: session.activeSkill,
          history: session.history.slice(-8),
          memoryContext: session.memorySummary,
          fileBase64,
          fileMimeType,
          fileName,
          synthesizeVoiceReply: Boolean(
            msg.voice || msg.audio || session.activeSkill === "VoiceSkill"
          ),
        });

        session.history.push({ role: "user", content: text || `[${fileName || "Media"}]` });
        session.history.push({ role: "model", content: res.replyText });
        if (session.history.length > 40 && !telegramSessionStore.isConfigured()) {
          session.history = session.history.slice(-40);
        }
        session.activeSkill = res.needsClarification ? res.skillUsed : undefined;
        this.userSessions.set(uid, session);

        if (res.transcript) {
          await this.replyWithRetry(ctx, `🎙️ النص المفرغ صوتياً:\n"${res.transcript}"`);
        }

        if (res.replyText) {
          await this.replyWithRetry(ctx, res.replyText.slice(0, 4000));
        }

        if (res.audioReplyBase64) {
          const audioBuf = Buffer.from(res.audioReplyBase64, "base64");
          await this.replyAudioWithRetry(ctx, new InputFile(audioBuf, "Mr_Hany_Voice_Reply.wav"));
        }

        if (res.generatedFile) {
          const fileBuf = Buffer.from(res.generatedFile.base64Data, "base64");
          const specTitle = res.generatedFile.structuredSpec?.title || res.generatedFile.fileName;
          const shortArCaption = `📄 تم إنشاء والتحقق من الملف المطلوب بنجاح بواسطة مستر هاني:\n• العنوان: ${specTitle}\n• اسم الملف: ${res.generatedFile.fileName}`;
          await this.replyDocumentWithRetry(
            ctx,
            new InputFile(fileBuf, res.generatedFile.fileName),
            {
              caption: shortArCaption.slice(0, 950),
            }
          );
        }

        this.recordActivity({
          fromUser: ctx.from?.username
            ? `@${ctx.from.username}`
            : ctx.from?.first_name || "Telegram User",
          userInput: text || `[${fileName || "Media Attachment"}]`,
          skillUsed: (res.combinedSkills || [res.skillUsed]).join(" + "),
          replyPreview: res.replyText.slice(0, 140),
          generatedFileName: res.generatedFile?.fileName,
        });
        if (session.history.length > 40) {
          void this.compactLongTermMemory(uid, session);
        }
      } catch (err: any) {
        logger.error("Telegram multimodal message processing error", {
          error: err?.message || String(err),
          chatId: ctx.chat?.id,
          updateId: ctx.update?.update_id,
        });
        await this.replyWithRetry(ctx, "عذرًا، تعذّرت معالجة طلبك حاليًا. حاول مرة أخرى بعد قليل.");
      }
    });
  }

  private isCreatorQuestion(text: string): boolean {
    const normalized = text
      .toLowerCase()
      .replace(/[ًٌٍَُِّْـ]/g, "")
      .replace(/[أإآ]/g, "ا")
      .replace(/ى/g, "ي")
      .replace(/[؟?!.,،]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const asksInArabic =
      /(?:مين|من) (?:اللي )?(?:عملك|عاملك|عامل(?:ك| البوت)?|صنعك|انشاك|طورك|برمجك|صممك|مطورك|مصممك|صاحب البوت)/.test(normalized) ||
      /(?:مين|من) (?:اللي )?(?:عمل|صنع|طور|برمج|صمم) (?:البوت|مستر هاني)/.test(normalized) ||
      /(?:مين|من) (?:هو )?(?:مطور|مصمم|صاحب) البوت/.test(normalized);
    const asksInEnglish =
      /\bwho (?:made|built|created|developed|designed) (?:you|the bot|this bot|mr hany)\b/.test(normalized) ||
      /\bwho is (?:your creator|your developer|behind this bot)\b/.test(normalized);

    return asksInArabic || asksInEnglish;
  }
}

export const telegramBotManager = new TelegramBotManager();
