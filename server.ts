import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import http from "http";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";
import { agentOrchestrator } from "./src/agents/orchestrator";
import { telegramBotManager } from "./src/bot/telegram.service";
import { telegramSessionStore } from "./src/bot/telegram-session-store";
import { IntegrationAuditRunner } from "./src/tests/audit-runner";
import { logger } from "./src/utils/logger";

dotenv.config({ override: true });

// Simple in-memory rate limiter per IP (Security requirement #14)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQ = 45;
const aiRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.headers["x-forwarded-for"]?.toString() || "local";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return next();
  }
  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX_REQ) {
    return res.status(429).json({
      error: "تم تجاوز الحد المسموح به للطلبات في الدقيقة. يرجى الانتظار قليلاً والمحاولة مجدداً.",
    });
  }
  return next();
}

function aiRateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.headers["x-forwarded-for"]?.toString() || "local";
  const now = Date.now();
  const entry = aiRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    aiRateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    if (aiRateLimitMap.size > 5000) {
      for (const [key, value] of aiRateLimitMap) if (now > value.resetAt) aiRateLimitMap.delete(key);
    }
    return next();
  }
  entry.count += 1;
  if (entry.count > 10) {
    return res.status(429).json({ error: "تم تجاوز الحد المؤقت لطلبات الذكاء الاصطناعي. حاول بعد دقيقة." });
  }
  return next();
}

const ALLOWED_MIME_PREFIXES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument",
  "application/msword",
  "application/vnd.ms-excel",
  "text/plain",
  "text/csv",
  "application/json",
  "image/",
  "audio/",
  "video/",
  "application/octet-stream",
];

function isAuthorizedAdmin(req: Request): boolean {
  const expectedSecret = (process.env.ADMIN_SECRET || "").trim();
  const suppliedSecret = (req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (expectedSecret.length < 32 || expectedSecret.startsWith("REPLACE_") || !suppliedSecret) return false;
  const expected = Buffer.from(expectedSecret, "utf8");
  const supplied = Buffer.from(suppliedSecret, "utf8");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}

export async function createApp() {
  const app = express();
  app.set("trust proxy", true);

  let isShuttingDown = false;
  const setShuttingDown = (val: boolean) => {
    isShuttingDown = val;
  };

  // Support multimodal payloads up to 35MB
  app.use(express.json({ limit: "35mb" }));
  app.use(express.urlencoded({ extended: true, limit: "35mb" }));

  // Cloud Run Liveness Health Check (always fast 200 OK while process is alive)
  app.get("/healthz", (_req, res) => {
    if (isShuttingDown) {
      return res.status(503).json({ ok: false, status: "draining" });
    }
    return res.status(200).json({
      ok: true,
      status: "alive",
      service: process.env.K_SERVICE || "mr-hany-bot",
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // Cloud Run Readiness Check
  app.get("/readyz", (_req, res) => {
    const tgStatus = telegramBotManager.getStatus();
    const geminiConfigured = Boolean(
      process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"
    );
    const telegramConfigured = Boolean(
      process.env.TELEGRAM_BOT_TOKEN &&
        process.env.TELEGRAM_BOT_TOKEN !== "YOUR_TELEGRAM_BOT_TOKEN"
    );

    if (isShuttingDown) {
      return res.status(503).json({ ok: false, status: "shutting_down" });
    }

    return res.status(200).json({
      ok: true,
      status: "ready",
      geminiConfigured,
      telegramConfigured,
      telegramMode: tgStatus.mode,
      telegramConnected: tgStatus.connected,
      webhookSecretConfigured: tgStatus.webhookSecretConfigured,
      inFlightJobs: tgStatus.inFlightJobs,
    });
  });

  // Official Telegram HTTPS Webhook Receiver (Cloud Run & Production)
  app.post(["/telegram/webhook", "/api/telegram/webhook"], async (req, res) => {
    if (isShuttingDown) {
      return res.status(503).json({ ok: false, error: "Server draining" });
    }

    if (!telegramBotManager.isWebhookSecretConfigured()) {
      logger.error("Rejected Telegram webhook request: TELEGRAM_WEBHOOK_SECRET is not configured");
      return res.status(503).json({
        ok: false,
        error: "Webhook secret token is not configured on server.",
      });
    }

    const secretHeader = req.header("x-telegram-bot-api-secret-token");
    if (!telegramBotManager.verifyWebhookSecret(secretHeader)) {
      logger.warn("Unauthorized Telegram webhook call rejected (invalid secret token)", {
        ip: req.ip,
        hasHeader: Boolean(secretHeader),
      });
      return res.status(401).json({ ok: false, error: "Unauthorized webhook signature" });
    }

    const update = req.body;
    if (!update || typeof update.update_id !== "number") {
      return res.status(400).json({ ok: false, error: "Invalid Telegram update payload" });
    }

    try {
      const result = await telegramBotManager.handleWebhookUpdate(update);
      if (!result.accepted) {
        return res.status(503).json({ ok: false, error: result.reason });
      }
      return res.status(200).json({
        ok: true,
        status: result.status,
        duplicate: Boolean(result.duplicate),
      });
    } catch (err: any) {
      logger.error("Webhook endpoint error", { error: err?.message });
      return res.status(500).json({ ok: false, error: "Internal webhook error" });
    }
  });

  // Webhook Inspection & Registration Routes
  app.get("/api/telegram/webhook/info", async (req, res) => {
    if (!isAuthorizedAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized Admin Action" });
    }
    try {
      const info = await telegramBotManager.getWebhookInfo();
      return res.json({
        ...info,
        targetMode: telegramBotManager.resolveTargetMode(),
        secretConfigured: telegramBotManager.isWebhookSecretConfigured(),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Failed to fetch webhook info" });
    }
  });

  app.post("/api/telegram/webhook/register", rateLimitMiddleware, async (req, res) => {
    if (!isAuthorizedAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const { url, secretToken } = req.body || {};
      const targetUrl = (url || process.env.TELEGRAM_WEBHOOK_URL || "").trim();
      if (!targetUrl || !targetUrl.startsWith("https://")) {
        return res.status(400).json({
          error: "A valid HTTPS URL (https://...) is required to register a Telegram webhook.",
        });
      }
      const info = await telegramBotManager.setWebhook(targetUrl, secretToken);
      return res.json({ ok: true, webhook: info, status: telegramBotManager.getStatus() });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || "Webhook registration failed" });
    }
  });

  // Serve PWA Manifest & Service Worker with strict WebAPK-compliant headers
  const publicDir = path.join(process.cwd(), "public");
  app.get(["/manifest.webmanifest", "/manifest.json"], (_req, res) => {
    res.setHeader("Content-Type", "application/manifest+json; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(publicDir, "manifest.webmanifest"));
  });

  app.get("/sw.js", (_req, res) => {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Service-Worker-Allowed", "/");
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(publicDir, "sw.js"));
  });

  app.use(express.static(publicDir));

  // 1. Health & Platform Config Route
  app.get("/api/status", (_req, res) => {
    const telegram = telegramBotManager.getStatus();
    res.json({
      botName: "Mr. Hany – Advanced AI Assistant",
      // Public bootstrap status only. User identities and message previews are admin-only data.
      telegram: {
        connected: telegram.connected,
        botUsername: telegram.botUsername,
        botFirstName: telegram.botFirstName,
        botLink: telegram.botLink,
        mode: telegram.mode,
        executionMode: telegram.executionMode,
        webhookSecretConfigured: telegram.webhookSecretConfigured,
      },
      skills: agentOrchestrator.skillsRegistry,
      runtime: {
        nodeEnv: process.env.NODE_ENV || "development",
        cloudRunService: process.env.K_SERVICE || null,
        port: Number(process.env.PORT) || 3000,
      },
      securityConfig: {
        geminiConfigured: Boolean(
          process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "MY_GEMINI_API_KEY"
        ),
        telegramConfigured: Boolean(
          process.env.TELEGRAM_BOT_TOKEN &&
            process.env.TELEGRAM_BOT_TOKEN !== "YOUR_TELEGRAM_BOT_TOKEN"
        ),
        webhookSecretConfigured: telegramBotManager.isWebhookSecretConfigured(),
        databaseConfigured: telegramSessionStore.isConfigured(),
        telegramSessionPersistenceConfigured: telegramSessionStore.isConfigured(),
        adminSecretConfigured: Boolean(process.env.ADMIN_SECRET),
      },
      modelsAvailable: [
        { id: "gemini-4-argon", label: "Gemini 4 Argon (Complex & Vision/Video/Engineering)" },
        { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (General & Maps Grounding)" },
        { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (Ultra-Fast)" },
        { id: "gemini-3.5-transcribe", label: "Gemini 3.5 Transcribe (Speech-to-Text)" },
        { id: "gemini-3.8-flash-lite-tts", label: "Gemini 3.8 Flash Lite TTS (Voice Output)" },
      ],
    });
  });

  app.get("/api/admin/telegram/status", (req, res) => {
    if (!isAuthorizedAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized Admin Action" });
    }
    return res.json({ telegram: telegramBotManager.getStatus() });
  });

  // 2. Primary Modular AI Agent Execution Endpoint
  app.post("/api/agent/execute", rateLimitMiddleware, aiRateLimitMiddleware, async (req, res) => {
    try {
      const { prompt, fileBase64, fileMimeType } = req.body || {};

      if (!prompt && !fileBase64) {
        return res.status(400).json({
          error: "يرجى إدخال نص الرسالة أو إرفاق ملف للمعالجة.",
        });
      }

      if (fileMimeType) {
        const lowerMime = String(fileMimeType).toLowerCase();
        const isAllowed = ALLOWED_MIME_PREFIXES.some((prefix) => lowerMime.startsWith(prefix));
        if (!isAllowed) {
          return res.status(400).json({
            error: `صيغة الملف غير مدعومة لأسباب أمنية (${fileMimeType}).`,
          });
        }
      }

      if (fileBase64 && String(fileBase64).length > 34 * 1024 * 1024) {
        return res.status(413).json({
          error: "حجم الملف المرفق يتجاوز الحد الأقصى المسموح به (25MB).",
        });
      }

      const result = await agentOrchestrator.execute(req.body);
      return res.json(result);
    } catch (error: any) {
      logger.error("Agent execution error", { error: error?.message || String(error) });
      return res.status(500).json({
        error: "تعذّر إكمال الطلب حاليًا. حاول مرة أخرى بعد قليل.",
      });
    }
  });

  // 3. Toggle Skill Enablement in Registry (Admin Protected)
  app.post("/api/admin/skills/toggle", (req, res) => {
    const { skillId, enabled } = req.body;

    if (!isAuthorizedAdmin(req)) {
      return res
        .status(401)
        .json({ error: "غير مصرح بتعديل إعدادات النظام (Unauthorized Admin Action)." });
    }

    const skill = agentOrchestrator.skillsRegistry.find((s) => s.id === skillId);
    if (!skill) {
      return res.status(404).json({ error: "Skill not found" });
    }
    skill.enabled = Boolean(enabled);
    return res.json({ skills: agentOrchestrator.skillsRegistry });
  });

  // 4. Connect or Reinitialize Live Telegram Bot Token
  app.post("/api/telegram/connect", rateLimitMiddleware, async (req, res) => {
    if (!isAuthorizedAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized Admin Action" });
    }
    try {
      const { token } = req.body;
      const status = await telegramBotManager.initialize(token);
      res.json({ status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 5. Run Full Functional & Integration Audit Suite
  app.post("/api/audit/run", rateLimitMiddleware, async (req, res) => {
    if (!isAuthorizedAdmin(req)) {
      return res.status(401).json({ error: "Unauthorized Admin Action" });
    }
    try {
      const report = await IntegrationAuditRunner.runAll();
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Audit execution failed" });
    }
  });

  // Vite middleware for development, static dist for production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, ws: false, watch: null },
      appType: "spa",
    });

    // Prevent Vite 8 @vite/client from opening a failing WebSocket when HMR is disabled
    app.get("/@vite/client", async (_req, res, next) => {
      try {
        const result = await vite.transformRequest("/@vite/client");
        if (result?.code) {
          const patched = result.code.replace(
            "transport.connect(createHMRHandler(handleMessage));",
            "/* HMR disabled: WebSocket transport.connect skipped */"
          );
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          return res.send(patched);
        }
      } catch {
        // Fallback to standard Vite middleware
      }
      return next();
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*all", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  return { app, setShuttingDown };
}

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  const { app, setShuttingDown } = await createApp();

  // Initialize Telegram Bot (Webhook mode in Cloud Run/Production, Polling in local preview)
  telegramBotManager.initialize().catch((err) => {
    logger.warn("Telegram initialization notice", { error: err?.message });
  });

  const server: http.Server = app.listen(PORT, "0.0.0.0", () => {
    logger.info("Mr. Hany AI Platform HTTP Server listening", {
      port: PORT,
      mode: telegramBotManager.resolveTargetMode(),
      nodeEnv: process.env.NODE_ENV || "development",
    });
  });

  // Graceful Cloud Run SIGTERM/SIGINT Shutdown (drains background tasks cleanly)
  const gracefulShutdown = async (signal: string) => {
    logger.info(`Received ${signal}; starting graceful shutdown`);
    setShuttingDown(true);

    // Force-exit safety net after 28s (Cloud Run gives 10s-30s on SIGTERM)
    const hardTimeout = setTimeout(() => {
      logger.warn("Graceful shutdown reached timeout; forcing exit");
      process.exit(0);
    }, 28000);
    hardTimeout.unref();

    server.close(async () => {
      await telegramBotManager.drain(24000);
      clearTimeout(hardTimeout);
      logger.info("HTTP server closed cleanly");
      process.exit(0);
    });

    // Ensure background Telegram tasks also drain even if keep-alive HTTP connections linger
    await telegramBotManager.drain(24000);
  };

  process.once("SIGTERM", () => void gracefulShutdown("SIGTERM"));
  process.once("SIGINT", () => void gracefulShutdown("SIGINT"));
}

// Start HTTP server unless imported purely for unit testing with SKIP_SERVER_START=1
if (process.env.SKIP_SERVER_START !== "1") {
  startServer().catch((err) => {
    logger.error("Fatal server startup failure", { error: err?.message || String(err) });
    process.exit(1);
  });
}
