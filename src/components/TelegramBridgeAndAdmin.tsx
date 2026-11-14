import React, { useState } from "react";
import {
  Bot,
  CheckCircle2,
  Terminal,
  Shield,
  Sliders,
  Users,
  Cpu,
  ExternalLink,
  RefreshCw,
  MessageSquare,
} from "lucide-react";
import { Language } from "../utils/i18n";
import { TelegramBotStatus } from "../bot/telegram.service";

interface SkillMeta {
  id: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  defaultModel: string;
  enabled: boolean;
}

interface TelegramBridgeProps {
  language: Language;
  telegramStatus: TelegramBotStatus;
  onConnectToken: (token: string) => Promise<void>;
  onRefreshStatus: () => Promise<void>;
  onTriggerCommand: (cmd: string) => void;
}

export const TelegramBridgePanel: React.FC<TelegramBridgeProps> = ({
  language,
  telegramStatus,
  onConnectToken,
  onRefreshStatus,
  onTriggerCommand,
}) => {
  const isAr = language === "ar";
  const [tokenInput, setTokenInput] = useState("");
  const [connecting, setConnecting] = useState(false);

  const commands = [
    { cmd: "/start", descAr: "بدء المساعد وعرض القائمة التفاعلية", descEn: "Start assistant & show interactive menu" },
    { cmd: "/help", descAr: "عرض جميع المزايا والأوامر", descEn: "Show available features & guide" },
    { cmd: "/chat", descAr: "بدء محادثة ذكية مع مستر هاني", descEn: "Start AI conversation" },
    { cmd: "/document", descAr: "قراءة وتحليل المستندات (PDF, DOCX, XLSX)", descEn: "Analyze documents" },
    { cmd: "/image", descAr: "تحليل الصور والمخططات الهندسية", descEn: "Analyze images & blueprints" },
    { cmd: "/voice", descAr: "المساعد الصوتي وتفريغ الصوت", descEn: "Voice assistant & transcription" },
    { cmd: "/word", descAr: "توليد مستندات Word احترافية", descEn: "Generate Word (DOCX) files" },
    { cmd: "/excel", descAr: "توليد جداول Excel مع المعادلات", descEn: "Generate Excel (XLSX) spreadsheets" },
    { cmd: "/pdf", descAr: "توليد تقارير PDF رسمية", descEn: "Generate PDF reports" },
    { cmd: "/ppt", descAr: "توليد عروض PowerPoint تقديمية", descEn: "Generate PowerPoint presentations" },
    { cmd: "/history", descAr: "عرض سجل المحادثات والذاكرة", descEn: "View conversation history" },
    { cmd: "/settings", descAr: "إدارة إعدادات اللغة والنموذج", descEn: "Manage settings" },
    { cmd: "/clear", descAr: "مسح سياق المحادثة الحالي", descEn: "Clear current conversation context" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <Bot className="h-6 w-6 text-sky-600 dark:text-sky-400" />
              <div>
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  {isAr ? "ربط بوت تيليجرام المباشر (Telegram Bot API)" : "Live Telegram Bot API Bridge"}
                </h2>
                <p className="text-xs text-slate-500">
                  {telegramStatus.connected
                    ? isAr
                      ? `متصل ويعمل حالياً (${telegramStatus.mode === "webhook" ? "HTTPS Webhook" : "Long Polling"}): @${telegramStatus.botUsername} (${telegramStatus.botFirstName})`
                      : `Active (${telegramStatus.mode === "webhook" ? "HTTPS Webhook" : "Long Polling"}): @${telegramStatus.botUsername} (${telegramStatus.botFirstName})`
                    : isAr
                    ? "أدخل رمز @BotFather لتفعيل البوت الحي أو استخدم المحاكي التفاعلي مباشرة"
                    : "Enter your @BotFather API token to activate live polling or use the simulator"}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onRefreshStatus}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{isAr ? "تحديث الحالة" : "Refresh Status"}</span>
            </button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-950/60 sm:grid-cols-4">
            <div>
              <div className="text-[11px] text-slate-500">{isAr ? "وضع التشغيل" : "Bot Mode"}</div>
              <div className="mt-0.5 font-mono font-semibold text-slate-900 dark:text-slate-100">
                {telegramStatus.mode}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">{isAr ? "Webhook Secret" : "Secret Token"}</div>
              <div className="mt-0.5 font-mono font-semibold text-slate-900 dark:text-slate-100">
                {telegramStatus.webhookSecretConfigured
                  ? isAr
                    ? "مُؤمَّن ✓"
                    : "Secured ✓"
                  : isAr
                  ? "غير مضبوط"
                  : "Not Set"}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">{isAr ? "تحديثات مكررة مُنعت" : "Dedup Blocked"}</div>
              <div className="mt-0.5 font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {telegramStatus.deduplicatedUpdates ?? 0}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-slate-500">{isAr ? "مهام بالخلفية" : "In-Flight / Done"}</div>
              <div className="mt-0.5 font-mono font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {telegramStatus.inFlightJobs ?? 0} / {telegramStatus.completedJobs ?? 0}
              </div>
            </div>
          </div>

          {telegramStatus.botLink && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-300 bg-emerald-50/70 px-4 py-3 dark:border-emerald-800 dark:bg-emerald-950/30">
              <div className="text-xs font-medium text-emerald-900 dark:text-emerald-200">
                {isAr
                  ? `رابط البوت المباشر على تيليجرام: @${telegramStatus.botUsername}`
                  : `Direct Telegram Bot Link: @${telegramStatus.botUsername}`}
              </div>
              <a
                href={telegramStatus.botLink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700 whitespace-nowrap shrink-0"
              >
                <span>{isAr ? "فتح البوت في تيليجرام" : "Open in Telegram"}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          )}

          <div className="mt-5 space-y-3">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              {isAr
                ? "رمز بوت تيليجرام من @BotFather (TELEGRAM_BOT_TOKEN) أو رابط البوت"
                : "Telegram Bot API Token (@BotFather)"}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="123456789:AAH..."
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <button
                type="button"
                disabled={connecting || !tokenInput.trim()}
                onClick={async () => {
                  setConnecting(true);
                  try {
                    await onConnectToken(tokenInput.trim());
                    setTokenInput("");
                  } finally {
                    setConnecting(false);
                  }
                }}
                className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                {connecting
                  ? isAr
                    ? "جاري الاتصال..."
                    : "Connecting..."
                  : isAr
                  ? "ربط وتفعيل البوت"
                  : "Connect Live Bot"}
              </button>
            </div>
            {telegramStatus.lastError && (
              <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
                {telegramStatus.lastError}
              </p>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-slate-700 dark:text-slate-300" />
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {isAr ? "أوامر تيليجرام الـ 13 القياسية (اضغط للتنفيذ الفوري)" : "13 Telegram Bot Commands (Click to Run)"}
            </h3>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {commands.map((item) => (
              <button
                key={item.cmd}
                type="button"
                onClick={() => onTriggerCommand(item.cmd)}
                className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 text-left transition-colors hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60"
              >
                <span className="font-mono text-xs font-semibold text-sky-600 dark:text-sky-400">
                  {item.cmd}
                </span>
                <span className="truncate pl-2 text-xs text-slate-600 dark:text-slate-400">
                  {isAr ? item.descAr : item.descEn}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Live Telegram Activity Log */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 pb-4 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-sky-600" />
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {isAr
                ? "سجل رسائل تيليجرام الحية (Live Telegram Activity Feed)"
                : "Live Incoming Telegram Bot Activity"}
            </h3>
          </div>
          <span className="font-mono text-xs tabular-nums text-slate-500">
            {telegramStatus.processedTelegramMessages} {isAr ? "رسالة معالجة" : "messages handled"}
          </span>
        </div>

        <div className="mt-4 divide-y divide-slate-200 dark:divide-slate-800">
          {(!telegramStatus.recentActivity || telegramStatus.recentActivity.length === 0) ? (
            <p className="py-6 text-center text-xs text-slate-500">
              {isAr
                ? "بانتظار الرسائل الواردة من تيليجرام... أرسل /start أو أي سؤال إلى البوت على تيليجرام لتظهر العمليات هنا مباشرة."
                : "Waiting for incoming Telegram messages... Send /start or any question to your bot on Telegram to see live activity here."}
            </p>
          ) : (
            telegramStatus.recentActivity.map((act) => (
              <div key={act.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                  <div>
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {act.fromUser}
                    </span>
                    <span className="mx-1.5">·</span>
                    <span>{act.skillUsed}</span>
                    {act.generatedFileName && (
                      <>
                        <span className="mx-1.5">·</span>
                        <span className="font-mono text-sky-600 dark:text-sky-400">
                          {act.generatedFileName}
                        </span>
                      </>
                    )}
                  </div>
                  <span className="font-mono tabular-nums">{act.timestamp}</span>
                </div>
                <div className="mt-1 text-xs font-medium text-slate-800 dark:text-slate-200">
                  {act.userInput}
                </div>
                <div className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
                  {act.replyPreview}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

interface AdminDashboardProps {
  language: Language;
  isAdmin: boolean;
  totalMessages: number;
  totalFiles: number;
  totalMemories: number;
  totalTokens: number;
  skills: SkillMeta[];
  onToggleSkill: (skillId: string, enabled: boolean) => Promise<void>;
}

export const AdminDashboardPanel: React.FC<AdminDashboardProps> = ({
  language,
  isAdmin,
  totalMessages,
  totalFiles,
  totalMemories,
  totalTokens,
  skills,
  onToggleSkill,
}) => {
  const isAr = language === "ar";
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditReport, setAuditReport] = useState<any | null>(null);

  const handleRunLiveAudit = async () => {
    setAuditRunning(true);
    try {
      const res = await fetch("/api/audit/run", { method: "POST" });
      const data = await res.json();
      setAuditReport(data);
    } catch (err) {
      console.error("Audit error:", err);
    } finally {
      setAuditRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4 dark:border-slate-800">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {isAr ? "لوحة الإدارة والفحص التكاملي الشامل (Admin & Audit Console)" : "System Administration & Integration Audit"}
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {isAr
              ? "إحصائيات الرسائل، استهلاك التوكنات، حالة المهارات، وفحص التكامل الحي الشامل."
              : "Real-time message metrics, Gemini token usage, skill management, and live end-to-end integration tests."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled={auditRunning}
            onClick={handleRunLiveAudit}
            className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            {auditRunning
              ? isAr
                ? "جاري فحص النظام والملفات..."
                : "Running Live Audit..."
              : isAr
              ? "تشغيل الفحص التكاملي الشامل (13 اختباراً)"
              : "Run Full Integration Audit (13 Tests)"}
          </button>
          <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <Shield className="h-4 w-4 text-emerald-600" />
            <span>
              {isAdmin
                ? isAr
                  ? "صلاحية مدير النظام (Admin)"
                  : "Verified Administrator"
                : isAr
                ? "عرض قياسي"
                : "Standard User View"}
            </span>
          </div>
        </div>
      </div>

      {/* Live Integration Audit Results Table */}
      {auditReport && auditReport.results && (
        <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-6 py-4 dark:border-slate-800">
            <div>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {isAr ? "نتائج الاختبار التكاملي الفعلي (Live Functional Audit Report)" : "Live Functional & Security Audit Report"}
              </h3>
              <div className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
                <span>Passed: {auditReport.summary.passed}</span>
                <span className="mx-2">·</span>
                <span>Partial: {auditReport.summary.partial}</span>
                <span className="mx-2">·</span>
                <span>Requires Credentials: {auditReport.summary.requiresCredentials}</span>
                <span className="mx-2">·</span>
                <span>Failed: {auditReport.summary.failed}</span>
              </div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                  <th className="px-4 py-3">{isAr ? "الاختبار" : "Test Case"}</th>
                  <th className="px-4 py-3">{isAr ? "الفئة" : "Category"}</th>
                  <th className="px-4 py-3">{isAr ? "الحالة" : "Status"}</th>
                  <th className="px-4 py-3">{isAr ? "الزمن" : "Duration"}</th>
                  <th className="px-4 py-3">{isAr ? "التفاصيل الفنية" : "Diagnostic Details"}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {auditReport.results.map((r: any, idx: number) => (
                  <tr key={idx}>
                    <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                      {r.name}
                    </td>
                    <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-400">
                      {r.category}
                    </td>
                    <td className="px-4 py-3 font-mono font-semibold">
                      <span
                        className={
                          r.status === "PASSED"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : r.status === "FAILED"
                            ? "text-red-600 dark:text-red-400"
                            : "text-amber-600 dark:text-amber-400"
                        }
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono tabular-nums text-slate-500">
                      {r.durationMs}ms
                    </td>
                    <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                      {r.details}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 4-Column Metric Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{isAr ? "إجمالي الرسائل المعالجة" : "Processed Messages"}</span>
            <Users className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
            {totalMessages.toLocaleString()}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{isAr ? "الملفات المحللة والمولدة" : "Processed & Generated Files"}</span>
            <CheckCircle2 className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
            {totalFiles.toLocaleString()}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{isAr ? "استهلاك توكنات Gemini" : "Gemini Token Consumption"}</span>
            <Cpu className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
            {totalTokens.toLocaleString()}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>{isAr ? "سجلات الذاكرة الدائمة" : "Persistent Memory Records"}</span>
            <Sliders className="h-4 w-4 text-slate-400" />
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
            {totalMemories.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Modular Skills Management Table */}
      <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <div className="border-b border-slate-200 px-6 py-4 dark:border-slate-800">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {isAr ? "إدارة المهارات المستقلة (12 AI Agent Skills)" : "Modular Agent Skills Registry (12 Skills)"}
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                <th className="px-6 py-3">{isAr ? "المهارة" : "Skill Module"}</th>
                <th className="px-6 py-3">{isAr ? "الوصف الوظيفي" : "Capabilities"}</th>
                <th className="px-6 py-3">{isAr ? "النموذج الافتراضي" : "Default Model"}</th>
                <th className="px-6 py-3 text-right">{isAr ? "الحالة" : "Status"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {skills.map((skill) => (
                <tr key={skill.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/40">
                  <td className="px-6 py-3.5 font-medium text-slate-900 dark:text-slate-100">
                    {isAr ? skill.nameAr : skill.nameEn}
                  </td>
                  <td className="px-6 py-3.5 text-xs text-slate-600 dark:text-slate-400">
                    {isAr ? skill.descriptionAr : skill.descriptionEn}
                  </td>
                  <td className="px-6 py-3.5 font-mono text-xs tabular-nums text-slate-700 dark:text-slate-300">
                    {skill.defaultModel}
                  </td>
                  <td className="px-6 py-3.5 text-right">
                    <button
                      type="button"
                      onClick={() => onToggleSkill(skill.id, !skill.enabled)}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        skill.enabled
                          ? "bg-emerald-600 text-white hover:bg-emerald-700"
                          : "bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      {skill.enabled ? (isAr ? "مفعل / Active" : "Active") : (isAr ? "معطل / Paused" : "Paused")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
