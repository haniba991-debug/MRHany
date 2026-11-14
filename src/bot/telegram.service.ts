import crypto from "crypto";
import { Bot, Context, InlineKeyboard, InputFile } from "grammy";
import { agentOrchestrator } from "../agents/orchestrator";
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
  updatedAt: number;
}

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

  public getExecutionMode(): "async" | "sync" {
    return process.env.WEBHOOK_EXECUTION_MODE === "sync" ? "sync" : "async";
  }

  public isWebhookSecretConfigured(): boolean {
    const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
    return Boolean(secret && secret.length >= 8 && !secret.startsWith("YOUR_"));
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
      webhookUrl: process.env.TELEGRAM_WEBHOOK_URL || this.status.webhookUrl,
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

      // Register official 13 commands cleanly (rate-limit resilient)
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
        const webhookUrl = (process.env.TELEGRAM_WEBHOOK_URL || "").trim();
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
          if (saved) this.userSessions.set(uid, saved);
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
        "✅ تم مسح سجل المحادثة والسياق الحالي بنجاح. كيف يمكنني مساعدتك الآن؟"
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
        `⚙️ إعدادات مستر هاني:\n• اللغة الحالية: ${session.language === "ar" ? "العربية" : "English"}\n• النماذج النشطة: Gemini 4 Argon + Gemini 3.8 Flash + Gemini 3.5 Transcribe`,
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
        "🖼️ يرجى إرسال الصورة أو المخطط الهندسي لتحليله بواسطة Gemini 4 Argon:"
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
          await this.replyWithRetry(ctx, `عذراً، حدث خطأ أثناء توليد الملف: ${err.message}`);
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
          fileBase64,
          fileMimeType,
          fileName,
          synthesizeVoiceReply: Boolean(
            msg.voice || msg.audio || session.activeSkill === "VoiceSkill"
          ),
        });

        session.history.push({ role: "user", content: text || `[${fileName || "Media"}]` });
        session.history.push({ role: "model", content: res.replyText });
        if (session.history.length > 30) {
          session.history = session.history.slice(-24);
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
      } catch (err: any) {
        logger.error("Telegram multimodal message processing error", {
          error: err?.message || String(err),
          chatId: ctx.chat?.id,
          updateId: ctx.update?.update_id,
        });
        await this.replyWithRetry(ctx, `عذراً، حدث خطأ أثناء المعالجة: ${err.message}`);
      }
    });
  }
}

export const telegramBotManager = new TelegramBotManager();
