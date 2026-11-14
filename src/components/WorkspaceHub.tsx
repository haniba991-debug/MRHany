import React, { useState } from "react";
import {
  FileText,
  Table,
  Presentation,
  Mail,
  StickyNote,
  ExternalLink,
  RefreshCw,
  Send,
  Plus,
  Search,
} from "lucide-react";
import { GoogleWorkspaceService, GmailMessageSummary } from "../services/workspace";
import { createMemoryItem, deleteMemoryItem } from "../services/firebase";
import { ConfirmationModal } from "./ConfirmationModal";
import { Language } from "../utils/i18n";

interface WorkspaceHubProps {
  language: Language;
  userId: string | null;
  hasAccessToken: boolean;
  onRequireSignIn: () => void;
  memories: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
  }>;
}

export const WorkspaceHub: React.FC<WorkspaceHubProps> = ({
  language,
  userId,
  hasAccessToken,
  onRequireSignIn,
  memories,
}) => {
  const isAr = language === "ar";
  const [activeService, setActiveService] = useState<
    "docs" | "sheets" | "slides" | "gmail" | "keep"
  >("docs");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Google Docs state
  const [docTitle, setDocTitle] = useState("تقرير مستر هاني التنفيذي");
  const [docBody, setDocBody] = useState(
    "ملخص تنفيذي تم إعداده بواسطة مستر هاني (Mr. Hany AI Assistant).\n\n1. نطاق العمل والمراجعة الهندسية.\n2. التوصيات الفنية والجدول الزمني."
  );
  const [createdDocUrl, setCreatedDocUrl] = useState<string | null>(null);
  const [readDocId, setReadDocId] = useState("");
  const [loadedDocContent, setLoadedDocContent] = useState<{ title: string; text: string } | null>(null);

  // Google Sheets state
  const [sheetTitle, setSheetTitle] = useState("مقايسة الكميات والبيانات - Mr. Hany BOQ");
  const [sheetIdToRead, setSheetIdToRead] = useState("");
  const [createdSheetUrl, setCreatedSheetUrl] = useState<string | null>(null);
  const [loadedSheetData, setLoadedSheetData] = useState<{
    title: string;
    sheetNames: string[];
    activeSheet: string;
    rows: string[][];
  } | null>(null);

  // Google Slides state
  const [slidesTitle, setSlidesTitle] = useState("العرض التقديمي التنفيذي - Mr. Hany");
  const [slide1Title, setSlide1Title] = useState("الأهداف الاستراتيجية للمشروع");
  const [slide1Bullets, setSlide1Bullets] = useState(
    "تحقيق أعلى معايير الجودة الهندسية\nأتمتة تحليل المستندات والبيانات\nتقليص زمن إعداد التقارير بنسبة 70%"
  );
  const [createdSlidesUrl, setCreatedSlidesUrl] = useState<string | null>(null);

  // Gmail state
  const [inboxMessages, setInboxMessages] = useState<GmailMessageSummary[]>([]);
  const [emailTo, setEmailTo] = useState("");
  const [emailSubject, setEmailSubject] = useState("تقرير فني من مستر هاني AI");
  const [emailBody, setEmailBody] = useState(
    "تحية طيبة،\n\nمرفق لكم ملخص التحليل الفني الصادر عن منصة مستر هاني الذكية.\n\nمع خالص التحية،"
  );

  // Google Keep & Notes state
  const [noteTitle, setNoteTitle] = useState("");
  const [noteContent, setNoteContent] = useState("");
  const [keepEnterpriseNotice, setKeepEnterpriseNotice] = useState<string | null>(null);

  // Confirmation Modal state
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    description: string;
    isDestructive?: boolean;
    action: () => Promise<void>;
  }>({
    open: false,
    title: "",
    description: "",
    action: async () => {},
  });

  const promptConfirmation = (
    title: string,
    description: string,
    action: () => Promise<void>,
    isDestructive = false
  ) => {
    setConfirmState({ open: true, title, description, isDestructive, action });
  };

  const executeWithGuard = async (fn: () => Promise<void>) => {
    if (!hasAccessToken) {
      onRequireSignIn();
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await fn();
    } catch (err: any) {
      if (err.message === "WORKSPACE_AUTH_REQUIRED") {
        onRequireSignIn();
      } else {
        setErrorMsg(err.message || "حدث خطأ أثناء الاتصال بخدمات Google Workspace");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Service Selector Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4 dark:border-slate-800">
        <div>
          <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            {isAr
              ? "مركز تكامل Google Workspace المباشر"
              : "Google Workspace Live Integration Hub"}
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {isAr
              ? "إنشاء وقراءة المستندات والجداول والعروض التقديمية والبريد الإلكتروني والملاحظات بصلاحية المستخدم."
              : "Create and read Docs, Sheets, Slides, Gmail messages, and Keep notes with explicit user confirmation."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
          {[
            { id: "docs", label: "Google Docs", icon: FileText },
            { id: "sheets", label: "Google Sheets", icon: Table },
            { id: "slides", label: "Google Slides", icon: Presentation },
            { id: "gmail", label: "Gmail", icon: Mail },
            { id: "keep", label: "Google Keep", icon: StickyNote },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeService === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  setActiveService(tab.id as any);
                  setStatusMsg(null);
                  setErrorMsg(null);
                }}
                className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? "bg-white text-slate-900 shadow-xs dark:bg-slate-900 dark:text-slate-100"
                    : "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {!hasAccessToken && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-amber-300 bg-amber-50/70 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="text-sm text-amber-900 dark:text-amber-200">
            {isAr
              ? "لتنفيذ العمليات الحية على حسابك في Google Docs وSheets وSlides وGmail، يرجى تسجيل الدخول ومنح الصلاحية."
              : "To execute live calls on your Google Docs, Sheets, Slides, and Gmail account, please sign in with Google."}
          </div>
          <button
            type="button"
            onClick={onRequireSignIn}
            className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0 dark:bg-slate-100 dark:text-slate-900"
          >
            {isAr ? "ربط حساب Google Workspace" : "Authorize Google Workspace"}
          </button>
        </div>
      )}

      {statusMsg && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          {statusMsg}
        </div>
      )}

      {errorMsg && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          {errorMsg}
        </div>
      )}

      {/* 1. GOOGLE DOCS PANEL */}
      {activeService === "docs" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {isAr ? "إنشاء مستند Google Doc جديد" : "Create New Google Doc"}
            </h3>
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {isAr ? "عنوان المستند" : "Document Title"}
                </label>
                <input
                  type="text"
                  value={docTitle}
                  onChange={(e) => setDocTitle(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {isAr ? "محتوى المستند" : "Document Content"}
                </label>
                <textarea
                  rows={5}
                  value={docBody}
                  onChange={(e) => setDocBody(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    promptConfirmation(
                      isAr ? "تأكيد إنشاء مستند Google Doc" : "Confirm Google Doc Creation",
                      isAr
                        ? `سيقوم مستر هاني بإنشاء مستند جديد بعنوان "${docTitle}" في حساب Google Docs الخاص بك.`
                        : `Mr. Hany will create a new document titled "${docTitle}" in your Google Docs account.`,
                      async () => {
                        await executeWithGuard(async () => {
                          const res = await GoogleWorkspaceService.createGoogleDoc(docTitle, docBody);
                          setCreatedDocUrl(res.url);
                          setStatusMsg(
                            isAr
                              ? `تم إنشاء المستند بنجاح (ID: ${res.documentId})`
                              : `Google Doc created successfully (ID: ${res.documentId})`
                          );
                        });
                      }
                    )
                  }
                  className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  {isAr ? "إنشاء في Google Docs" : "Create in Google Docs"}
                </button>
                {createdDocUrl && (
                  <a
                    href={createdDocUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-600 hover:underline dark:text-sky-400"
                  >
                    <span>{isAr ? "فتح المستند" : "Open Google Doc"}</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {isAr ? "قراءة مستند Google Doc عبر المعرف (Document ID)" : "Read Google Doc by ID"}
            </h3>
            <div className="mt-4 flex gap-2">
              <input
                type="text"
                placeholder={isAr ? "أدخل Document ID من رابط المستند..." : "Paste Google Doc ID..."}
                value={readDocId}
                onChange={(e) => setReadDocId(e.target.value)}
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <button
                type="button"
                disabled={busy || !readDocId.trim()}
                onClick={() =>
                  executeWithGuard(async () => {
                    const data = await GoogleWorkspaceService.readGoogleDoc(readDocId);
                    setLoadedDocContent(data);
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0 dark:bg-slate-100 dark:text-slate-900"
              >
                <Search className="h-3.5 w-3.5" />
                <span>{isAr ? "قراءة المستند" : "Fetch Doc"}</span>
              </button>
            </div>
            {loadedDocContent && (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {loadedDocContent.title}
                </div>
                <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-slate-700 dark:text-slate-300">
                  {loadedDocContent.text || "(Empty document)"}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 2. GOOGLE SHEETS PANEL */}
      {activeService === "sheets" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {isAr ? "إنشاء جدول Google Sheet هندسي / مالي" : "Create Engineering / BOQ Google Sheet"}
            </h3>
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {isAr ? "عنوان جدول البيانات" : "Spreadsheet Title"}
                </label>
                <input
                  type="text"
                  value={sheetTitle}
                  onChange={(e) => setSheetTitle(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    promptConfirmation(
                      isAr ? "تأكيد إنشاء جدول Google Sheets" : "Confirm Google Sheet Creation",
                      isAr
                        ? `سيتم إنشاء جدول بيانات جديد بعنوان "${sheetTitle}" وإدراج بنود الحصر القياسية.`
                        : `A new Google Sheet titled "${sheetTitle}" will be created in your account.`,
                      async () => {
                        await executeWithGuard(async () => {
                          const res = await GoogleWorkspaceService.createGoogleSheet({
                            title: sheetTitle,
                            sheetName: "BOQ_Summary",
                            headers: ["Item No", "Description", "Unit", "Quantity", "Unit Price", "Total"],
                            rows: [
                              ["1.01", "خرسانة مسلحة للقواعد المنفصلة C30/37", "m3", 45, 3200, "=D2*E2"],
                              ["1.02", "حديد تسليح عالي المقاومة B500B", "Ton", 4.6, 42000, "=D3*E3"],
                              ["1.03", "خرسانة مسلحة للأعمدة والحوائط", "m3", 22, 3500, "=D4*E4"],
                            ],
                          });
                          setCreatedSheetUrl(res.url);
                          setSheetIdToRead(res.spreadsheetId);
                          setStatusMsg(
                            isAr
                              ? `تم إنشاء جدول Google Sheets بنجاح (ID: ${res.spreadsheetId})`
                              : `Google Sheet created (ID: ${res.spreadsheetId})`
                          );
                        });
                      }
                    )
                  }
                  className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  {isAr ? "إنشاء جدول في Google Sheets" : "Create in Google Sheets"}
                </button>
                {createdSheetUrl && (
                  <a
                    href={createdSheetUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 hover:underline dark:text-emerald-400"
                  >
                    <span>{isAr ? "فتح الجدول" : "Open Sheet"}</span>
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {isAr ? "قراءة بيانات Google Sheet (مع اكتشاف الأوراق تلقائياً)" : "Read Google Sheet (Dynamic Sheet Discovery)"}
            </h3>
            <div className="mt-4 flex gap-2">
              <input
                type="text"
                placeholder={isAr ? "أدخل Spreadsheet ID..." : "Enter Spreadsheet ID..."}
                value={sheetIdToRead}
                onChange={(e) => setSheetIdToRead(e.target.value)}
                className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <button
                type="button"
                disabled={busy || !sheetIdToRead.trim()}
                onClick={() =>
                  executeWithGuard(async () => {
                    const sheetData = await GoogleWorkspaceService.readGoogleSheet(sheetIdToRead);
                    setLoadedSheetData(sheetData);
                  })
                }
                className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shrink-0 dark:bg-slate-100 dark:text-slate-900"
              >
                {isAr ? "جلب البيانات" : "Load Sheet"}
              </button>
            </div>
            {loadedSheetData && (
              <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800">
                <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                  <span>{loadedSheetData.title}</span>
                  <span className="mx-2">·</span>
                  <span>Sheet: {loadedSheetData.activeSheet}</span>
                </div>
                <table className="w-full text-left text-xs">
                  <tbody>
                    {loadedSheetData.rows.slice(0, 8).map((r, rIdx) => (
                      <tr key={rIdx} className="border-b border-slate-100 dark:border-slate-800">
                        {r.map((cell, cIdx) => (
                          <td key={cIdx} className="px-3 py-2 font-mono tabular-nums text-slate-800 dark:text-slate-200">
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. GOOGLE SLIDES PANEL */}
      {activeService === "slides" && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {isAr ? "إنشاء عرض تقديمي في Google Slides" : "Create Presentation in Google Slides"}
          </h3>
          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                {isAr ? "عنوان العرض التقديمي" : "Presentation Title"}
              </label>
              <input
                type="text"
                value={slidesTitle}
                onChange={(e) => setSlidesTitle(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <label className="mt-3 block text-xs font-medium text-slate-700 dark:text-slate-300">
                {isAr ? "عنوان الشريحة الرئيسية" : "Slide Heading"}
              </label>
              <input
                type="text"
                value={slide1Title}
                onChange={(e) => setSlide1Title(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                {isAr ? "النقاط الرئيسية (كل نقطة في سطر)" : "Slide Bullet Points (one per line)"}
              </label>
              <textarea
                rows={4}
                value={slide1Bullets}
                onChange={(e) => setSlide1Bullets(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                promptConfirmation(
                  isAr ? "تأكيد إنشاء عرض Google Slides" : "Confirm Google Slides Creation",
                  isAr
                    ? `سيقوم مستر هاني بإنشاء عرض تقديمي جديد بعنوان "${slidesTitle}" في حسابك.`
                    : `Mr. Hany will create a new Google Slides deck titled "${slidesTitle}".`,
                  async () => {
                    await executeWithGuard(async () => {
                      const res = await GoogleWorkspaceService.createGoogleSlides({
                        title: slidesTitle,
                        slides: [
                          {
                            slideTitle: slide1Title,
                            bullets: slide1Bullets.split("\n").filter(Boolean),
                          },
                        ],
                      });
                      setCreatedSlidesUrl(res.url);
                      setStatusMsg(
                        isAr
                          ? `تم إنشاء العرض التقديمي بنجاح (ID: ${res.presentationId})`
                          : `Google Slides presentation created (ID: ${res.presentationId})`
                      );
                    });
                  }
                )
              }
              className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              {isAr ? "إنشاء في Google Slides" : "Create in Google Slides"}
            </button>
            {createdSlidesUrl && (
              <a
                href={createdSlidesUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-600 hover:underline dark:text-amber-400"
              >
                <span>{isAr ? "فتح العرض التقديمي" : "Open Presentation"}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        </div>
      )}

      {/* 4. GMAIL PANEL */}
      {activeService === "gmail" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {isAr ? "صندوق الوارد (Gmail Inbox)" : "Gmail Recent Messages"}
              </h3>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  executeWithGuard(async () => {
                    const msgs = await GoogleWorkspaceService.listGmailMessages(5);
                    setInboxMessages(msgs);
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>{isAr ? "تحديث البريد" : "Load Inbox"}</span>
              </button>
            </div>
            <div className="mt-4 divide-y divide-slate-200 dark:divide-slate-800">
              {inboxMessages.length === 0 ? (
                <p className="py-8 text-center text-xs text-slate-500">
                  {isAr
                    ? "اضغط على «تحديث البريد» لعرض أحدث رسائل Gmail الخاصة بك."
                    : "Click 'Load Inbox' to view your recent Gmail messages."}
                </p>
              ) : (
                inboxMessages.map((m) => (
                  <div key={m.id} className="py-3">
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {m.subject}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      <span>{m.from}</span>
                      {m.date && (
                        <>
                          <span className="mx-1.5">·</span>
                          <span>{m.date}</span>
                        </>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-slate-600 dark:text-slate-400">
                      {m.snippet}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {isAr ? "إرسال بريد إلكتروني عبر Gmail" : "Send Email via Gmail"}
            </h3>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {isAr ? "إلى (البريد الإلكتروني)" : "Recipient Email"}
                </label>
                <input
                  type="email"
                  placeholder="recipient@example.com"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {isAr ? "الموضوع" : "Subject"}
                </label>
                <input
                  type="text"
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  {isAr ? "نص الرسالة" : "Message Body"}
                </label>
                <textarea
                  rows={4}
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                />
              </div>
              <button
                type="button"
                disabled={busy || !emailTo.trim()}
                onClick={() =>
                  promptConfirmation(
                    isAr ? "تأكيد إرسال بريد إلكتروني" : "Confirm Sending Email",
                    isAr
                      ? `هل أنت متأكد من إرسال هذا البريد الإلكتروني إلى "${emailTo}" بعنوان "${emailSubject}" نيابةً عنك؟`
                      : `Are you sure you want to send an email to "${emailTo}" with subject "${emailSubject}" on your behalf?`,
                    async () => {
                      await executeWithGuard(async () => {
                        const sent = await GoogleWorkspaceService.sendGmailMessage({
                          to: emailTo.trim(),
                          subject: emailSubject,
                          body: emailBody,
                        });
                        setStatusMsg(
                          isAr
                            ? `تم إرسال البريد الإلكتروني بنجاح (معرف الرسالة: ${sent.id})`
                            : `Email sent successfully (Message ID: ${sent.id})`
                        );
                      });
                    }
                  )
                }
                className="inline-flex items-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Send className="h-3.5 w-3.5" />
                <span>{isAr ? "إرسال عبر Gmail" : "Send Email"}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5. GOOGLE KEEP & PERSISTENT NOTES PANEL */}
      {activeService === "keep" && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {isAr ? "إضافة ملاحظة جديدة (Keep & ذاكرة مستر هاني)" : "Add Keep Note & Persistent Memory"}
              </h3>
              <button
                type="button"
                onClick={() =>
                  executeWithGuard(async () => {
                    const res = await GoogleWorkspaceService.tryFetchKeepNotes();
                    if (!res.enterpriseSupported) {
                      setKeepEnterpriseNotice(
                        isAr
                          ? "ملاحظة: واجهة Google Keep API المباشرة مخصصة لحسابات Google Workspace للمؤسسات (Enterprise Domain-Wide Delegation). يتم حفظ ومزامنة جميع ملاحظاتك تلقائياً في قاعدة بيانات Firestore المشفرة الخاصة بك."
                          : "Note: The REST Google Keep API is restricted by Google to Enterprise Workspace accounts with domain-wide delegation. Your notes are automatically persisted in your private Firestore database."
                      );
                    } else {
                      setStatusMsg(`Loaded ${res.notes.length} Enterprise Keep notes.`);
                    }
                  })
                }
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:text-slate-300"
              >
                {isAr ? "مزامنة Google Keep API" : "Sync Keep API"}
              </button>
            </div>

            {keepEnterpriseNotice && (
              <p className="mt-3 rounded-lg bg-slate-100 p-3 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                {keepEnterpriseNotice}
              </p>
            )}

            <div className="mt-4 space-y-3">
              <input
                type="text"
                placeholder={isAr ? "عنوان الملاحظة أو التفضيل الهندسي..." : "Note or engineering memory title..."}
                value={noteTitle}
                onChange={(e) => setNoteTitle(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <textarea
                rows={4}
                placeholder={isAr ? "محتوى الملاحظة..." : "Note details..."}
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
              />
              <button
                type="button"
                disabled={!userId || !noteTitle.trim() || !noteContent.trim()}
                onClick={async () => {
                  if (!userId) {
                    onRequireSignIn();
                    return;
                  }
                  await createMemoryItem({
                    userId,
                    category: "note",
                    title: noteTitle,
                    content: noteContent,
                  });
                  setNoteTitle("");
                  setNoteContent("");
                  setStatusMsg(isAr ? "تم حفظ الملاحظة في ذاكرة مستر هاني." : "Note saved to persistent memory.");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{isAr ? "حفظ الملاحظة" : "Save Note"}</span>
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {isAr ? "الملاحظات والذاكرة المحفوظة" : "Saved Notes & Approved Memories"}
            </h3>
            <div className="mt-4 divide-y divide-slate-200 dark:divide-slate-800">
              {memories.length === 0 ? (
                <p className="py-8 text-center text-xs text-slate-500">
                  {isAr ? "لا توجد ملاحظات محفوظة بعد." : "No saved notes yet."}
                </p>
              ) : (
                memories.map((mem) => (
                  <div key={mem.id} className="flex items-start justify-between gap-4 py-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {mem.title}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500">{mem.category}</div>
                      <p className="mt-1 text-xs text-slate-700 dark:text-slate-300">{mem.content}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        promptConfirmation(
                          isAr ? "حذف الملاحظة المحفوظة" : "Delete Saved Note",
                          isAr
                            ? `هل تريد بالتأكيد حذف الملاحظة "${mem.title}" نهائياً؟`
                            : `Are you sure you want to permanently delete "${mem.title}"?`,
                          async () => {
                            await deleteMemoryItem(mem.id);
                          },
                          true
                        )
                      }
                      className="text-xs font-medium text-red-600 hover:underline whitespace-nowrap shrink-0 dark:text-red-400"
                    >
                      {isAr ? "حذف" : "Delete"}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmationModal
        open={confirmState.open}
        title={confirmState.title}
        description={confirmState.description}
        isDestructive={confirmState.isDestructive}
        onConfirm={async () => {
          const fn = confirmState.action;
          setConfirmState((prev) => ({ ...prev, open: false }));
          await fn();
        }}
        onCancel={() => setConfirmState((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
};
