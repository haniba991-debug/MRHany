/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from "react";
import {
  MessageSquare,
  FileText,
  Image as ImageIcon,
  Mic,
  MicOff,
  FileSpreadsheet,
  FileCheck,
  Presentation,
  BarChart3,
  Compass,
  History,
  Settings,
  HelpCircle,
  Upload,
  Download,
  Volume2,
  MapPin,
  Trash2,
  Send,
  ExternalLink,
  Sun,
  Moon,
  Globe,
  Layers,
  Video,
  Camera,
  Smartphone,
  Monitor,
  Bot,
  FolderKanban,
} from "lucide-react";
import {
  db,
  initAuth,
  googleSignIn,
  logout,
  saveMessageTurn,
  saveProcessedFileRecord,
  createMemoryItem,
  clearUserMessageHistory,
  updateUserPreferences,
  collection,
  query,
  where,
  onSnapshot,
  OperationType,
  handleFirestoreError,
} from "./services/firebase";
import { GoogleWorkspaceService } from "./services/workspace";
import { WorkspaceHub } from "./components/WorkspaceHub";
import { TelegramBridgePanel, AdminDashboardPanel } from "./components/TelegramBridgeAndAdmin";
import { ConfirmationModal } from "./components/ConfirmationModal";
import {
  PWAInstallButton,
  MobileAppInstallCard,
  OfflineIndicator,
  MR_HANY_APP_LOGO_URL,
} from "./components/PWAInstallBanner";
import { translations, Language } from "./utils/i18n";

// Generated visual assets from Phase 1
const MR_HANY_AVATAR_URL = "/src/assets/images/mr_hany_avatar_1793550008989.jpg";
const SAMPLE_BLUEPRINT_URL = "/src/assets/images/engineering_blueprint_sample_1793549881807.jpg";

type MenuMode =
  | "chat"
  | "documents"
  | "images"
  | "voice"
  | "word"
  | "excel"
  | "pdf"
  | "ppt"
  | "data"
  | "engineering"
  | "history"
  | "settings"
  | "help";

interface ChatTurnUI {
  id: string;
  role: "user" | "model";
  content: string;
  transcript?: string;
  skillUsed: string;
  modelUsed: string;
  tokensUsed: number;
  createdAtLabel: string;
  groundingLinks?: Array<{
    title: string;
    uri: string;
    sourceType: "maps" | "web";
    reviewSnippets?: string[];
  }>;
  audioReplyBase64?: string;
  generatedFile?: {
    fileName: string;
    mimeType: string;
    base64Data: string;
    structuredSpec?: any;
  };
  parsedDocMeta?: {
    fileName: string;
    totalCharacters: number;
    chunkCount: number;
    tablesPreview?: string[][];
  };
}

export default function App() {
  const [language, setLanguage] = useState<Language>("ar");
  const [darkMode, setDarkMode] = useState<boolean>(false);
  const [mobilePhonePreview, setMobilePhonePreview] = useState<boolean>(false);
  const [topSection, setTopSection] = useState<
    "assistant" | "engineering" | "workspace" | "telegram" | "admin"
  >("assistant");
  const [activeMenu, setActiveMenu] = useState<MenuMode>("chat");

  // Auth & Workspace state
  const [user, setUser] = useState<any | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState<boolean>(false);

  // Model & Grounding Options
  const [selectedModel, setSelectedModel] = useState<
    "gemini-4-argon" | "gemini-3.8-flash" | "gemini-3.1-flash-lite"
  >("gemini-3.8-flash");
  const [enableMapsGrounding, setEnableMapsGrounding] = useState<boolean>(false);
  const [enableVoiceReply, setEnableVoiceReply] = useState<boolean>(false);
  const [userLatLng, setUserLatLng] = useState<{ latitude: number; longitude: number } | undefined>(
    undefined
  );

  // Input & Multimodal Attachment State
  const [promptInput, setPromptInput] = useState<string>("");
  const [attachedFile, setAttachedFile] = useState<{
    name: string;
    mimeType: string;
    base64Data: string;
    sizeBytes: number;
    previewUrl?: string;
  } | null>(null);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [workspaceExportNotice, setWorkspaceExportNotice] = useState<{
    message: string;
    url?: string;
  } | null>(null);

  // Microphone Audio Recording State (for gemini-3.5-transcribe)
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // Conversation Turns & Persistent Firestore Data
  const [messages, setMessages] = useState<ChatTurnUI[]>([
    {
      id: "welcome_turn",
      role: "model",
      content:
        "مرحباً بك! أنا **مستر هاني (Mr. Hany)**، مساعدك الذكي المتطور والمهندس الاستشاري.\n\nيمكنني مساعدتك اليوم في:\n- المحادثة الذكية، البحث المعمق، وربط خرائط Google.\n- قراءة وتحليل ملفات **PDF, Word, Excel, CSV, TXT** مهما كان حجمها.\n- تحليل الصور، لقطات الشاشة، الفيديو، والمخططات الهندسية وحصر كميات الخرسانة والحديد (**Gemini 4 Argon**).\n- تفريغ الرسائل الصوتية بالعربية (المصرية والخليجية والفصحى) والإنجليزية (**Gemini 3.5 Transcribe**) والرد الصوتي.\n- توليد ملفات **Word, Excel, PDF, PowerPoint** وتصديرها مباشرة إلى **Google Docs, Sheets, Slides**.",
      skillUsed: "ChatSkill",
      modelUsed: "gemini-3.8-flash",
      tokensUsed: 0,
      createdAtLabel: "الآن / Just now",
    },
  ]);
  const [firestoreFiles, setFirestoreFiles] = useState<any[]>([]);
  const [firestoreMemories, setFirestoreMemories] = useState<any[]>([]);
  const [memoryRetentionDays, setMemoryRetentionDays] = useState<number>(30);

  // Server Platform & Telegram Bot Status
  const [telegramStatus, setTelegramStatus] = useState<any>({
    connected: false,
    mode: "simulator_ready",
    processedTelegramMessages: 0,
  });
  const [skillsRegistry, setSkillsRegistry] = useState<any[]>([]);
  const [adminSecret, setAdminSecret] = useState("");

  // Confirmation Modal State
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    isDestructive?: boolean;
    onConfirm: () => Promise<void>;
  }>({
    open: false,
    title: "",
    description: "",
    onConfirm: async () => {},
  });

  const t = translations[language];
  const isAr = language === "ar";

  // Sync dark mode class on <html>
  useEffect(() => {
    const rootEl = document.documentElement;
    if (darkMode) {
      rootEl.classList.add("dark");
    } else {
      rootEl.classList.remove("dark");
    }
  }, [darkMode]);

  // Sync RTL/LTR direction on <html>
  useEffect(() => {
    document.documentElement.dir = isAr ? "rtl" : "ltr";
    document.documentElement.lang = language;
  }, [isAr, language]);

  // Initialize Firebase Auth
  useEffect(() => {
    const unsub = initAuth((authUser, token) => {
      setUser(authUser);
      setAccessToken(token);
      setAuthReady(true);
    });
    return () => unsub();
  }, []);

  // Load Server Status & Skills Registry
  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then((data) => {
        if (data.telegram) setTelegramStatus(data.telegram);
        if (data.skills) setSkillsRegistry(data.skills);
      })
      .catch((err) => console.warn("Status fetch notice:", err));
  }, []);

  // Attach Firestore Real-Time Listeners when authenticated
  useEffect(() => {
    if (!authReady || !user || !user.emailVerified) return;

    const msgQuery = query(collection(db, "messages"), where("userId", "==", user.uid));
    const unsubMessages = onSnapshot(
      msgQuery,
      (snap) => {
        const loaded: ChatTurnUI[] = snap.docs
          .map((d) => {
            const data = d.data();
            const ts = data.createdAt?.toDate ? data.createdAt.toDate() : new Date();
            return {
              id: d.id,
              role: (data.role === "user" ? "user" : "model") as "user" | "model",
              content: data.content || "",
              skillUsed: data.skillUsed || "ChatSkill",
              modelUsed: data.modelUsed || "gemini-3.8-flash",
              tokensUsed: data.tokensUsed || 0,
              createdAtLabel: ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
              sortTime: ts.getTime(),
            };
          })
          .sort((a, b) => a.sortTime - b.sortTime);

        if (loaded.length > 0) {
          setMessages(loaded);
        }
      },
      (err) => handleFirestoreError(err, OperationType.LIST, "messages")
    );

    const fileQuery = query(collection(db, "files"), where("userId", "==", user.uid));
    const unsubFiles = onSnapshot(
      fileQuery,
      (snap) => {
        setFirestoreFiles(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, "files")
    );

    const memQuery = query(collection(db, "memories"), where("userId", "==", user.uid));
    const unsubMemories = onSnapshot(
      memQuery,
      (snap) => {
        setFirestoreMemories(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      },
      (err) => handleFirestoreError(err, OperationType.LIST, "memories")
    );

    return () => {
      unsubMessages();
      unsubFiles();
      unsubMemories();
    };
  }, [authReady, user]);

  // Request geolocation when Maps Grounding is toggled on
  const handleToggleMapsGrounding = () => {
    const nextState = !enableMapsGrounding;
    setEnableMapsGrounding(nextState);
    if (nextState && "geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setUserLatLng({
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
          });
        },
        () => {
          // Proceed without coordinates if user declines browser location
        }
      );
    }
  };

  const handleGoogleSignIn = async () => {
    setErrorBanner(null);
    try {
      const res = await googleSignIn();
      setUser(res.user);
      setAccessToken(res.accessToken);
    } catch (err: any) {
      setErrorBanner(err.message || "تعذر تسجيل الدخول باستخدام Google.");
    }
  };

  // File Upload Handler (Documents, Images, Audio, Video)
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 24 * 1024 * 1024) {
      setErrorBanner(
        isAr
          ? "حجم الملف يتجاوز الحد الأقصى المسموح به (24 ميجابايت)."
          : "File size exceeds the 24MB limit."
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const resultStr = String(reader.result || "");
      const base64Data = resultStr.includes(",") ? resultStr.split(",")[1] : resultStr;
      setAttachedFile({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        base64Data,
        sizeBytes: file.size,
        previewUrl: file.type.startsWith("image/") ? resultStr : undefined,
      });
    };
    reader.readAsDataURL(file);
  };

  // Load Generated Sample Structural Blueprint with 1 Click
  const handleLoadSampleBlueprint = async () => {
    setErrorBanner(null);
    try {
      const response = await fetch(SAMPLE_BLUEPRINT_URL);
      const blob = await response.blob();
      const reader = new FileReader();
      reader.onload = () => {
        const resultStr = String(reader.result || "");
        const base64Data = resultStr.includes(",") ? resultStr.split(",")[1] : resultStr;
        setAttachedFile({
          name: "Foundation_Plan_Column_Schedule_SE01.jpg",
          mimeType: "image/jpeg",
          base64Data,
          sizeBytes: blob.size,
          previewUrl: SAMPLE_BLUEPRINT_URL,
        });
        setActiveMenu("engineering");
        setPromptInput(
          isAr
            ? "حلل هذا المخطط الإنشائي للقواعد وجدول الأعمدة، واحسب كميات الخرسانة المسلحة C30/37 وحديد التسليح مع إصدار شيت مقايسة BOQ."
            : "Analyze this structural foundation plan and column schedule, calculate C30/37 concrete volumes and reinforcement steel quantities, and generate a BOQ Excel sheet."
        );
      };
      reader.readAsDataURL(blob);
    } catch (err: any) {
      setErrorBanner("Failed to load sample blueprint image.");
    }
  };

  // Live Microphone Audio Recording for Voice Assistant (gemini-3.5-transcribe)
  const toggleMicrophoneRecording = async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      setIsRecording(false);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      recordedChunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) {
          recordedChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const audioBlob = new Blob(recordedChunksRef.current, { type: "audio/webm" });
        const reader = new FileReader();
        reader.onload = () => {
          const resultStr = String(reader.result || "");
          const base64Data = resultStr.includes(",") ? resultStr.split(",")[1] : resultStr;
          setAttachedFile({
            name: `Voice_Note_${new Date().toLocaleTimeString().replace(/:/g, "-")}.webm`,
            mimeType: "audio/webm",
            base64Data,
            sizeBytes: audioBlob.size,
          });
          setActiveMenu("voice");
        };
        reader.readAsDataURL(audioBlob);
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true);
    } catch (err: any) {
      setErrorBanner(
        isAr
          ? "تعذر الوصول إلى الميكروفون. يرجى السماح بصلاحية الميكروفون في المتصفح."
          : "Microphone access denied. Please allow microphone permissions."
      );
    }
  };

  // Map MenuMode to Explicit Skill
  const getExplicitSkillForMenu = (menu: MenuMode): string | undefined => {
    switch (menu) {
      case "documents":
        return "DocumentSkill";
      case "images":
        return attachedFile?.mimeType.startsWith("video/") ? "VideoSkill" : "ImageSkill";
      case "voice":
        return "VoiceSkill";
      case "word":
        return "WordSkill";
      case "excel":
        return "ExcelSkill";
      case "pdf":
        return "PdfSkill";
      case "ppt":
        return "PowerPointSkill";
      case "data":
        return "DataAnalysisSkill";
      case "engineering":
        return "EngineeringSkill";
      default:
        return undefined;
    }
  };

  // Execute AI Agent Task
  const handleSendTask = async (overridePrompt?: string, overrideMenu?: MenuMode) => {
    const targetMenu = overrideMenu || activeMenu;
    const textToSend = (overridePrompt !== undefined ? overridePrompt : promptInput).trim();

    if (!textToSend && !attachedFile) return;

    setIsProcessing(true);
    setErrorBanner(null);
    setWorkspaceExportNotice(null);

    const userDisplayContent =
      textToSend || (attachedFile ? `[Attached: ${attachedFile.name}]` : "");

    const optimisticUserTurn: ChatTurnUI = {
      id: `user_${Date.now()}`,
      role: "user",
      content: userDisplayContent,
      skillUsed: getExplicitSkillForMenu(targetMenu) || "ChatSkill",
      modelUsed: selectedModel,
      tokensUsed: 0,
      createdAtLabel: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, optimisticUserTurn]);
    setPromptInput("");

    try {
      if (user?.uid) {
        await saveMessageTurn({
          userId: user.uid,
          role: "user",
          content: userDisplayContent,
          skillUsed: optimisticUserTurn.skillUsed,
          modelUsed: selectedModel,
          tokensUsed: 0,
        });
      }

      const historyPayload = messages.slice(-6).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch("/api/agent/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: textToSend,
          language,
          model: selectedModel,
          explicitSkill: getExplicitSkillForMenu(targetMenu),
          history: historyPayload,
          enableMapsGrounding,
          latLng: userLatLng,
          fileBase64: attachedFile?.base64Data,
          fileMimeType: attachedFile?.mimeType,
          fileName: attachedFile?.name,
          synthesizeVoiceReply: enableVoiceReply || targetMenu === "voice",
        }),
      });

      const data = await response.json();
      if (!response.ok || data.error) {
        throw new Error(data.error || "فشل في معالجة الطلب");
      }

      const modelTurn: ChatTurnUI = {
        id: `model_${Date.now()}`,
        role: "model",
        content: data.replyText || "",
        transcript: data.transcript,
        skillUsed: (data.combinedSkills || [data.skillUsed]).join(" + "),
        modelUsed: data.modelUsed || selectedModel,
        tokensUsed: data.tokensUsed || 0,
        createdAtLabel: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        groundingLinks: data.groundingLinks,
        audioReplyBase64: data.audioReplyBase64,
        generatedFile: data.generatedFile,
        parsedDocMeta: data.parsedDocMeta,
      };

      setMessages((prev) => [...prev, modelTurn]);

      if (user?.uid) {
        await saveMessageTurn({
          userId: user.uid,
          role: "model",
          content: modelTurn.content,
          skillUsed: modelTurn.skillUsed,
          modelUsed: modelTurn.modelUsed,
          tokensUsed: modelTurn.tokensUsed,
        });

        if (attachedFile) {
          await saveProcessedFileRecord({
            userId: user.uid,
            fileName: attachedFile.name,
            fileType: attachedFile.mimeType,
            direction: "analyzed",
            summary: modelTurn.content.slice(0, 500),
          });
        }

        if (data.generatedFile) {
          await saveProcessedFileRecord({
            userId: user.uid,
            fileName: data.generatedFile.fileName,
            fileType: data.generatedFile.mimeType,
            direction: "generated",
            summary: modelTurn.content.slice(0, 500),
          });
        }
      }

      setAttachedFile(null);
    } catch (err: any) {
      setErrorBanner(err.message || "عذراً، حدث خطأ أثناء تنفيذ الأمر.");
    } finally {
      setIsProcessing(false);
    }
  };

  // Download Generated Binary Artifact (DOCX, XLSX, PDF, PPTX)
  const downloadGeneratedArtifact = (file: {
    fileName: string;
    mimeType: string;
    base64Data: string;
  }) => {
    const byteCharacters = atob(file.base64Data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: file.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Export Generated Artifact directly to Google Workspace (Docs, Sheets, Slides) with Mandatory Confirmation
  const handleExportToWorkspace = (
    target: "docs" | "sheets" | "slides",
    turn: ChatTurnUI
  ) => {
    if (!accessToken) {
      handleGoogleSignIn();
      return;
    }

    const spec = turn.generatedFile?.structuredSpec || {};
    const title = spec.title || turn.generatedFile?.fileName || "Mr. Hany AI Export";

    setConfirmDialog({
      open: true,
      title: isAr
        ? `تأكيد التصدير إلى Google ${target === "docs" ? "Docs" : target === "sheets" ? "Sheets" : "Slides"}`
        : `Confirm Export to Google ${target === "docs" ? "Docs" : target === "sheets" ? "Sheets" : "Slides"}`,
      description: isAr
        ? `سيقوم مستر هاني بإنشاء ملف جديد بعنوان "${title}" داخل حساب Google Workspace الخاص بك.`
        : `Mr. Hany will create a new file titled "${title}" in your Google Workspace account.`,
      onConfirm: async () => {
        try {
          if (target === "docs") {
            const res = await GoogleWorkspaceService.createGoogleDoc(title, turn.content);
            setWorkspaceExportNotice({
              message: isAr ? "تم التصدير إلى Google Docs بنجاح!" : "Exported to Google Docs!",
              url: res.url,
            });
          } else if (target === "sheets") {
            const res = await GoogleWorkspaceService.createGoogleSheet({
              title,
              sheetName: spec.sheetName || "Data",
              headers: spec.headers || ["Column 1", "Column 2"],
              rows: spec.rows || [[turn.content]],
            });
            setWorkspaceExportNotice({
              message: isAr ? "تم التصدير إلى Google Sheets بنجاح!" : "Exported to Google Sheets!",
              url: res.url,
            });
          } else if (target === "slides") {
            const res = await GoogleWorkspaceService.createGoogleSlides({
              title,
              slides: spec.slides || [
                {
                  slideTitle: title,
                  bullets: turn.content.split("\n").filter(Boolean).slice(0, 6),
                },
              ],
            });
            setWorkspaceExportNotice({
              message: isAr ? "تم التصدير إلى Google Slides بنجاح!" : "Exported to Google Slides!",
              url: res.url,
            });
          }
        } catch (err: any) {
          setErrorBanner(err.message || "فشل التصدير إلى Google Workspace");
        }
      },
    });
  };

  const totalTokensConsumed = messages.reduce((acc, m) => acc + (m.tokensUsed || 0), 0);

  const sidebarMenus: Array<{ id: MenuMode; label: string; icon: any }> = [
    { id: "chat", label: t.menus.chat, icon: MessageSquare },
    { id: "documents", label: t.menus.documents, icon: FileText },
    { id: "images", label: t.menus.images, icon: ImageIcon },
    { id: "voice", label: t.menus.voice, icon: Mic },
    { id: "word", label: t.menus.word, icon: FileCheck },
    { id: "excel", label: t.menus.excel, icon: FileSpreadsheet },
    { id: "pdf", label: t.menus.pdf, icon: Layers },
    { id: "ppt", label: t.menus.ppt, icon: Presentation },
    { id: "data", label: t.menus.data, icon: BarChart3 },
    { id: "engineering", label: t.menus.engineering, icon: Compass },
    { id: "history", label: t.menus.history, icon: History },
    { id: "settings", label: t.menus.settings, icon: Settings },
    { id: "help", label: t.menus.help, icon: HelpCircle },
  ];

  return (
    <div className="min-h-screen bg-slate-50 pb-20 md:pb-8 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <OfflineIndicator language={language} />

      {/* STRICT 3-ZONE TOP BAR CONTRACT */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur-xs md:gap-8 md:px-6 md:py-4 dark:border-slate-800 dark:bg-slate-900/95">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#assistant"
          onClick={(e) => {
            e.preventDefault();
            setTopSection("assistant");
          }}
          className="text-base md:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 dark:text-slate-100"
        >
          {t.brandTitle}
        </a>

        {/* Zone 2: 5 concise single-line text navigation links */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400">
          <button
            type="button"
            onClick={() => setTopSection("assistant")}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              topSection === "assistant"
                ? "text-slate-900 underline underline-offset-8 dark:text-slate-100"
                : ""
            }`}
          >
            {t.navAssistant}
          </button>
          <button
            type="button"
            onClick={() => {
              setTopSection("assistant");
              setActiveMenu("engineering");
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              topSection === "assistant" && activeMenu === "engineering"
                ? "text-slate-900 underline underline-offset-8 dark:text-slate-100"
                : ""
            }`}
          >
            {t.navEngineering}
          </button>
          <button
            type="button"
            onClick={() => setTopSection("workspace")}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              topSection === "workspace"
                ? "text-slate-900 underline underline-offset-8 dark:text-slate-100"
                : ""
            }`}
          >
            {t.navWorkspace}
          </button>
          <button
            type="button"
            onClick={() => setTopSection("telegram")}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              topSection === "telegram"
                ? "text-slate-900 underline underline-offset-8 dark:text-slate-100"
                : ""
            }`}
          >
            {t.navTelegram}
          </button>
          <button
            type="button"
            onClick={() => setTopSection("admin")}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 ${
              topSection === "admin"
                ? "text-slate-900 underline underline-offset-8 dark:text-slate-100"
                : ""
            }`}
          >
            {t.navAdmin}
          </button>
        </nav>

        {/* Zone 3: 1 primary action (Official Sign in with Google button or Sign Out) */}
        <div className="flex items-center gap-2.5 shrink-0">
          {!user ? (
            <button
              type="button"
              onClick={handleGoogleSignIn}
              className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 md:px-4 md:py-2 text-xs font-semibold text-slate-800 shadow-2xs transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700"
            >
              <svg className="h-4 w-4 shrink-0" viewBox="0 0 48 48">
                <path
                  fill="#EA4335"
                  d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                />
                <path
                  fill="#4285F4"
                  d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                />
                <path
                  fill="#FBBC05"
                  d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                />
                <path
                  fill="#34A853"
                  d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                />
              </svg>
              <span>{t.signInGoogle}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={logout}
              className="rounded-lg bg-slate-900 px-3 py-1.5 md:px-4 md:py-2 text-xs font-medium text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
            >
              {user.displayName || user.email} · {t.signOut}
            </button>
          )}
        </div>
      </header>

      {/* SECONDARY WORKSPACE UTILITY BAR (PWA Install Button, Phone Frame Toggle, Language, Theme, Model Selector) */}
      <div className="border-b border-slate-200 bg-slate-100/70 px-4 py-2.5 md:px-6 dark:border-slate-800 dark:bg-slate-900/60">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="relative h-9 w-9 overflow-hidden rounded-xl border border-slate-300 bg-slate-900 shrink-0 dark:border-slate-700">
              <img
                src={MR_HANY_APP_LOGO_URL}
                alt="Mr. Hany Official App Icon"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
            </div>
            <div className="relative h-8 w-8 md:h-9 md:w-9 overflow-hidden rounded-full border border-slate-300 bg-slate-200 shrink-0 dark:border-slate-700">
              <img
                src={MR_HANY_AVATAR_URL}
                alt="Mr. Hany AI Executive Advisor"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
            </div>
            <div className="text-xs text-slate-600 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-slate-100">Mr. Hany AI</span>
              <span className="mx-1.5">·</span>
              <span>{selectedModel}</span>
              <span className="hidden sm:inline mx-1.5">·</span>
              <span className="hidden sm:inline font-mono tabular-nums">{totalTokensConsumed} tokens</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* In-App PWA Install Button (Mandatory) */}
            <PWAInstallButton language={language} compact />

            {/* Mobile Phone View Simulator Toggle (Desktop Helper) */}
            <button
              type="button"
              onClick={() => setMobilePhonePreview(!mobilePhonePreview)}
              className={`hidden md:inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                mobilePhonePreview
                  ? "border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              }`}
            >
              {mobilePhonePreview ? (
                <>
                  <Monitor className="h-3.5 w-3.5" />
                  <span>{isAr ? "عرض الشاشة الكاملة" : "Full Screen View"}</span>
                </>
              ) : (
                <>
                  <Smartphone className="h-3.5 w-3.5" />
                  <span>{isAr ? "واجهة تطبيق الهاتف" : "Mobile App View"}</span>
                </>
              )}
            </button>

            {/* Model Selector */}
            <select
              aria-label="Select Gemini Model"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value as any)}
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
              <option value="gemini-4-argon">Gemini 4 Argon (paid-tier model)</option>
              <option value="gemini-3.1-flash-lite">Gemini 3.1 Lite (Fast)</option>
            </select>

            {/* Language Switcher */}
            <button
              type="button"
              onClick={() => setLanguage(language === "ar" ? "en" : "ar")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              <Globe className="h-3.5 w-3.5" />
              <span>{language === "ar" ? "EN" : "عربي"}</span>
            </button>

            {/* Light / Dark Mode Switcher */}
            <button
              type="button"
              onClick={() => setDarkMode(!darkMode)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              aria-label="Toggle Theme"
            >
              {darkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">
                {darkMode ? (isAr ? "نهاري" : "Light") : (isAr ? "ليلي" : "Dark")}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* MAIN CONTAINER (Supports Full 1440px Responsive or Dedicated Mobile App Shell Preview) */}
      <main
        className={`mx-auto transition-all ${
          mobilePhonePreview
            ? "my-6 max-w-[430px] rounded-[36px] border-[8px] border-slate-900 bg-slate-50 p-3 shadow-2xl dark:border-slate-800 dark:bg-slate-950"
            : "max-w-[1440px] px-3 py-4 md:px-6 md:py-6"
        }`}
      >
        <MobileAppInstallCard language={language} />
        {errorBanner && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-xs md:text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
            <span>{errorBanner}</span>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="text-xs font-semibold underline"
            >
              {isAr ? "إغلاق" : "Dismiss"}
            </button>
          </div>
        )}

        {workspaceExportNotice && (
          <div className="mb-4 flex items-center justify-between rounded-xl border border-emerald-300 bg-emerald-50 px-4 py-3 text-xs md:text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
            <span>{workspaceExportNotice.message}</span>
            {workspaceExportNotice.url && (
              <a
                href={workspaceExportNotice.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-bold underline"
              >
                <span>{isAr ? "فتح في Google Workspace" : "Open in Google Workspace"}</span>
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}

        {/* VIEW 1: GOOGLE WORKSPACE HUB */}
        {topSection === "workspace" && (
          <WorkspaceHub
            language={language}
            userId={user?.uid || null}
            hasAccessToken={Boolean(accessToken)}
            onRequireSignIn={handleGoogleSignIn}
            memories={firestoreMemories}
          />
        )}

        {/* VIEW 2: TELEGRAM BOT BRIDGE */}
        {topSection === "telegram" && (
          <TelegramBridgePanel
            language={language}
            telegramStatus={telegramStatus}
            adminSecret={adminSecret}
            onAdminSecretChange={setAdminSecret}
            onConnectToken={async (token) => {
              const res = await fetch("/api/telegram/connect", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminSecret}` },
                body: JSON.stringify({ token }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Telegram connection failed");
              if (data.status) setTelegramStatus(data.status);
            }}
            onRefreshStatus={async () => {
              const res = await fetch("/api/admin/telegram/status", {
                headers: { Authorization: `Bearer ${adminSecret}` },
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Unable to refresh Telegram status");
              if (data.telegram) setTelegramStatus(data.telegram);
            }}
            onTriggerCommand={(cmd) => {
              setTopSection("assistant");
              if (cmd === "/clear") {
                setMessages([]);
                return;
              }
              if (cmd === "/word") setActiveMenu("word");
              else if (cmd === "/excel") setActiveMenu("excel");
              else if (cmd === "/pdf") setActiveMenu("pdf");
              else if (cmd === "/ppt") setActiveMenu("ppt");
              else if (cmd === "/document") setActiveMenu("documents");
              else if (cmd === "/image") setActiveMenu("images");
              else if (cmd === "/voice") setActiveMenu("voice");
              else if (cmd === "/history") setActiveMenu("history");
              else if (cmd === "/settings") setActiveMenu("settings");
              else if (cmd === "/help") setActiveMenu("help");
              else setActiveMenu("chat");
            }}
          />
        )}

        {/* VIEW 3: ADMIN DASHBOARD */}
        {topSection === "admin" && (
          <AdminDashboardPanel
            language={language}
            isAdmin={user?.email === "haniba991@gmail.com"}
            totalMessages={messages.length}
            totalFiles={firestoreFiles.length}
            totalMemories={firestoreMemories.length}
            totalTokens={totalTokensConsumed}
            skills={skillsRegistry}
            adminSecret={adminSecret}
            onAdminSecretChange={setAdminSecret}
            onRunAudit={async (secret) => {
              const res = await fetch("/api/audit/run", {
                method: "POST",
                headers: { Authorization: `Bearer ${secret}` },
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Audit failed");
              return data;
            }}
            onToggleSkill={async (skillId, enabled) => {
              if (!adminSecret) throw new Error(isAr ? "أدخل سر الإدارة أولاً." : "Enter the admin secret first.");
              const res = await fetch("/api/admin/skills/toggle", {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminSecret}` },
                body: JSON.stringify({ skillId, enabled }),
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || "Skill update failed");
              if (data.skills) setSkillsRegistry(data.skills);
            }}
          />
        )}

        {/* VIEW 4: PRIMARY MODULAR AI ASSISTANT & 13 TELEGRAM MENU MODULES */}
        {topSection === "assistant" && (
          <div className={mobilePhonePreview ? "flex flex-col space-y-4" : "grid grid-cols-1 gap-6 lg:grid-cols-12"}>
            {/* Mobile Horizontal Touch-Scrollable 13-Skill Strip (Visible on Mobile & Phone Preview) */}
            <div className={mobilePhonePreview ? "block" : "block lg:hidden"}>
              <div className="flex items-center gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-white p-2.5 dark:border-slate-800 dark:bg-slate-900">
                {sidebarMenus.map((item) => {
                  const Icon = item.icon;
                  const isActive = activeMenu === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveMenu(item.id)}
                      className={`inline-flex min-h-[42px] items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                        isActive
                          ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Desktop Sidebar: 13 Interactive Telegram Bot Menu Modules */}
            {!mobilePhonePreview && (
              <aside className="hidden lg:block lg:col-span-3">
                <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                  <div className="mb-3 px-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                    {t.menuTitle}
                  </div>
                  <div className="space-y-1">
                    {sidebarMenus.map((item) => {
                      const Icon = item.icon;
                      const isActive = activeMenu === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setActiveMenu(item.id)}
                          className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                            isActive
                              ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                              : "text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                          }`}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </aside>
            )}

            {/* Main Workspace Viewport */}
            <section className={mobilePhonePreview ? "flex flex-col space-y-4" : "lg:col-span-9 flex flex-col space-y-6"}>
              {/* Sub-View A: History & Persistent Memory Module (Menu #11) */}
              {activeMenu === "history" && (
                <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-6 dark:border-slate-800 dark:bg-slate-900">
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 pb-4 dark:border-slate-800">
                    <div>
                      <h2 className="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">
                        {isAr ? "سجل المحادثات والملفات والذاكرة الدائمة" : "Conversation History, Files & Persistent Memory"}
                      </h2>
                      <p className="text-xs text-slate-500">
                        {isAr
                          ? "ذاكرة مستقلة ومؤمنة لكل مستخدم مع إمكانية المراجعة والحذف الفوري."
                          : "Isolated per-user memory backed by Firestore with instant review and deletion."}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        setConfirmDialog({
                          open: true,
                          title: isAr ? "مسح سجل المحادثة بالكامل" : "Clear Conversation History",
                          description: isAr
                            ? "سيتم حذف سجل الرسائل الحالي من الجلسة وقاعدة البيانات. هل تود المتابعة؟"
                            : "This will delete your stored conversation history. Proceed?",
                          isDestructive: true,
                          onConfirm: async () => {
                            if (user?.uid) {
                              await clearUserMessageHistory(user.uid);
                            }
                            setMessages([]);
                          },
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50 whitespace-nowrap shrink-0 dark:border-red-800 dark:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>{t.clearContext}</span>
                    </button>
                  </div>

                  <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {isAr ? "الملفات المحللة والمولدة مؤخراً" : "Recent Analyzed & Generated Files"}
                      </h3>
                      <div className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
                        {firestoreFiles.length === 0 ? (
                          <p className="py-6 text-xs text-slate-500">
                            {isAr ? "لا توجد ملفات مسجلة بعد." : "No file records yet."}
                          </p>
                        ) : (
                          firestoreFiles.map((f) => (
                            <div key={f.id} className="py-3">
                              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                {f.fileName}
                              </div>
                              <div className="mt-0.5 text-xs text-slate-500">
                                <span>{f.direction}</span>
                                <span className="mx-1.5">·</span>
                                <span>{f.fileType}</span>
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs text-slate-600 dark:text-slate-400">
                                {f.summary}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {isAr ? "المعلومات والتفضيلات المحفوظة" : "Stored User Preferences & Memories"}
                      </h3>
                      <div className="mt-3 divide-y divide-slate-200 dark:divide-slate-800">
                        {firestoreMemories.length === 0 ? (
                          <p className="py-6 text-xs text-slate-500">
                            {isAr ? "لا توجد ملاحظات محفوظة." : "No saved memories."}
                          </p>
                        ) : (
                          firestoreMemories.map((m) => (
                            <div key={m.id} className="py-3">
                              <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                                {m.title}
                              </div>
                              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
                                {m.content}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Sub-View B: Settings Module (Menu #12) */}
              {activeMenu === "settings" && (
                <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-6 dark:border-slate-800 dark:bg-slate-900">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">
                      {isAr ? "إعدادات مستر هاني وتطبيق الهاتف (PWA)" : "Mr. Hany Preferences & Mobile App (PWA)"}
                    </h2>
                    <PWAInstallButton language={language} />
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                        {isAr ? "اللغة الافتراضية" : "Default Language"}
                      </label>
                      <select
                        value={language}
                        onChange={(e) => setLanguage(e.target.value as Language)}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                      >
                        <option value="ar">العربية (Arabic - Default)</option>
                        <option value="en">English</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                        {isAr ? "فترة الاحتفاظ بالذاكرة (بالأيام)" : "Memory Retention Policy (Days)"}
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={365}
                        value={memoryRetentionDays}
                        onChange={(e) => setMemoryRetentionDays(Number(e.target.value))}
                        className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                      />
                    </div>
                  </div>
                  {user && (
                    <button
                      type="button"
                      onClick={async () => {
                        await updateUserPreferences(user.uid, {
                          displayName: user.displayName || "User",
                          language,
                          preferredModel: selectedModel,
                          memoryRetentionDays,
                        });
                      }}
                      className="mt-4 rounded-lg bg-sky-600 px-4 py-2 text-xs font-semibold text-white hover:bg-sky-700 whitespace-nowrap shrink-0"
                    >
                      {isAr ? "حفظ الإعدادات في Firestore" : "Save Preferences to Firestore"}
                    </button>
                  )}
                </div>
              )}

              {/* Sub-View C: Help & Guide Module (Menu #13) */}
              {activeMenu === "help" && (
                <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-6 dark:border-slate-800 dark:bg-slate-900">
                  <h2 className="text-base md:text-lg font-bold text-slate-900 dark:text-slate-100">
                    {isAr ? "دليل استخدام منصة مستر هاني (Mr. Hany AI)" : "Mr. Hany Complete Feature & Architecture Guide"}
                  </h2>
                  <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {isAr ? "1. تحليل المخططات الهندسية وحصر الكميات" : "1. Engineering Assistant & BOQ"}
                      </div>
                      <p className="mt-1">
                        {isAr
                          ? "ارفع صورة المخطط الإنشائي أو التقط صورة مباشرة بكاميرا الهاتف ليقوم مستر هاني بقراءة الجداول والأبعاد وحساب كميات الخرسانة والحديد وتوليد شيت Excel للمقايسة تلقائياً."
                          : "Upload or snap a photo of structural drawings to extract dimensions, compute concrete (m³) and rebar (Tons) quantities, and automatically generate an Excel BOQ sheet."}
                      </p>
                    </div>
                    <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
                      <div className="font-semibold text-slate-900 dark:text-slate-100">
                        {isAr ? "2. توليد الملفات الديناميكي بالذكاء الاصطناعي" : "2. Dynamic AI File Generation"}
                      </div>
                      <p className="mt-1">
                        {isAr
                          ? "اطلب باللغة العربية أو الإنجليزية إنشاء أي ملف Excel بمعادلات حقيقية، أو تقرير Word مفصل، أو تقرير PDF رسمي بجداول وملاحظات، أو عرض PowerPoint."
                          : "Request any custom Excel spreadsheet with live formulas, Word inspection report, PDF report with tables & notes, or PowerPoint deck."}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Primary Conversational & Multimodal Stream */}
              <div className="rounded-xl border border-slate-200 bg-white p-4 md:p-6 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3.5 dark:border-slate-800">
                  <div>
                    <h2 className="text-sm md:text-base font-bold text-slate-900 dark:text-slate-100">
                      {sidebarMenus.find((m) => m.id === activeMenu)?.label}
                    </h2>
                    <div className="mt-0.5 text-xs text-slate-500">
                      <span>{selectedModel}</span>
                      <span className="mx-1.5">·</span>
                      <span>{isAr ? "يدعم العربية والإنجليزية" : "Arabic & English Supported"}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Quick Action for Engineering / Image Blueprint Sample */}
                    {(activeMenu === "engineering" || activeMenu === "images") && (
                      <button
                        type="button"
                        onClick={handleLoadSampleBlueprint}
                        className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-1.5 text-xs font-semibold text-sky-800 hover:bg-sky-100 whitespace-nowrap shrink-0 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-300"
                      >
                        {t.loadSampleBlueprint}
                      </button>
                    )}

                    {/* Google Maps Grounding Toggle */}
                    <button
                      type="button"
                      onClick={handleToggleMapsGrounding}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        enableMapsGrounding
                          ? "border-emerald-600 bg-emerald-600 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      <MapPin className="h-3.5 w-3.5" />
                      <span>{t.mapsGroundingLabel}</span>
                    </button>

                    {/* Spoken Audio Reply Toggle */}
                    <button
                      type="button"
                      onClick={() => setEnableVoiceReply(!enableVoiceReply)}
                      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                        enableVoiceReply
                          ? "border-sky-600 bg-sky-600 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                      }`}
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                      <span>{t.voiceReplyLabel}</span>
                    </button>
                  </div>
                </div>

                {/* Quick Mobile Prompts for Dynamic File Generation */}
                {(activeMenu === "excel" ||
                  activeMenu === "word" ||
                  activeMenu === "pdf" ||
                  activeMenu === "ppt") && (
                  <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">
                    {activeMenu === "excel" && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            handleSendTask(
                              isAr
                                ? "أنشئ شيت إكسل لرواتب الموظفين الشهرية مع معادلات إجمالي الراتب والخصومات وصافي الراتب"
                                : "Create an Excel sheet for monthly employee salaries with formulas for total salary and deductions.",
                              "excel"
                            )
                          }
                          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
                        >
                          {isAr ? "⚡ شيت رواتب الموظفين بالمعادلات" : "⚡ Monthly Salaries Excel"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleSendTask(
                              isAr
                                ? "أنشئ شيت إكسل لحساب كميات حديد التسليح بمعادلة وزن المتر الطولي D^2/162"
                                : "Create an Excel sheet for calculating reinforcement steel quantities.",
                              "excel"
                            )
                          }
                          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
                        >
                          {isAr ? "⚡ شيت حصر حديد التسليح" : "⚡ Rebar Quantities Excel"}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleSendTask(
                              isAr
                                ? "أنشئ شيت إكسل لحساب كميات الخرسانة للقواعد والأعمدة"
                                : "Create an Excel sheet for concrete quantity calculations.",
                              "excel"
                            )
                          }
                          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
                        >
                          {isAr ? "⚡ شيت حصر كميات الخرسانة" : "⚡ Concrete Quantities Excel"}
                        </button>
                      </>
                    )}
                    {activeMenu === "word" && (
                      <button
                        type="button"
                        onClick={() =>
                          handleSendTask(
                            isAr
                              ? "أنشئ تقرير وورد احترافي عن ملاحظات وعيوب الأعمال الخشبية في الغرفة 901 مع جدول الفحص والتوصيات"
                              : "Create a professional Word report about woodworking defects in room 901.",
                            "word"
                          )
                        }
                        className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
                      >
                        {isAr ? "⚡ تقرير فحص الغرفة 901 (Word)" : "⚡ Room 901 Defects Word Report"}
                      </button>
                    )}
                    {activeMenu === "pdf" && (
                      <button
                        type="button"
                        onClick={() =>
                          handleSendTask(
                            isAr
                              ? "أنشئ تقرير PDF رسمي يحتوي على جدول فحص هندسي وقسم للملاحظات والتوصيات"
                              : "Create a PDF report containing an inspection table and a notes section.",
                            "pdf"
                          )
                        }
                        className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300"
                      >
                        {isAr ? "⚡ تقرير فحص وجدول ملاحظات (PDF)" : "⚡ Inspection Table & Notes PDF"}
                      </button>
                    )}
                  </div>
                )}

                {/* Messages Viewport */}
                <div className="mt-4 max-h-[480px] md:max-h-[520px] space-y-4 overflow-y-auto pr-1">
                  {messages.map((turn) => (
                    <div
                      key={turn.id}
                      className={`rounded-xl border p-3.5 md:p-4 ${
                        turn.role === "user"
                          ? "border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950"
                          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                      }`}
                    >
                      {/* Clean Unboxed Metadata Header (Zero-Pill Rule) */}
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
                        <div>
                          <span className="font-semibold text-slate-900 dark:text-slate-100">
                            {turn.role === "user"
                              ? user?.displayName || (isAr ? "أنت" : "You")
                              : isAr
                              ? "مستر هاني (Mr. Hany)"
                              : "Mr. Hany AI"}
                          </span>
                          <span className="mx-1.5">·</span>
                          <span>{turn.skillUsed}</span>
                          <span className="mx-1.5">·</span>
                          <span>{turn.modelUsed}</span>
                          {turn.tokensUsed > 0 && (
                            <>
                              <span className="mx-1.5">·</span>
                              <span className="font-mono tabular-nums">{turn.tokensUsed} tok</span>
                            </>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          {turn.role === "model" && user?.uid && (
                            <button
                              type="button"
                              onClick={async () => {
                                await createMemoryItem({
                                  userId: user.uid,
                                  category: activeMenu === "engineering" ? "engineering" : "note",
                                  title: turn.content.slice(0, 60).replace(/[#*]/g, "").trim() || "Saved Insight",
                                  content: turn.content.slice(0, 2500),
                                });
                                setWorkspaceExportNotice({
                                  message: isAr ? "تم حفظ المعلومة في الذاكرة الدائمة." : "Saved to persistent memory.",
                                });
                              }}
                              className="text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
                            >
                              {isAr ? "حفظ في الذاكرة" : "Save to Memory"}
                            </button>
                          )}
                          <span className="font-mono tabular-nums">{turn.createdAtLabel}</span>
                        </div>
                      </div>

                      {/* Voice Transcript Box if present */}
                      {turn.transcript && (
                        <div className="mt-3 rounded-lg bg-slate-100 p-3 text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200">
                          <span className="font-semibold">
                            {isAr ? "النص المفرغ صوتياً (gemini-3.5-transcribe): " : "Audio Transcript: "}
                          </span>
                          <span>{turn.transcript}</span>
                        </div>
                      )}

                      {/* Main Message Content */}
                      <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-800 dark:text-slate-200">
                        {turn.content}
                      </div>

                      {/* Parsed Document Chunk & Table Preview */}
                      {turn.parsedDocMeta && (
                        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                          <span>{turn.parsedDocMeta.fileName}</span>
                          <span className="mx-2">·</span>
                          <span className="font-mono tabular-nums">
                            {turn.parsedDocMeta.totalCharacters.toLocaleString()} chars
                          </span>
                          <span className="mx-2">·</span>
                          <span className="font-mono tabular-nums">
                            {turn.parsedDocMeta.chunkCount} chunks processed
                          </span>
                        </div>
                      )}

                      {/* Audio TTS Reply Player */}
                      {turn.audioReplyBase64 && (
                        <div className="mt-4">
                          <audio
                            controls
                            src={`data:audio/wav;base64,${turn.audioReplyBase64}`}
                            className="h-9 w-full max-w-md"
                          />
                        </div>
                      )}

                      {/* Generated File Download & 1-Click Google Workspace Export */}
                      {turn.generatedFile && (
                        <div className="mt-4 flex flex-wrap items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
                          <button
                            type="button"
                            onClick={() => downloadGeneratedArtifact(turn.generatedFile!)}
                            className="inline-flex min-h-[40px] items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 whitespace-nowrap shrink-0 dark:bg-slate-100 dark:text-slate-900"
                          >
                            <Download className="h-3.5 w-3.5" />
                            <span>
                              {t.downloadFile}: {turn.generatedFile.fileName}
                            </span>
                          </button>

                          {turn.generatedFile.fileName.endsWith(".docx") && (
                            <button
                              type="button"
                              onClick={() => handleExportToWorkspace("docs", turn)}
                              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-sky-600 px-3 py-2 text-xs font-semibold text-sky-600 hover:bg-sky-50 whitespace-nowrap shrink-0 dark:text-sky-400 dark:hover:bg-sky-950/40"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              <span>{t.exportToGoogleDocs}</span>
                            </button>
                          )}

                          {turn.generatedFile.fileName.endsWith(".xlsx") && (
                            <button
                              type="button"
                              onClick={() => handleExportToWorkspace("sheets", turn)}
                              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-emerald-600 px-3 py-2 text-xs font-semibold text-emerald-600 hover:bg-emerald-50 whitespace-nowrap shrink-0 dark:text-emerald-400 dark:hover:bg-emerald-950/40"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              <span>{t.exportToGoogleSheets}</span>
                            </button>
                          )}

                          {turn.generatedFile.fileName.endsWith(".pptx") && (
                            <button
                              type="button"
                              onClick={() => handleExportToWorkspace("slides", turn)}
                              className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-amber-600 px-3 py-2 text-xs font-semibold text-amber-600 hover:bg-amber-50 whitespace-nowrap shrink-0 dark:text-amber-400 dark:hover:bg-amber-950/40"
                            >
                              <ExternalLink className="h-3.5 w-3.5" />
                              <span>{t.exportToGoogleSlides}</span>
                            </button>
                          )}
                        </div>
                      )}

                      {/* Google Maps & Web Grounding Citations */}
                      {turn.groundingLinks && turn.groundingLinks.length > 0 && (
                        <div className="mt-4 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
                          <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                            {isAr ? "المصادر والمواقع الموثقة من خرائط Google:" : "Verified Google Maps & Web Grounding Sources:"}
                          </div>
                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                            {turn.groundingLinks.map((link, idx) => (
                              <div
                                key={idx}
                                className="rounded-lg border border-slate-200 p-2.5 text-xs dark:border-slate-800"
                              >
                                <a
                                  href={link.uri}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1.5 font-semibold text-sky-600 hover:underline dark:text-sky-400"
                                >
                                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                                  <span>{link.title}</span>
                                  <ExternalLink className="h-3 w-3 shrink-0" />
                                </a>
                                {link.reviewSnippets && link.reviewSnippets.length > 0 && (
                                  <p className="mt-1 text-slate-500">
                                    "{link.reviewSnippets[0]}"
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                  {isProcessing && (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                      {t.processing}
                    </div>
                  )}
                </div>

                {/* Attached File Preview Strip */}
                {attachedFile && (
                  <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-sky-200 bg-sky-50/70 px-4 py-2.5 dark:border-sky-900 dark:bg-sky-950/40">
                    <div className="flex items-center gap-3">
                      {attachedFile.previewUrl && (
                        <img
                          src={attachedFile.previewUrl}
                          alt={attachedFile.name}
                          referrerPolicy="no-referrer"
                          className="h-10 w-10 rounded object-cover"
                        />
                      )}
                      <div className="text-xs">
                        <div className="font-semibold text-slate-900 dark:text-slate-100">
                          {attachedFile.name}
                        </div>
                        <div className="font-mono tabular-nums text-slate-500">
                          {attachedFile.mimeType} · {(attachedFile.sizeBytes / 1024).toFixed(1)} KB
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setAttachedFile(null)}
                      className="text-xs font-semibold text-red-600 hover:underline dark:text-red-400"
                    >
                      {isAr ? "إزالة المرفق" : "Remove"}
                    </button>
                  </div>
                )}

                {/* Input Composer Bar (Supports Text, File Upload, Mobile Camera Capture, Video Upload, and Live Microphone Recording) */}
                <div className="mt-4 space-y-3 border-t border-slate-200 pt-4 dark:border-slate-800">
                  <textarea
                    rows={3}
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendTask();
                      }
                    }}
                    placeholder={
                      (t.placeholders as any)[activeMenu] || t.placeholders.chat
                    }
                    className="w-full rounded-xl border border-slate-300 bg-white p-3.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-600 focus:outline-hidden dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
                  />

                  <div className="flex flex-wrap items-center justify-between gap-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* Multimodal Document / Image / Audio / Video Upload */}
                      <label className="inline-flex min-h-[42px] cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        <Upload className="h-3.5 w-3.5" />
                        <span>{isAr ? "رفع ملف / صورة" : "Upload File"}</span>
                        <input
                          type="file"
                          accept=".pdf,.docx,.xlsx,.csv,.txt,image/*,audio/*,video/*"
                          onChange={handleFileUpload}
                          className="hidden"
                        />
                      </label>

                      {/* Direct Phone Camera Capture (For Site Inspections & Engineering Drawings on Mobile) */}
                      <label className="inline-flex min-h-[42px] cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        <Camera className="h-3.5 w-3.5" />
                        <span>{isAr ? "كاميرا الهاتف" : "Camera"}</span>
                        <input
                          type="file"
                          accept="image/*"
                          capture="environment"
                          onChange={handleFileUpload}
                          className="hidden"
                        />
                      </label>

                      {/* Dedicated Video Upload Button */}
                      <label className="inline-flex min-h-[42px] cursor-pointer items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        <Video className="h-3.5 w-3.5" />
                        <span>{isAr ? "فيديو" : "Video"}</span>
                        <input
                          type="file"
                          accept="video/mp4,video/webm,video/quicktime"
                          onChange={(e) => {
                            setActiveMenu("images");
                            handleFileUpload(e);
                          }}
                          className="hidden"
                        />
                      </label>

                      {/* Live Microphone Audio Recording Button */}
                      <button
                        type="button"
                        onClick={toggleMicrophoneRecording}
                        className={`inline-flex min-h-[42px] items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                          isRecording
                            ? "bg-red-600 text-white hover:bg-red-700"
                            : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                        }`}
                      >
                        {isRecording ? (
                          <>
                            <MicOff className="h-3.5 w-3.5" />
                            <span>{isAr ? "إيقاف التسجيل" : "Stop"}</span>
                          </>
                        ) : (
                          <>
                            <Mic className="h-3.5 w-3.5" />
                            <span>{isAr ? "تسجيل صوتي" : "Voice"}</span>
                          </>
                        )}
                      </button>
                    </div>

                    <button
                      type="button"
                      disabled={isProcessing || (!promptInput.trim() && !attachedFile)}
                      onClick={() => handleSendTask()}
                      className="inline-flex min-h-[42px] items-center gap-2 rounded-lg bg-sky-600 px-5 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      <Send className="h-3.5 w-3.5" />
                      <span>{t.sendBtn}</span>
                    </button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}
      </main>

      {/* MOBILE BOTTOM NAVIGATION BAR (Native Phone App Ergonomics, >= 48px Touch Targets) */}
      <nav
        aria-label="Mobile Bottom Navigation"
        className={`${
          mobilePhonePreview
            ? "mx-auto max-w-[430px] rounded-b-[28px]"
            : "fixed bottom-0 left-0 right-0 md:hidden"
        } z-40 flex items-center justify-around border-t border-slate-200 bg-white/95 px-2 py-1.5 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95`}
      >
        <button
          type="button"
          onClick={() => {
            setTopSection("assistant");
            setActiveMenu("chat");
          }}
          className={`flex min-h-[48px] flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold transition-colors ${
            topSection === "assistant" &&
            activeMenu !== "engineering" &&
            activeMenu !== "excel" &&
            activeMenu !== "word" &&
            activeMenu !== "pdf" &&
            activeMenu !== "ppt"
              ? "text-sky-600 dark:text-sky-400"
              : "text-slate-500 dark:text-slate-400"
          }`}
        >
          <MessageSquare className="h-5 w-5" />
          <span>{isAr ? "المحادثة" : "Chat"}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setTopSection("assistant");
            if (
              activeMenu !== "excel" &&
              activeMenu !== "word" &&
              activeMenu !== "pdf" &&
              activeMenu !== "ppt"
            ) {
              setActiveMenu("excel");
            }
          }}
          className={`flex min-h-[48px] flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold transition-colors ${
            topSection === "assistant" &&
            (activeMenu === "excel" ||
              activeMenu === "word" ||
              activeMenu === "pdf" ||
              activeMenu === "ppt")
              ? "text-sky-600 dark:text-sky-400"
              : "text-slate-500 dark:text-slate-400"
          }`}
        >
          <FileSpreadsheet className="h-5 w-5" />
          <span>{isAr ? "توليد ملفات" : "Files"}</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setTopSection("assistant");
            setActiveMenu("engineering");
          }}
          className={`flex min-h-[48px] flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold transition-colors ${
            topSection === "assistant" && activeMenu === "engineering"
              ? "text-sky-600 dark:text-sky-400"
              : "text-slate-500 dark:text-slate-400"
          }`}
        >
          <Compass className="h-5 w-5" />
          <span>{isAr ? "الهندسة" : "Engineering"}</span>
        </button>

        <button
          type="button"
          onClick={() => setTopSection("workspace")}
          className={`flex min-h-[48px] flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold transition-colors ${
            topSection === "workspace"
              ? "text-sky-600 dark:text-sky-400"
              : "text-slate-500 dark:text-slate-400"
          }`}
        >
          <FolderKanban className="h-5 w-5" />
          <span>Workspace</span>
        </button>

        <button
          type="button"
          onClick={() => setTopSection("telegram")}
          className={`flex min-h-[48px] flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] font-semibold transition-colors ${
            topSection === "telegram"
              ? "text-sky-600 dark:text-sky-400"
              : "text-slate-500 dark:text-slate-400"
          }`}
        >
          <Bot className="h-5 w-5" />
          <span>{isAr ? "تليجرام" : "Telegram"}</span>
        </button>
      </nav>

      {/* Global Confirmation Modal */}
      <ConfirmationModal
        open={confirmDialog.open}
        title={confirmDialog.title}
        description={confirmDialog.description}
        isDestructive={confirmDialog.isDestructive}
        onConfirm={async () => {
          const fn = confirmDialog.onConfirm;
          setConfirmDialog((prev) => ({ ...prev, open: false }));
          await fn();
        }}
        onCancel={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}

