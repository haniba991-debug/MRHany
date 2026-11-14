import React, { useState } from "react";
import { Download, Smartphone, Share, PlusSquare, Check, Copy, WifiOff, X, ExternalLink } from "lucide-react";
import { usePWAInstall, useOnlineStatus } from "../hooks/usePWAInstall";

export const MR_HANY_APP_LOGO_URL = "/src/assets/images/mr_hany_app_logo_1793557082254.jpg";

interface PWAInstallButtonProps {
  language: "ar" | "en";
  compact?: boolean;
}

export const PWAInstallButton: React.FC<PWAInstallButtonProps> = ({
  language,
  compact = false,
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuideModal, setShowGuideModal] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const isAr = language === "ar";

  // Hide automatically when running as an installed standalone PWA
  if (isInstalled) {
    return null;
  }

  const handleInstallClick = async () => {
    if (isInstallable) {
      await install();
    } else {
      setShowGuideModal(true);
    }
  };

  const directAppUrl =
    typeof window !== "undefined" ? window.location.origin : "";

  const handleCopyLink = () => {
    navigator.clipboard.writeText(directAppUrl);
    setCopiedUrl(true);
    setTimeout(() => setCopiedUrl(false), 2500);
  };

  return (
    <>
      <button
        type="button"
        onClick={handleInstallClick}
        className={`inline-flex items-center gap-2 rounded-lg bg-sky-600 font-semibold text-white shadow-2xs transition-colors hover:bg-sky-700 whitespace-nowrap shrink-0 ${
          compact ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-xs"
        }`}
      >
        <img
          src={MR_HANY_APP_LOGO_URL}
          alt="Mr. Hany Logo"
          className="h-4 w-4 rounded-sm object-cover shrink-0"
        />
        <span>
          {isAr
            ? compact
              ? "تثبيت التطبيق (App)"
              : "تثبيت تطبيق مستر هاني (WebAPK)"
            : compact
            ? "Install App"
            : "Install Mr. Hany App"}
        </span>
      </button>

      {showGuideModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-xs">
          <div
            dir={isAr ? "rtl" : "ltr"}
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
              <div className="flex items-center gap-3">
                <img
                  src={MR_HANY_APP_LOGO_URL}
                  alt="Mr. Hany Official App Icon"
                  className="h-12 w-12 rounded-2xl border border-slate-200 object-cover shadow-sm dark:border-slate-700"
                />
                <div>
                  <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                    {isAr
                      ? "تثبيت تطبيق Mr. Hany الرسمي"
                      : "Install Mr. Hany Official App"}
                  </h3>
                  <p className="text-xs text-slate-500">
                    {isAr
                      ? "تطبيق مستقل كامل الشاشة باللوجو الرسمي (WebAPK)"
                      : "Full-screen standalone app with official icon"}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowGuideModal(false)}
                className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-4 space-y-3.5 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
              {isInstallable && (
                <button
                  type="button"
                  onClick={async () => {
                    const ok = await install();
                    if (ok) setShowGuideModal(false);
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-sky-600 py-3 text-sm font-bold text-white shadow-sm hover:bg-sky-700"
                >
                  <Download className="h-4 w-4" />
                  <span>
                    {isAr
                      ? "تثبيت التطبيق مباشرة الآن (Install Now)"
                      : "Install Application Now"}
                  </span>
                </button>
              )}

              {/* Android Chrome WebAPK Instructions */}
              <div className="rounded-xl border border-sky-200 bg-sky-50/70 p-3.5 dark:border-sky-800 dark:bg-sky-950/30">
                <div className="font-bold text-slate-900 dark:text-slate-100">
                  {isAr
                    ? "🤖 لتثبيته كتطبيق كامل (WebAPK) على Android:"
                    : "🤖 To install as a full App (WebAPK) on Android:"}
                </div>
                <ol className="mt-2 space-y-1.5 list-decimal list-inside">
                  <li>
                    {isAr
                      ? "1. افتح رابط التطبيق المباشر في متصفح Google Chrome على هاتفك (وليس داخل متصفح داخلي)."
                      : "1. Open the direct app link in Google Chrome on your phone."}
                  </li>
                  <li>
                    {isAr
                      ? "2. إذا كان لديك اختصار قديم على الشاشة، احذفه أولاً ثم أعد تحميل الصفحة."
                      : "2. Remove any old shortcut first, then reload the page."}
                  </li>
                  <li>
                    {isAr
                      ? "3. اضغط على زر «تثبيت التطبيق» الأزرق أو من قائمة Chrome (⋮) اختر «تثبيت التطبيق / Install app» ليتم تثبيته باللوجو الرسمي في قائمة تطبيقات هاتفك."
                      : "3. Tap 'Install App' to install the full package with the official icon into your app drawer."}
                  </li>
                </ol>
              </div>

              {/* iOS Safari Instructions */}
              <div
                className={`rounded-xl border p-3.5 ${
                  isIOS
                    ? "border-sky-500 bg-sky-50/70 dark:border-sky-700 dark:bg-sky-950/30"
                    : "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950"
                }`}
              >
                <div className="font-bold text-slate-900 dark:text-slate-100">
                  {isAr ? "📱 لأجهزة iPhone و iPad (متصفح Safari):" : "📱 On iPhone & iPad (Safari):"}
                </div>
                <ol className="mt-2 space-y-1.5 list-decimal list-inside">
                  <li className="flex items-center gap-1.5">
                    <span>
                      {isAr
                        ? "1. افتح الرابط في Safari واضغط على زر المشاركة (Share)"
                        : "1. Open in Safari and tap the Share button"}
                    </span>
                    <Share className="inline h-3.5 w-3.5 text-sky-600" />
                  </li>
                  <li className="flex items-center gap-1.5">
                    <span>
                      {isAr
                        ? "2. اختر «إضافة إلى الشاشة الرئيسية» (Add to Home Screen)"
                        : "2. Select 'Add to Home Screen'"}
                    </span>
                    <PlusSquare className="inline h-3.5 w-3.5 text-sky-600" />
                  </li>
                </ol>
              </div>

              {/* Copy Direct App Link */}
              <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 p-2.5 dark:border-slate-800">
                <span className="truncate font-mono text-[11px] text-slate-500">
                  {directAppUrl}
                </span>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0 dark:bg-slate-100 dark:text-slate-900"
                >
                  {copiedUrl ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400 dark:text-emerald-600" />
                      <span>{isAr ? "تم نسخ الرابط" : "Copied!"}</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>{isAr ? "نسخ رابط التثبيت" : "Copy Link"}</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowGuideModal(false)}
              className="mt-5 w-full rounded-xl bg-slate-100 py-2.5 text-xs font-semibold text-slate-800 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
            >
              {isAr ? "إغلاق" : "Close"}
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const MobileAppInstallCard: React.FC<{ language: "ar" | "en" }> = ({ language }) => {
  const { isInstallable, isInstalled, install } = usePWAInstall();
  const [dismissed, setDismissed] = useState(false);
  const isAr = language === "ar";

  if (isInstalled || dismissed) return null;

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-3.5 shadow-2xs dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-3">
        <img
          src={MR_HANY_APP_LOGO_URL}
          alt="Mr. Hany App Logo"
          className="h-12 w-12 rounded-2xl border border-slate-200 object-cover shadow-xs shrink-0 dark:border-slate-700"
        />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
              {isAr ? "تطبيق مستر هاني (Mr. Hany App)" : "Mr. Hany Official Mobile App"}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {isAr
              ? "ثبّت التطبيق الرسمي باللوجو ليشتغل كتطبيق مستقل كامل الشاشة على هاتفك"
              : "Install the standalone mobile app with official icon on your phone"}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isInstallable ? (
          <button
            type="button"
            onClick={install}
            className="inline-flex items-center gap-1.5 rounded-xl bg-sky-600 px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-sky-700 whitespace-nowrap shrink-0"
          >
            <Download className="h-3.5 w-3.5" />
            <span>{isAr ? "تثبيت التطبيق الآن" : "Install App Now"}</span>
          </button>
        ) : (
          <PWAInstallButton language={language} compact />
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
          aria-label="Dismiss install banner"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};

export const OfflineIndicator: React.FC<{ language: "ar" | "en" }> = ({ language }) => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  const isAr = language === "ar";
  return (
    <div className="fixed bottom-20 left-4 right-4 md:bottom-4 md:right-auto z-50 flex items-center justify-center gap-2 rounded-xl bg-amber-600 px-4 py-2.5 text-xs font-semibold text-white shadow-lg">
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>
        {isAr
          ? "وضع عدم الاتصال (Offline Mode) — يتم استخدام البيانات المخزنة مؤقتاً."
          : "Offline Mode — Cached app resources are being used."}
      </span>
    </div>
  );
};
