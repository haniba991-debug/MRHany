import { serverGemini, GroundingPlaceLink } from "../ai/gemini.service";
import { DocumentParser } from "../documents/document.parser";
import { ExcelGenerator } from "../generators/excel.generator";
import { FileValidator } from "../generators/file-validator";
import { TempFileStorage } from "../generators/file-storage";
import { FileGenerationAgent, SupportedFileFormat } from "./file-generation.agent";

export interface AgentTaskRequest {
  prompt: string;
  language?: "ar" | "en";
  model?: "gemini-4-argon" | "gemini-3.8-flash" | "gemini-3.1-flash-lite";
  explicitSkill?: string;
  history?: Array<{ role: "user" | "model"; content: string }>;
  enableMapsGrounding?: boolean;
  enableSearchGrounding?: boolean;
  latLng?: { latitude: number; longitude: number };
  fileBase64?: string;
  fileMimeType?: string;
  fileName?: string;
  synthesizeVoiceReply?: boolean;
}

export interface GeneratedArtifact {
  fileType?: "xlsx" | "docx" | "pdf" | "pptx";
  fileName: string;
  filePath?: string;
  savedFilePath?: string;
  mimeType: string;
  base64Data: string;
  structuredSpec?: any;
}

export interface AgentTaskResponse {
  needsClarification?: boolean;
  replyText: string;
  transcript?: string;
  skillUsed: string;
  combinedSkills: string[];
  modelUsed: string;
  tokensUsed: number;
  groundingLinks?: GroundingPlaceLink[];
  audioReplyBase64?: string;
  generatedFile?: GeneratedArtifact;
  parsedDocMeta?: {
    fileName: string;
    totalCharacters: number;
    chunkCount: number;
    tablesPreview?: string[][];
  };
}

export interface RegisteredSkillMeta {
  id: string;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  defaultModel: string;
  enabled: boolean;
}

export class AgentOrchestrator {
  public skillsRegistry: RegisteredSkillMeta[] = [
    {
      id: "ChatSkill",
      nameAr: "محرك المحادثة والاستدلال الذكي",
      nameEn: "Advanced AI Chat & Reasoning",
      descriptionAr: "محادثات طبيعية، حل المشكلات، الحسابات الرياضية، والبحث المتقدم.",
      descriptionEn: "Context-aware natural conversation, complex reasoning, and problem solving.",
      defaultModel: "gemini-3.8-flash",
      enabled: true,
    },
    {
      id: "DocumentSkill",
      nameAr: "ذكاء المستندات والتقارير",
      nameEn: "Document Intelligence",
      descriptionAr: "قراءة وتحليل ملفات PDF, DOCX, XLSX, CSV, TXT مع تقسيم الملفات الكبيرة.",
      descriptionEn: "Extract text, tables, summaries, and Q&A from PDF, DOCX, XLSX, CSV, TXT.",
      defaultModel: "gemini-3.8-flash",
      enabled: true,
    },
    {
      id: "ImageSkill",
      nameAr: "الرؤية الحاسوبية وتحليل الصور والفيديو",
      nameEn: "Vision & Video Intelligence",
      descriptionAr: "تحليل الصور، المخططات، لقطات الشاشة، استخراج النصوص OCR، وتحليل الفيديو.",
      descriptionEn: "Analyze photos, diagrams, OCR tables, and video walkthroughs via Gemini 4 Argon.",
      defaultModel: "gemini-4-argon",
      enabled: true,
    },
    {
      id: "VoiceSkill",
      nameAr: "المساعد الصوتي الذكي",
      nameEn: "Voice & Dialect Assistant",
      descriptionAr: "تفريغ الرسائل الصوتية بالعربية (المصرية والخليجية والفصحى) والإنجليزية والرد الصوتي.",
      descriptionEn: "Transcribe voice messages (gemini-3.5-transcribe) and generate spoken replies.",
      defaultModel: "gemini-3.5-transcribe",
      enabled: true,
    },
    {
      id: "WordSkill",
      nameAr: "مولد مستندات Word (DOCX)",
      nameEn: "Word Document Generator",
      descriptionAr: "توليد ملفات DOCX احترافية مع الجداول والترويسات وتنسيق RTL/LTR.",
      descriptionEn: "Generate formatted DOCX reports with executive summaries and tables.",
      defaultModel: "gemini-3.8-flash",
      enabled: true,
    },
    {
      id: "ExcelSkill",
      nameAr: "مولد جداول Excel (XLSX)",
      nameEn: "Excel Spreadsheet Generator",
      descriptionAr: "إنشاء ملفات XLSX متعددة الأوراق مع المعادلات الحسابية والتنسيق الهندسي/المالي.",
      descriptionEn: "Generate multi-row XLSX workbooks with numeric formatting and formulas.",
      defaultModel: "gemini-3.8-flash",
      enabled: true,
    },
    {
      id: "PdfSkill",
      nameAr: "مولد تقارير PDF الرسمية",
      nameEn: "PDF Report Generator",
      descriptionAr: "إنشاء تقارير PDF رسمية منسقة وجاهزة للطباعة والتحميل.",
      descriptionEn: "Generate downloadable formal PDF technical reports.",
      defaultModel: "gemini-3.8-flash",
      enabled: true,
    },
    {
      id: "PowerPointSkill",
      nameAr: "مولد العروض التقديمية (PPTX)",
      nameEn: "PowerPoint Deck Generator",
      descriptionAr: "تصميم عروض بوربوينت احترافية 16:9 مع الشرائح والنقاط الرئيسية.",
      descriptionEn: "Generate 16:9 executive PPTX slide decks.",
      defaultModel: "gemini-3.8-flash",
      enabled: true,
    },
    {
      id: "EngineeringSkill",
      nameAr: "المساعد الهندسي وحصر الكميات",
      nameEn: "Engineering & BOQ Assistant",
      descriptionAr: "قراءة المخططات الإنشائية والمعمارية، حصر الخرسانة والحديد، وتقارير الموقع Snag List.",
      descriptionEn: "Analyze structural blueprints, calculate concrete/rebar BOQ, and inspect site defects.",
      defaultModel: "gemini-4-argon",
      enabled: true,
    },
    {
      id: "DataAnalysisSkill",
      nameAr: "تحليل البيانات والإحصاءات",
      nameEn: "Data & Statistical Analysis",
      descriptionAr: "تحليل البيانات الجدولية والمالية واستخراج المؤشرات الرئيسية.",
      descriptionEn: "Analyze CSV/XLSX datasets, calculate KPIs, and produce structured insights.",
      defaultModel: "gemini-4-argon",
      enabled: true,
    },
    {
      id: "TranslationSkill",
      nameAr: "الترجمة الاحترافية المتخصصة",
      nameEn: "Technical & Legal Translation",
      descriptionAr: "ترجمة احترافية بين العربية والإنجليزية مع الحفاظ على المصطلحات الهندسية والتقنية.",
      descriptionEn: "Bidirectional Arabic/English translation preserving technical terminology.",
      defaultModel: "gemini-3.8-flash",
      enabled: true,
    },
    {
      id: "ResearchSkill",
      nameAr: "البحث المعمق وخرائط جوجل",
      nameEn: "Deep Research & Maps Grounding",
      descriptionAr: "البحث الموثق بالمصادر وبيانات خرائط جوجل المحدثة للمواقع والمشاريع.",
      descriptionEn: "Grounded research with live Google Maps place data and web citations.",
      defaultModel: "gemini-3.8-flash",
      enabled: true,
    },
  ];

  public detectIntent(req: AgentTaskRequest): { primarySkill: string; needsExcelBoq: boolean } {
    const p = (req.prompt || "").toLowerCase();
    const mime = (req.fileMimeType || "").toLowerCase();

    if (req.explicitSkill) {
      const needsBoq =
        req.explicitSkill === "EngineeringSkill" ||
        p.includes("excel") ||
        p.includes("شيت") ||
        p.includes("جدول كميات") ||
        p.includes("boq");
      return { primarySkill: req.explicitSkill, needsExcelBoq: needsBoq };
    }

    if (mime.startsWith("audio/")) {
      return { primarySkill: "VoiceSkill", needsExcelBoq: false };
    }
    if (mime.startsWith("video/")) {
      return { primarySkill: "VideoSkill", needsExcelBoq: false };
    }

    // Check natural-language file generation requests first (Excel, Word, PDF, PowerPoint)
    const fileIntent = FileGenerationAgent.detectFileRequest(req.prompt, req.explicitSkill);
    if (fileIntent.isFileRequest && fileIntent.skillName) {
      return { primarySkill: fileIntent.skillName, needsExcelBoq: false };
    }

    const isEngKeywords =
      p.includes("خرسانة") ||
      p.includes("حديد") ||
      p.includes("حصر") ||
      p.includes("مخطط") ||
      p.includes("إنشائي") ||
      p.includes("معماري") ||
      p.includes("snag") ||
      p.includes("boq") ||
      p.includes("concrete") ||
      p.includes("rebar") ||
      p.includes("structural") ||
      p.includes("footing") ||
      p.includes("عمود") ||
      p.includes("قواعد");

    if (isEngKeywords) {
      return {
        primarySkill: "EngineeringSkill",
        needsExcelBoq: true,
      };
    }

    if (mime.startsWith("image/")) {
      return { primarySkill: "ImageSkill", needsExcelBoq: false };
    }

    if (
      mime.includes("pdf") ||
      mime.includes("word") ||
      mime.includes("spreadsheet") ||
      mime.includes("csv") ||
      mime.includes("text") ||
      (req.fileName && /\.(pdf|docx|xlsx|csv|txt)$/i.test(req.fileName))
    ) {
      return { primarySkill: "DocumentSkill", needsExcelBoq: false };
    }

    if (req.enableMapsGrounding || p.includes("أين يقع") || p.includes("خريطة") || p.includes("nearby") || p.includes("location")) {
      return { primarySkill: "ResearchSkill", needsExcelBoq: false };
    }

    return { primarySkill: "ChatSkill", needsExcelBoq: false };
  }

  public async execute(req: AgentTaskRequest): Promise<AgentTaskResponse> {
    const hasArabicChars = /[\u0600-\u06FF]/.test(req.prompt || "");
    const lang: "ar" | "en" = hasArabicChars ? "ar" : req.language || "ar";
    const isRtl = lang === "ar";
    const { primarySkill, needsExcelBoq } = this.detectIntent(req);
    const combinedSkills: string[] = [primarySkill];
    let totalTokens = 0;

    // 1. Voice Skill (Audio Transcription + Conversational Execution + Optional TTS)
    if (primarySkill === "VoiceSkill" && req.fileBase64) {
      const trans = await serverGemini.transcribeAudio({
        base64Data: req.fileBase64,
        mimeType: req.fileMimeType || "audio/webm",
      });
      totalTokens += trans.tokensUsed;
      combinedSkills.push("ChatSkill");

      const spokenInstruction = trans.transcript || req.prompt || "مرحباً مستر هاني";
      const chatRes = await serverGemini.generateChat({
        prompt: spokenInstruction,
        history: req.history,
        model: req.model || "gemini-3.8-flash",
        language: lang,
        skillTag: "VoiceSkill",
      });
      totalTokens += chatRes.tokensUsed;

      let audioReplyBase64: string | undefined;
      if (req.synthesizeVoiceReply !== false) {
        audioReplyBase64 = await serverGemini.synthesizeSpeech(chatRes.text);
      }

      return {
        replyText: chatRes.text,
        transcript: trans.transcript,
        skillUsed: "VoiceSkill",
        combinedSkills,
        modelUsed: "gemini-3.5-transcribe + " + chatRes.modelUsed,
        tokensUsed: totalTokens,
        audioReplyBase64,
      };
    }

    // 2. Video Understanding Skill (gemini-4-argon)
    if (primarySkill === "VideoSkill" && req.fileBase64) {
      const vidRes = await serverGemini.analyzeVideo({
        base64Data: req.fileBase64,
        mimeType: req.fileMimeType || "video/mp4",
        prompt: req.prompt,
      });
      return {
        replyText: vidRes.text,
        skillUsed: "VideoSkill",
        combinedSkills,
        modelUsed: vidRes.modelUsed,
        tokensUsed: vidRes.tokensUsed,
      };
    }

    // 3. Engineering Assistant Skill (Multimodal Drawing / Site Photo + Dynamic BOQ Excel Generation)
    if (primarySkill === "EngineeringSkill") {
      let analysisText = "";
      let modelUsed = "gemini-4-argon";

      if (req.fileBase64 && req.fileMimeType?.startsWith("image/")) {
        const imgRes = await serverGemini.analyzeImage({
          base64Data: req.fileBase64,
          mimeType: req.fileMimeType,
          prompt:
            req.prompt ||
            "قم بقراءة هذا المخطط الهندسي واستخراج الأبعاد وجدول التسليح وحساب كميات الخرسانة والحديد مع التمييز الصريح بين القياسات المؤكدة والتقديرات الهندسية.",
          isEngineeringMode: true,
        });
        analysisText = imgRes.text;
        modelUsed = imgRes.modelUsed;
        totalTokens += imgRes.tokensUsed;
      } else {
        const engChat = await serverGemini.generateChat({
          prompt: req.prompt,
          history: req.history,
          model: "gemini-4-argon",
          skillTag: "EngineeringSkill",
          systemInstructionOverride: `You are Mr. Hany (مستر هاني), Senior Chartered Structural & Civil Engineer and Quantity Surveyor.
Rules:
1. Distinguish clearly between [Verified Engineering Measurements] and [Conceptual Estimates].
2. Never invent dimensions that were not supplied.
3. Show exact equations for concrete volume (m³ = L × W × H) and steel reinforcement weight (kg = Volume × Steel Ratio or Bar Weight D²/162 × Length).
4. Include site inspection quality checks (Snag List) and code compliance notes.`,
        });
        analysisText = engChat.text;
        modelUsed = engChat.modelUsed;
        totalTokens += engChat.tokensUsed;
      }

      let generatedFile: GeneratedArtifact | undefined;
      if (needsExcelBoq) {
        combinedSkills.push("ExcelSkill");
        const { spec: boqSpec, tokensUsed: boqTokens } = await serverGemini.generateStructuredFileSpec({
          fileType: "boq",
          prompt: `Based on this engineering request and analysis, generate a customized Bill of Quantities (BOQ) and calculation spreadsheet with working Excel formulas:\nUser Request: ${req.prompt}\nAnalysis:\n${analysisText.slice(0, 2500)}`,
          language: lang,
        });
        totalTokens += boqTokens;

        const xlsxBuffer = await ExcelGenerator.generate({
          title: boqSpec.title || "Engineering Bill of Quantities (BOQ)",
          summary: boqSpec.summary,
          sheetName: boqSpec.sheetName || "BOQ_Quantities",
          headers: boqSpec.headers || ["Item No", "Element Description", "Count", "Length (m)", "Width (m)", "Depth (m)", "Total Volume (m3)"],
          rows: boqSpec.rows || [],
          notes: boqSpec.notes,
          isRtl,
        });
        const validation = await FileValidator.validateXlsx(xlsxBuffer);
        if (!validation.valid) {
          throw new Error(`BOQ Excel validation failed: ${validation.error}`);
        }
        const uniqueBoqName = TempFileStorage.buildUniqueFileName(
          boqSpec.sheetName || boqSpec.title || "Engineering_BOQ",
          "xlsx"
        );
        const storedBoq = TempFileStorage.saveGeneratedFile(xlsxBuffer, uniqueBoqName);
        generatedFile = {
          fileType: "xlsx",
          fileName: storedBoq.fileName,
          filePath: storedBoq.filePath,
          savedFilePath: storedBoq.filePath,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          base64Data: xlsxBuffer.toString("base64"),
          structuredSpec: boqSpec,
        };
      }

      return {
        replyText: analysisText,
        skillUsed: "EngineeringSkill",
        combinedSkills,
        modelUsed,
        tokensUsed: totalTokens,
        generatedFile,
      };
    }

    // 4. Image Intelligence Skill (gemini-4-argon)
    if (primarySkill === "ImageSkill" && req.fileBase64) {
      const imgRes = await serverGemini.analyzeImage({
        base64Data: req.fileBase64,
        mimeType: req.fileMimeType || "image/jpeg",
        prompt: req.prompt,
        isEngineeringMode: false,
      });
      return {
        replyText: imgRes.text,
        skillUsed: "ImageSkill",
        combinedSkills,
        modelUsed: imgRes.modelUsed,
        tokensUsed: imgRes.tokensUsed,
      };
    }

    // 5. Document Intelligence Skill (PDF, DOCX, XLSX, CSV, TXT with chunking)
    if (primarySkill === "DocumentSkill" && req.fileBase64) {
      const buffer = Buffer.from(req.fileBase64, "base64");
      const mime = req.fileMimeType || "application/octet-stream";
      const fileName = req.fileName || "document";

      if (mime.includes("pdf") || fileName.toLowerCase().endsWith(".pdf")) {
        const aiRes = await serverGemini.analyzeImage({
          base64Data: req.fileBase64,
          mimeType: "application/pdf",
          prompt:
            req.prompt ||
            "قم بتحليل ملف PDF هذا بالكامل، واستخرج الملخص التنفيذي، النقاط الرئيسية، الجداول، والإجابة على أي استفسار.",
        });
        return {
          replyText: aiRes.text,
          skillUsed: "DocumentSkill",
          combinedSkills,
          modelUsed: aiRes.modelUsed,
          tokensUsed: aiRes.tokensUsed,
          parsedDocMeta: {
            fileName,
            totalCharacters: aiRes.text.length,
            chunkCount: 1,
          },
        };
      }

      const parsed = await DocumentParser.extractDocument(buffer, mime, fileName);
      const activeChunks = parsed.chunks.slice(0, 3).join("\n\n--- [Chunk Boundary] ---\n\n");
      const docPrompt = `Document Analysis Request for "${fileName}" (Total length: ${parsed.totalCharacters} chars, ${parsed.chunkCount} chunks).
User Instruction: ${req.prompt || "Summarize this document, extract key tables/metrics, and explain its contents."}

Extracted Document Content (Chunks 1-${Math.min(3, parsed.chunkCount)}):
${activeChunks}`;

      const chatRes = await serverGemini.generateChat({
        prompt: docPrompt,
        history: req.history,
        model: req.model || "gemini-3.8-flash",
        language: lang,
        skillTag: "DocumentSkill",
      });

      return {
        replyText: chatRes.text,
        skillUsed: "DocumentSkill",
        combinedSkills,
        modelUsed: chatRes.modelUsed,
        tokensUsed: chatRes.tokensUsed,
        parsedDocMeta: {
          fileName: parsed.fileName,
          totalCharacters: parsed.totalCharacters,
          chunkCount: parsed.chunkCount,
          tablesPreview: parsed.tablesPreview,
        },
      };
    }

    // 6. Dynamic File Generation Agent (Word, Excel, PDF, PowerPoint)
    if (
      primarySkill === "WordSkill" ||
      primarySkill === "ExcelSkill" ||
      primarySkill === "PdfSkill" ||
      primarySkill === "PowerPointSkill"
    ) {
      const formatMap: Record<string, SupportedFileFormat> = {
        WordSkill: "word",
        ExcelSkill: "excel",
        PdfSkill: "pdf",
        PowerPointSkill: "pptx",
      };

      const fileRes = await FileGenerationAgent.execute({
        fileType: formatMap[primarySkill],
        prompt: req.prompt,
        language: lang,
        history: req.history,
        fileBase64: req.fileBase64,
        fileMimeType: req.fileMimeType,
      });

      return {
        needsClarification: fileRes.needsClarification,
        replyText: fileRes.replyText,
        skillUsed: fileRes.skillUsed,
        combinedSkills,
        modelUsed: fileRes.modelUsed,
        tokensUsed: fileRes.tokensUsed,
        generatedFile: fileRes.generatedFile,
      };
    }

    // 7. Default Conversational / Research / Data Analysis / Translation Skill
    const chatRes = await serverGemini.generateChat({
      prompt: req.prompt,
      history: req.history,
      model: req.model || "gemini-3.8-flash",
      language: lang,
      enableMapsGrounding: req.enableMapsGrounding,
      enableSearchGrounding: req.enableSearchGrounding,
      latLng: req.latLng,
      skillTag: primarySkill,
    });

    let audioReplyBase64: string | undefined;
    if (req.synthesizeVoiceReply) {
      audioReplyBase64 = await serverGemini.synthesizeSpeech(chatRes.text);
    }

    return {
      replyText: chatRes.text,
      skillUsed: chatRes.skillUsed,
      combinedSkills,
      modelUsed: chatRes.modelUsed,
      tokensUsed: chatRes.tokensUsed,
      groundingLinks: chatRes.groundingLinks,
      audioReplyBase64,
    };
  }
}

export const agentOrchestrator = new AgentOrchestrator();
