import { serverGemini } from "../ai/gemini.service";
import { DocxGenerator } from "../generators/docx.generator";
import { ExcelGenerator } from "../generators/excel.generator";
import { PdfGenerator } from "../generators/pdf.generator";
import { PptxGenerator } from "../generators/pptx.generator";
import { FileValidator, FileValidationResult } from "../generators/file-validator";
import { TempFileStorage } from "../generators/file-storage";

export type SupportedFileFormat = "excel" | "word" | "pdf" | "pptx";

export interface FileAgentExecutionResult {
  needsClarification?: boolean;
  replyText: string;
  skillUsed: string;
  modelUsed: string;
  tokensUsed: number;
  generatedFile?: {
    fileType: "xlsx" | "docx" | "pdf" | "pptx";
    fileName: string;
    filePath: string;
    savedFilePath: string;
    mimeType: string;
    base64Data: string;
    structuredSpec: any;
    validation: FileValidationResult;
  };
}

export class FileGenerationAgent {
  /**
   * Natural-language file format & intent detector supporting Arabic and English.
   */
  public static detectFileRequest(
    prompt: string,
    explicitSkill?: string
  ): { isFileRequest: boolean; fileType?: SupportedFileFormat; skillName?: string } {
    if (explicitSkill === "WordSkill") {
      return { isFileRequest: true, fileType: "word", skillName: "WordSkill" };
    }
    if (explicitSkill === "ExcelSkill") {
      return { isFileRequest: true, fileType: "excel", skillName: "ExcelSkill" };
    }
    if (explicitSkill === "PdfSkill") {
      return { isFileRequest: true, fileType: "pdf", skillName: "PdfSkill" };
    }
    if (explicitSkill === "PowerPointSkill") {
      return { isFileRequest: true, fileType: "pptx", skillName: "PowerPointSkill" };
    }

    const p = (prompt || "").toLowerCase().trim();

    // Direct slash commands
    if (p.startsWith("/word")) return { isFileRequest: true, fileType: "word", skillName: "WordSkill" };
    if (p.startsWith("/excel")) return { isFileRequest: true, fileType: "excel", skillName: "ExcelSkill" };
    if (p.startsWith("/pdf")) return { isFileRequest: true, fileType: "pdf", skillName: "PdfSkill" };
    if (p.startsWith("/ppt")) return { isFileRequest: true, fileType: "pptx", skillName: "PowerPointSkill" };

    // Action verbs or request indicators in English & Arabic
    const hasActionIntent =
      /\b(create|make|generate|build|prepare|design|export|convert|write|draft|send|give)\b/i.test(p) ||
      /(اعمل|إعمل|انشئ|أنشئ|صمم|جهز|حضر|اكتب|إكتب|حول|صدر|ارسل|أرسل|توليد|إنشاء|انشاء|أريد|اريد|مطلوب|عايز|ابغى|أبغى)/.test(
        p
      );

    // 1. Check PowerPoint / Presentation
    const isPptxMention =
      /\b(pptx?|power\s*point|presentation|slide\s*deck|slides)\b/i.test(p) ||
      /(بوربوينت|باوربوينت|عرض تقديمي|شرائح عرض)/.test(p);
    if (isPptxMention && (hasActionIntent || p.length > 8)) {
      return { isFileRequest: true, fileType: "pptx", skillName: "PowerPointSkill" };
    }

    // 2. Check PDF
    const isPdfMention =
      /\b(pdf)\b/i.test(p) || /(بي دي اف|بي دي إف|ملف pdf|تقرير pdf)/i.test(p);
    if (isPdfMention && (hasActionIntent || p.includes("report") || p.includes("تقرير") || p.includes("ملف"))) {
      return { isFileRequest: true, fileType: "pdf", skillName: "PdfSkill" };
    }

    // 3. Check Word / DOCX
    const isWordMention =
      /\b(word|docx)\b/i.test(p) || /(وورد|ملف وورد|تقرير وورد|مذكرة وورد|مستند وورد)/i.test(p);
    if (isWordMention && (hasActionIntent || p.includes("report") || p.includes("تقرير") || p.includes("ملف") || p.includes("document"))) {
      return { isFileRequest: true, fileType: "word", skillName: "WordSkill" };
    }

    // 4. Check Excel / Spreadsheet / Quantity Survey / BOQ Sheet
    const isExcelMention =
      /\b(excel|xlsx|spreadsheet|excel\s*sheet|quantity\s*survey\s*spreadsheet|boq\s*sheet|calculation\s*sheet)\b/i.test(
        p
      ) ||
      (/\b(sheet)\b/i.test(p) && hasActionIntent) ||
      /(إكسل|اكسل|اكسيل|شيت|جدول كميات|مقايسة|كشف رواتب)/.test(p);
    if (isExcelMention) {
      return { isFileRequest: true, fileType: "excel", skillName: "ExcelSkill" };
    }

    return { isFileRequest: false };
  }

  /**
   * Checks if the user's request has enough topic detail (or prior history/attachment context)
   * or if a short clarification question is needed instead of generating a dummy file.
   */
  public static isTopicUnderspecified(
    prompt: string,
    history?: Array<{ role: "user" | "model"; content: string }>,
    hasAttachment?: boolean
  ): boolean {
    if (hasAttachment) return false;
    if (history && history.length > 0) {
      const recentContext = history.map((h) => h.content).join(" ").trim();
      if (recentContext.length > 30) return false;
    }

    // Strip generic command and file-type words to see if any actual subject remains
    const stripped = (prompt || "")
      .replace(/^\/(word|excel|pdf|ppt)\b/i, "")
      .replace(
        /\b(please|can you|could you|i want|i need|create|make|generate|build|prepare|me|a|an|the|professional|new|file|document|report|sheet|spreadsheet|presentation|slides|word|docx|excel|xlsx|pdf|pptx|powerpoint)\b/gi,
        ""
      )
      .replace(
        /(من فضلك|لو سمحت|ممكن|أريد|اريد|عايز|ابغى|اعمل|إعمل|انشئ|أنشئ|صمم|جهز|لي|ملف|مستند|تقرير|جدول|شيت|عرض تقديمي|وورد|إكسل|اكسل|اكسيل|بي دي اف|بوربوينت|احترافي|جديد)/g,
        ""
      )
      .replace(/[^\w\u0600-\u06FF]/g, "")
      .trim();

    return stripped.length < 3;
  }

  /**
   * Executes the complete File Generation Agent workflow:
   * Intent -> Content Planning -> Structured Spec -> Dynamic Generation -> Validation (with Auto-Retry) -> Temp Storage
   */
  public static async execute(params: {
    fileType: SupportedFileFormat;
    prompt: string;
    language: "ar" | "en";
    history?: Array<{ role: "user" | "model"; content: string }>;
    fileBase64?: string;
    fileMimeType?: string;
  }): Promise<FileAgentExecutionResult> {
    const isAr = params.language === "ar" || /[\u0600-\u06FF]/.test(params.prompt);
    const targetLang: "ar" | "en" = isAr ? "ar" : "en";
    const skillMap: Record<SupportedFileFormat, string> = {
      word: "WordSkill",
      excel: "ExcelSkill",
      pdf: "PdfSkill",
      pptx: "PowerPointSkill",
    };
    const skillUsed = skillMap[params.fileType];

    // 1. Check if essential topic information is missing
    if (
      this.isTopicUnderspecified(
        params.prompt,
        params.history,
        Boolean(params.fileBase64)
      )
    ) {
      const clarificationMap: Record<SupportedFileFormat, { ar: string; en: string }> = {
        excel: {
          ar: "بكل سرور! ما هو موضوع جدول الـ Excel المطلوب وما هي الأعمدة أو المعادلات الحسابية التي ترغب في تضمينها؟ (مثال: كشف رواتب الموظفين، حصر كميات الحديد أو الخرسانة، أو ميزانية مشروع).",
          en: "Certainly! What topic, columns, or calculations would you like in your Excel spreadsheet? (e.g., monthly employee salaries, reinforcement steel quantities, or project budget).",
        },
        word: {
          ar: "بكل سرور! ما هو موضوع التقرير أو المستند الذي ترغب في إنشائه بصيغة Word (DOCX)؟",
          en: "Certainly! What topic or inspection details should I include in your Word (DOCX) report?",
        },
        pdf: {
          ar: "بكل سرور! ما هو موضوع التقرير والجدول الذي ترغب في إصداره كملف PDF رسمي؟",
          en: "Certainly! What topic, tables, or notes should I include in your PDF report?",
        },
        pptx: {
          ar: "بكل سرور! ما هو عنوان وموضوع العرض التقديمي (PowerPoint) وعدد الشرائح المطلوبة؟",
          en: "Certainly! What topic and how many slides would you like in your PowerPoint presentation?",
        },
      };

      return {
        needsClarification: true,
        replyText: clarificationMap[params.fileType][targetLang],
        skillUsed,
        modelUsed: "gemini-3.8-flash",
        tokensUsed: 0,
      };
    }

    const cleanPrompt =
      params.prompt.replace(/^\/(word|excel|pdf|ppt)\s*/i, "").trim() ||
      (params.history && params.history.length > 0
        ? params.history[params.history.length - 1].content
        : params.prompt);

    const conversationContext =
      params.history && params.history.length > 0
        ? params.history
            .slice(-6)
            .map((h) => `${h.role.toUpperCase()}: ${h.content}`)
            .join("\n")
        : undefined;

    let lastError = "";
    let totalTokens = 0;

    // Up to 2 attempts: if validation fails on attempt 1, regenerate with validation feedback
    for (let attempt = 1; attempt <= 2; attempt++) {
      const promptForAttempt =
        attempt === 1
          ? cleanPrompt
          : `${cleanPrompt}\n[IMPORTANT VALIDATION FIX REQUIRED: Previous attempt failed with "${lastError}". Ensure all required tables, rows, and working "=...{ROW}" Excel formulas are included.]`;

      const { spec, modelUsed, tokensUsed } = await serverGemini.generateStructuredFileSpec({
        fileType: params.fileType,
        prompt: promptForAttempt,
        language: targetLang,
        conversationContext,
        imageBase64: params.fileBase64,
        imageMimeType: params.fileMimeType,
      });
      totalTokens += tokensUsed;

      if (params.fileType === "excel") {
        const buffer = await ExcelGenerator.generate({
          ...spec,
          isRtl: isAr,
        });
        const validation = await FileValidator.validateXlsx(buffer, {
          requireFormulas: true,
        });
        if (!validation.valid) {
          lastError = validation.error || "XLSX validation failed";
          if (attempt < 2) continue;
          throw new Error(lastError);
        }

        const uniqueFileName = TempFileStorage.buildUniqueFileName(
          spec.sheetName || spec.title || "Spreadsheet",
          "xlsx"
        );
        const stored = TempFileStorage.saveGeneratedFile(buffer, uniqueFileName);

        const confirmText = isAr
          ? `✅ **تم إعداد وتوليد ملف Excel بنجاح:** \`${stored.fileName}\`\n\n` +
            `📊 **العنوان:** ${spec.title}\n` +
            `📋 **الأعمدة (${(spec.headers || []).length}):** ${(spec.headers || []).join(" | ")}\n` +
            `🧮 **المعادلات الحسابية الفعالة:** تم تضمين والتحقق من **${validation.formulaCount || 0}** معادلة Excel ديناميكية شغالة (شاملة صف الإجمالي \`=SUM\`).\n\n` +
            `${spec.summary || ""}`
          : `✅ **تم إعداد وتوليد ملف Excel بنجاح (Generated Dynamic Excel Workbook):** \`${stored.fileName}\`\n\n` +
            `📊 **Title:** ${spec.title}\n` +
            `📋 **Columns (${(spec.headers || []).length}):** ${(spec.headers || []).join(" | ")}\n` +
            `🧮 **Verified Working Formulas:** **${validation.formulaCount || 0}** live Excel formulas verified (including automatic \`=SUM\` totals).\n\n` +
            `${spec.summary || ""}`;

        return {
          replyText: confirmText,
          skillUsed: "ExcelSkill",
          modelUsed,
          tokensUsed: totalTokens,
          generatedFile: {
            fileType: "xlsx",
            fileName: stored.fileName,
            filePath: stored.filePath,
            savedFilePath: stored.filePath,
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            base64Data: buffer.toString("base64"),
            structuredSpec: spec,
            validation,
          },
        };
      }

      if (params.fileType === "word") {
        const buffer = await DocxGenerator.generate({
          ...spec,
          imageBase64: params.fileMimeType?.startsWith("image/") ? params.fileBase64 : undefined,
          isRtl: isAr,
        });
        const validation = await FileValidator.validateDocx(buffer);
        if (!validation.valid) {
          lastError = validation.error || "DOCX validation failed";
          if (attempt < 2) continue;
          throw new Error(lastError);
        }

        const uniqueFileName = TempFileStorage.buildUniqueFileName(
          spec.title || "Word_Report",
          "docx"
        );
        const stored = TempFileStorage.saveGeneratedFile(buffer, uniqueFileName);

        const sectionsSummary = (spec.sections || [])
          .map((s: any) => `• **${s.heading}**`)
          .join("\n");

        const confirmText =
          `✅ **تم إعداد وتوليد مستند Word الاحترافي بنجاح:** \`${stored.fileName}\`\n\n` +
          `📝 **العنوان:** ${spec.title}\n` +
          `📌 **الملخص التنفيذي:** ${spec.executiveSummary}\n\n` +
          `📂 **الأقسام المتضمنة:**\n${sectionsSummary}\n` +
          `📋 **الجدول المرفق:** ${spec.tableTitle || "جدول البيانات"} (${(spec.tableRows || []).length} صفوف) + قسم الملاحظات والتوصيات وجدول التوقيعات.`;

        return {
          replyText: confirmText,
          skillUsed: "WordSkill",
          modelUsed,
          tokensUsed: totalTokens,
          generatedFile: {
            fileType: "docx",
            fileName: stored.fileName,
            filePath: stored.filePath,
            savedFilePath: stored.filePath,
            mimeType:
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            base64Data: buffer.toString("base64"),
            structuredSpec: spec,
            validation,
          },
        };
      }

      if (params.fileType === "pdf") {
        const buffer = await PdfGenerator.generate({
          ...spec,
          imageBase64: params.fileMimeType?.startsWith("image/") ? params.fileBase64 : undefined,
          isRtl: isAr,
        });
        const validation = await FileValidator.validatePdf(buffer);
        if (!validation.valid) {
          lastError = validation.error || "PDF validation failed";
          if (attempt < 2) continue;
          throw new Error(lastError);
        }

        const uniqueFileName = TempFileStorage.buildUniqueFileName(
          spec.title || "PDF_Report",
          "pdf"
        );
        const stored = TempFileStorage.saveGeneratedFile(buffer, uniqueFileName);

        const confirmText =
          `✅ **تم إعداد وتوليد تقرير PDF الرسمي بنجاح:** \`${stored.fileName}\`\n\n` +
          `📑 **العنوان:** ${spec.title}\n` +
          `📌 **الملخص التنفيذي:** ${spec.executiveSummary}\n` +
          `📋 **محتويات التقرير:** يشتمل على ${(spec.sections || []).length} أقسام فنية، جدول الفحص المنسق (**${spec.tableTitle || "Inspection Table"}** - ${(spec.tableRows || []).length} صفوف)، قسم الملاحظات الفنية (${(spec.notes || []).length} ملاحظات)، وخانات الاعتماد والتوقيع.`;

        return {
          replyText: confirmText,
          skillUsed: "PdfSkill",
          modelUsed,
          tokensUsed: totalTokens,
          generatedFile: {
            fileType: "pdf",
            fileName: stored.fileName,
            filePath: stored.filePath,
            savedFilePath: stored.filePath,
            mimeType: "application/pdf",
            base64Data: buffer.toString("base64"),
            structuredSpec: spec,
            validation,
          },
        };
      }

      if (params.fileType === "pptx") {
        const buffer = await PptxGenerator.generate({
          ...spec,
          isRtl: isAr,
        });
        const validation = await FileValidator.validatePptx(buffer);
        if (!validation.valid) {
          lastError = validation.error || "PPTX validation failed";
          if (attempt < 2) continue;
          throw new Error(lastError);
        }

        const uniqueFileName = TempFileStorage.buildUniqueFileName(
          spec.title || "Presentation",
          "pptx"
        );
        const stored = TempFileStorage.saveGeneratedFile(buffer, uniqueFileName);

        const slidesPreview = (spec.slides || [])
          .map((s: any, idx: number) => `${idx + 1}. **${s.slideTitle}**`)
          .join("\n");

        const confirmText =
          `✅ **تم إعداد وتوليد العرض التقديمي (PowerPoint) بنجاح:** \`${stored.fileName}\`\n\n` +
          `📽️ **العنوان:** ${spec.title}\n` +
          `📊 **الشرائح (${(spec.slides || []).length + 1} شرائح):**\n${slidesPreview}`;

        return {
          replyText: confirmText,
          skillUsed: "PowerPointSkill",
          modelUsed,
          tokensUsed: totalTokens,
          generatedFile: {
            fileType: "pptx",
            fileName: stored.fileName,
            filePath: stored.filePath,
            savedFilePath: stored.filePath,
            mimeType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            base64Data: buffer.toString("base64"),
            structuredSpec: spec,
            validation,
          },
        };
      }
    }

    throw new Error(`Failed to generate and validate ${params.fileType} file: ${lastError}`);
  }
}
