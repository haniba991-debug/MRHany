import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { logger } from "../utils/logger";
import { withRetry, isTransientError } from "../utils/retry";

export interface GroundingPlaceLink {
  title: string;
  uri: string;
  sourceType: "maps" | "web";
  reviewSnippets?: string[];
}

export interface GeminiGenerationResult {
  text: string;
  modelUsed: string;
  skillUsed: string;
  tokensUsed: number;
  groundingLinks?: GroundingPlaceLink[];
  audioBase64?: string;
  structuredData?: any;
  fallbackApplied?: string;
}

export class ServerGeminiService {
  private getClient(): GoogleGenAI {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "MY_GEMINI_API_KEY") {
      throw new Error("GEMINI_API_KEY is not configured in server environment.");
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`TIMEOUT: ${label} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private modelUnavailableUntil = new Map<string, { until: number; reason: string }>();

  /**
   * Executes a Gemini API operation across a prioritized model cascade:
   * Primary Model -> gemini-3.8-flash (ThinkingLevel.LOW) -> gemini-3.1-flash-lite
   * Uses a 5-minute circuit-breaker cache so throttled or paid-tier models do not add latency on subsequent calls.
   */
  private async withRetryAndFallback<T>(
    operation: (modelToUse: string) => Promise<T>,
    primaryModel: string,
    fallbackModel: string = "gemini-3.8-flash",
    probeTimeoutMs: number = 4500
  ): Promise<{ result: T; actualModel: string; fallbackReason?: string }> {
    // Free-tier mode is the default: never attempt models outside the free model allowlist.
    const freeTierOnly = process.env.GEMINI_FREE_TIER_ONLY !== "false";
    const candidateModels = freeTierOnly
      ? ["gemini-3.8-flash", "gemini-3.1-flash-lite"]
      : Array.from(new Set([primaryModel, fallbackModel, "gemini-3.1-flash-lite"]));
    const errors: string[] = [];
    const now = Date.now();

    for (const modelToUse of candidateModels) {
      const circuit = this.modelUnavailableUntil.get(modelToUse);
      if (circuit && circuit.until > now && modelToUse !== "gemini-3.1-flash-lite") {
        errors.push(`${modelToUse} (circuit-open: ${circuit.reason})`);
        continue;
      }

      const timeoutForModel = modelToUse === "gemini-3.1-flash-lite" ? 25000 : probeTimeoutMs;

      try {
        const res = await withRetry(
          () =>
            this.withTimeout(
              operation(modelToUse),
              timeoutForModel,
              `Model ${modelToUse}`
            ),
          {
            label: `gemini:${modelToUse}`,
            maxAttempts: 2,
            baseDelayMs: 450,
            maxDelayMs: 2500,
            shouldRetry: (err) => {
              const msg = String(err?.message || "").toLowerCase();
              // Do not waste retry budget on timeout/quota errors that should cascade immediately
              if (msg.includes("timeout") || msg.includes("429") || msg.includes("resource_exhausted")) {
                return false;
              }
              return isTransientError(err);
            },
          }
        );
        return {
          result: res,
          actualModel: modelToUse,
          fallbackReason:
            errors.length > 0
              ? `Cascaded from ${primaryModel} -> ${modelToUse} (${errors.join("; ")})`
              : undefined,
        };
      } catch (err: any) {
        const msg = String(err?.message || err || "Unknown error").slice(0, 140);
        errors.push(`${modelToUse}: ${msg}`);
        logger.warn("Gemini model attempt failed; evaluating cascade fallback", {
          modelToUse,
          primaryModel,
          error: msg,
        });
        if (modelToUse !== "gemini-3.1-flash-lite") {
          this.modelUnavailableUntil.set(modelToUse, {
            until: Date.now() + 5 * 60 * 1000,
            reason: msg,
          });
        }
      }
    }

    const finalErr = this.formatApiError(new Error(errors.join(" | ")));
    logger.error("All Gemini model candidates failed", {
      primaryModel,
      error: finalErr.message,
    });
    throw finalErr;
  }

  private formatApiError(err: any): Error {
    const rawMsg = String(err?.message || err || "Unknown Gemini API Error");
    if (rawMsg.includes("API_KEY_INVALID") || rawMsg.includes("PERMISSION_DENIED")) {
      return new Error(
        `خطأ في صلاحية مفتاح Gemini API (403/400): يرجى التحقق من إعداد مفتاح GEMINI_API_KEY في لوحة Secrets. (${rawMsg})`
      );
    }
    if (rawMsg.includes("RESOURCE_EXHAUSTED") || rawMsg.includes("429")) {
      return new Error(
        `تم تجاوز حد الاستخدام الحالي لـ Gemini API (429 Quota Exceeded): يرجى المحاولة بعد لحظات أو الترقية إلى مفتاح مدفوع. (${rawMsg})`
      );
    }
    return new Error(rawMsg);
  }

  /**
   * General & Complex Conversational AI + Optional Maps or Search Grounding
   */
  public async generateChat(params: {
    prompt: string;
    history?: Array<{ role: "user" | "model"; content: string }>;
    model?: "gemini-4-argon" | "gemini-3.8-flash" | "gemini-3.1-flash-lite";
    language?: "ar" | "en";
    enableMapsGrounding?: boolean;
    enableSearchGrounding?: boolean;
    latLng?: { latitude: number; longitude: number };
    skillTag?: string;
    systemInstructionOverride?: string;
  }): Promise<GeminiGenerationResult> {
    const ai = this.getClient();
    const freeTierOnly = process.env.GEMINI_FREE_TIER_ONLY !== "false";
    const groundingRequested = Boolean(params.enableMapsGrounding || params.enableSearchGrounding);
    const groundingAllowed = !freeTierOnly && groundingRequested;
    const chosenModel = params.enableMapsGrounding
      ? "gemini-3.8-flash"
      : params.model || "gemini-3.8-flash";

    const defaultSystemInstruction =
      params.systemInstructionOverride ||
      `You are Mr. Hany (مستر هاني), an advanced, intelligent, friendly, and highly professional AI assistant and principal consultant.
Rules:
1. Respond naturally in the language used by the user (Arabic is default; support Arabic, English, and mixed-language conversations seamlessly).
2. Provide structured, accurate, and actionable answers with clear headings, bullet points, and tables where helpful.
3. For mathematical or engineering calculations, show step-by-step formulas and clearly state assumptions vs. verified measurements.${freeTierOnly && groundingRequested ? "\n4. Live web search and map grounding are disabled in free-tier mode. Do not imply that you checked current sources or live locations." : ""}`;

    const contents = [
      ...(params.history || []).map((msg) => ({
        role: msg.role,
        parts: [{ text: msg.content }],
      })),
      {
        role: "user",
        parts: [{ text: params.prompt }],
      },
    ];

    const { result: response, actualModel, fallbackReason } = await this.withRetryAndFallback(
      async (modelToUse) => {
        const config: Record<string, any> = {
          systemInstruction: defaultSystemInstruction,
        };

        if (groundingAllowed && params.enableMapsGrounding) {
          config.tools = [{ googleMaps: {} }];
          if (params.latLng) {
            config.toolConfig = {
              retrievalConfig: {
                latLng: {
                  latitude: params.latLng.latitude,
                  longitude: params.latLng.longitude,
                },
              },
            };
          }
        } else if (groundingAllowed && params.enableSearchGrounding) {
          config.tools = [{ googleSearch: {} }];
        } else if (modelToUse === "gemini-4-argon") {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        } else if (modelToUse === "gemini-3.8-flash") {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
        }

        return await ai.models.generateContent({
          model: modelToUse,
          contents,
          config,
        });
      },
      chosenModel,
      "gemini-3.8-flash"
    );

    const groundingLinks: GroundingPlaceLink[] = [];
    const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks as any[]) {
        if (chunk.maps?.uri) {
          const snippets: string[] = [];
          const reviewSources = chunk.maps?.placeAnswerSources?.reviewSnippets;
          if (Array.isArray(reviewSources)) {
            for (const rev of reviewSources) {
              if (rev?.snippet) snippets.push(String(rev.snippet));
              else if (rev?.text) snippets.push(String(rev.text));
            }
          }
          groundingLinks.push({
            title: chunk.maps.title || "Google Maps Location",
            uri: chunk.maps.uri,
            sourceType: "maps",
            reviewSnippets: snippets,
          });
        } else if (chunk.web?.uri) {
          groundingLinks.push({
            title: chunk.web.title || chunk.web.uri,
            uri: chunk.web.uri,
            sourceType: "web",
          });
        }
      }
    }

    const totalTokens =
      (response.usageMetadata?.promptTokenCount || 0) +
      (response.usageMetadata?.candidatesTokenCount || 0);

    return {
      text: response.text || "",
      modelUsed: actualModel,
      skillUsed: params.skillTag || (params.enableMapsGrounding ? "MapsGroundingSkill" : "ChatSkill"),
      tokensUsed: totalTokens || Math.ceil((params.prompt.length + (response.text?.length || 0)) / 4),
      groundingLinks: groundingLinks.length > 0 ? groundingLinks : undefined,
      fallbackApplied: fallbackReason,
    };
  }

  /**
   * Image Understanding & Engineering Drawing Analysis using gemini-4-argon
   */
  public async analyzeImage(params: {
    base64Data: string;
    mimeType: string;
    prompt: string;
    isEngineeringMode?: boolean;
  }): Promise<GeminiGenerationResult> {
    const ai = this.getClient();
    const primaryModel = "gemini-4-argon";

    const sysInstruction = params.isEngineeringMode
      ? `You are Mr. Hany (مستر هاني), Senior Chartered Structural & Civil Engineer and Quantity Surveyor.
Analyze this engineering drawing, architectural plan, or construction site photograph carefully:
1. Extract all visible axes, grid dimensions, member sizes, concrete grades, and reinforcement schedules.
2. Calculate concrete volume (m³) and steel reinforcement weight (kg/Tons) ONLY where dimensions are visible.
3. Explicitly separate [Verified Measurements from Drawing] from [Empirical Engineering Estimates].
4. Never invent dimensions that are not present in the image. If a dimension is missing, state what is required.
5. For site photos, identify visible construction defects, safety hazards, and prepare a structured Snag List.`
      : `You are Mr. Hany (مستر هاني), an expert multimodal vision analyst.
Analyze the uploaded image with precision: describe contents, extract all visible text and tables via OCR, interpret diagrams or screenshots, and answer the user's question in their preferred language (Arabic or English).`;

    const { result: response, actualModel, fallbackReason } = await this.withRetryAndFallback(
      async (modelToUse) =>
        await ai.models.generateContent({
          model: modelToUse,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: params.mimeType,
                  data: params.base64Data,
                },
              },
              {
                text: params.prompt || "حلل هذه الصورة بالتفصيل واستخرج كافة البيانات والنصوص والجداول.",
              },
            ],
          },
          config: {
            systemInstruction: sysInstruction,
          },
        }),
      primaryModel,
      "gemini-3.8-flash"
    );

    const totalTokens =
      (response.usageMetadata?.promptTokenCount || 0) +
      (response.usageMetadata?.candidatesTokenCount || 0);

    return {
      text: response.text || "",
      modelUsed: actualModel,
      skillUsed: params.isEngineeringMode ? "EngineeringSkill" : "ImageSkill",
      tokensUsed: totalTokens || 650,
      fallbackApplied: fallbackReason,
    };
  }

  /**
   * Video Content Understanding using gemini-4-argon
   */
  public async analyzeVideo(params: {
    base64Data: string;
    mimeType: string;
    prompt: string;
  }): Promise<GeminiGenerationResult> {
    const ai = this.getClient();
    const primaryModel = "gemini-4-argon";

    const { result: response, actualModel, fallbackReason } = await this.withRetryAndFallback(
      async (modelToUse) =>
        await ai.models.generateContent({
          model: modelToUse,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: params.mimeType,
                  data: params.base64Data,
                },
              },
              {
                text:
                  params.prompt ||
                  "Analyze this video thoroughly. Summarize key events, timestamps, visual observations, and any spoken or written information in Arabic and English.",
              },
            ],
          },
          config: {
            systemInstruction:
              "You are Mr. Hany (مستر هاني), an advanced video intelligence and site inspection analyst. Provide a chronological breakdown, key observations, and actionable takeaways.",
          },
        }),
      primaryModel,
      "gemini-3.8-flash"
    );

    const totalTokens =
      (response.usageMetadata?.promptTokenCount || 0) +
      (response.usageMetadata?.candidatesTokenCount || 0);

    return {
      text: response.text || "",
      modelUsed: actualModel,
      skillUsed: "VideoSkill",
      tokensUsed: totalTokens || 950,
      fallbackApplied: fallbackReason,
    };
  }

  /**
   * Audio Transcription using gemini-3.5-transcribe
   */
  public async transcribeAudio(params: {
    base64Data: string;
    mimeType: string;
    languageHint?: string;
  }): Promise<{ transcript: string; tokensUsed: number; modelUsed: string }> {
    const ai = this.getClient();
    const { result: response, actualModel } = await this.withRetryAndFallback(
      async (modelToUse) =>
        await ai.models.generateContent({
          model: modelToUse,
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: params.mimeType || "audio/wav",
                  data: params.base64Data,
                },
              },
              {
                text: "Transcribe this audio accurately. Support Modern Standard Arabic, Egyptian Arabic, Gulf Arabic, and English.",
              },
            ],
          },
        }),
      "gemini-3.5-transcribe",
      "gemini-3.8-flash"
    );

    const totalTokens =
      (response.usageMetadata?.promptTokenCount || 0) +
      (response.usageMetadata?.candidatesTokenCount || 0);

    const parts = (response.candidates?.[0]?.content?.parts || []) as any[];
    const extractedSegments: string[] = [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.trim()) {
        extractedSegments.push(part.text.trim());
      }
      if (part.audioTranscription) {
        const at = part.audioTranscription;
        if (typeof at === "string" && at.trim()) {
          extractedSegments.push(at.trim());
        } else if (typeof at?.text === "string" && at.text.trim()) {
          extractedSegments.push(at.text.trim());
        } else if (typeof at?.transcript === "string" && at.transcript.trim()) {
          extractedSegments.push(at.transcript.trim());
        } else if (Array.isArray(at?.tokens)) {
          extractedSegments.push(at.tokens.map((t: any) => t?.text || t).join(" ").trim());
        } else {
          const str = JSON.stringify(at);
          if (str && str !== "{}") extractedSegments.push(str);
        }
      }
    }

    const finalTranscript = extractedSegments.join(" ").trim();

    return {
      transcript: finalTranscript,
      tokensUsed: totalTokens || 220,
      modelUsed: actualModel,
    };
  }

  /**
   * Text-to-Speech (TTS) using gemini-3.8-flash-lite-tts
   * Returns complete WAV file base64 (24kHz mono 16-bit)
   */
  public async synthesizeSpeech(text: string): Promise<string | undefined> {
    try {
      const ai = this.getClient();
      const cleanText = text.replace(/[#*_`~>-]/g, "").slice(0, 900);
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash-lite-tts",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: cleanText,
                speechMetadata: {
                  style: "Warm, articulate, professional advisor",
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: "Kore" },
            },
          },
        },
      });

      return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    } catch (err: any) {
      logger.warn("TTS synthesis warning", { error: err?.message || String(err) });
      return undefined;
    }
  }

  /**
   * Dynamic AI Content Planning & Structured Document Specification Engine
   * Generates custom, domain-specific specifications for Excel, Word, PDF, and PowerPoint.
   */
  public async generateStructuredFileSpec(params: {
    fileType: "word" | "excel" | "pdf" | "pptx" | "boq";
    prompt: string;
    language: "ar" | "en";
    conversationContext?: string;
    imageBase64?: string;
    imageMimeType?: string;
  }): Promise<{ spec: any; modelUsed: string; tokensUsed: number }> {
    const ai = this.getClient();
    const primaryModel = params.fileType === "boq" ? "gemini-4-argon" : "gemini-3.8-flash";
    const langInstruction =
      params.language === "ar"
        ? "Arabic (use accurate professional Arabic terminology)"
        : "English (use accurate professional English terminology)";

    const contextBlock = params.conversationContext
      ? `\nAdditional Context from Conversation / Uploaded Document:\n${params.conversationContext.slice(0, 3500)}\n`
      : "";

    const buildContents = (textPrompt: string) => {
      if (params.imageBase64 && params.imageMimeType?.startsWith("image/")) {
        return {
          parts: [
            {
              inlineData: {
                mimeType: params.imageMimeType,
                data: params.imageBase64,
              },
            },
            { text: textPrompt },
          ],
        };
      }
      return textPrompt;
    };

    if (params.fileType === "excel" || params.fileType === "boq") {
      const excelPrompt = `You are Mr. Hany's Dynamic Excel Architect.
Design a complete, customized Excel spreadsheet specification specifically for the user's request:
USER REQUEST: "${params.prompt}"
${contextBlock}
TARGET LANGUAGE: ${langInstruction}

CRITICAL RULES FOR DYNAMIC EXCEL GENERATION:
1. NEVER use generic placeholder data. Customize the sheetName, title, column headers, and 6 to 8 realistic data rows to match the exact subject of the user's request.
2. Column Mapping:
   - Column A is index 0 in each row array.
   - Column B is index 1.
   - Column C is index 2.
   - Column D is index 3.
   - Column E is index 4.
   - Column F is index 5.
   - Column G is index 6.
   - Column H is index 7.
3. ACTUAL WORKING EXCEL FORMULAS:
   - Any calculated column in a row MUST be a real Excel formula string starting with "=" and using "{ROW}" as the placeholder for the current row's Excel row number!
   - Example A (Monthly Employee Salaries & Deductions):
     Headers: ["Emp ID", "Employee Name", "Department", "Basic Salary", "Allowances", "Gross Salary", "Tax Deduction", "Insurance/Other Deduction", "Total Deductions", "Net Salary"]
     In each row:
     - Col D (Basic), Col E (Allowances), Col G (Tax), Col H (Insurance) are numeric values (e.g. "8500", "1500", "450", "350").
     - Col F (Gross Salary) MUST be: "=D{ROW}+E{ROW}"
     - Col I (Total Deductions) MUST be: "=G{ROW}+H{ROW}"
     - Col J (Net Salary) MUST be: "=F{ROW}-I{ROW}"
   - Example B (Reinforcement Steel / Rebar Quantities):
     Headers: ["Element / Mark", "Bar Diameter (mm)", "Number of Bars", "Bar Length (m)", "Total Length (m)", "Unit Weight (kg/m)", "Total Weight (kg)"]
     In each row:
     - Col B (Diameter e.g. 12, 16, 20), Col C (Count), Col D (Length) are numbers.
     - Col E (Total Length) MUST be: "=C{ROW}*D{ROW}"
     - Col F (Unit Weight = D²/162) MUST be: "=ROUND((B{ROW}^2)/162, 3)"
     - Col G (Total Weight) MUST be: "=ROUND(E{ROW}*F{ROW}, 2)"
   - Example C (Concrete Quantity Calculations):
     Headers: ["Element ID", "Element Description", "Count", "Length (m)", "Width (m)", "Depth/Height (m)", "Unit Volume (m3)", "Total Concrete Volume (m3)"]
     In each row:
     - Col C (Count), Col D (Length), Col E (Width), Col F (Depth/Height) are numbers.
     - Col G (Unit Volume) MUST be: "=ROUND(D{ROW}*E{ROW}*F{ROW}, 3)"
     - Col H (Total Concrete Volume) MUST be: "=ROUND(C{ROW}*G{ROW}, 3)"
   - For any other request, design appropriate columns and real "={ROW}" formulas matching that exact domain!
4. Do NOT add a "TOTAL" row at the bottom of "rows" — the Excel engine automatically generates the bottom TOTAL row with =SUM(...) formulas.`;

      const { result: response, actualModel } = await this.withRetryAndFallback(
        async (modelToUse) =>
          await ai.models.generateContent({
            model: modelToUse,
            contents: buildContents(excelPrompt),
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  summary: { type: Type.STRING },
                  sheetName: { type: Type.STRING },
                  headers: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  rows: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING },
                    },
                  },
                  notes: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: ["title", "summary", "sheetName", "headers", "rows", "notes"],
              },
            },
          }),
        primaryModel,
        "gemini-3.8-flash"
      );

      const tokensUsed =
        (response.usageMetadata?.promptTokenCount || 0) +
        (response.usageMetadata?.candidatesTokenCount || 0) || 640;

      return {
        spec: JSON.parse((response.text ?? "{}").trim()),
        modelUsed: actualModel,
        tokensUsed,
      };
    }

    if (params.fileType === "pptx") {
      const pptxPrompt = `You are Mr. Hany's Executive Presentation Architect.
Create a customized, content-rich PowerPoint presentation specification specifically for:
USER REQUEST: "${params.prompt}"
${contextBlock}
TARGET LANGUAGE: ${langInstruction}
Include 5 to 7 detailed slides, key metrics, a summary data table on at least one slide, and speaker notes.`;

      const { result: response, actualModel } = await this.withRetryAndFallback(
        async (modelToUse) =>
          await ai.models.generateContent({
            model: modelToUse,
            contents: buildContents(pptxPrompt),
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  subtitle: { type: Type.STRING },
                  summary: { type: Type.STRING },
                  slides: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        slideTitle: { type: Type.STRING },
                        bullets: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
                        keyMetric: { type: Type.STRING },
                        tableHeaders: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
                        tableRows: {
                          type: Type.ARRAY,
                          items: {
                            type: Type.ARRAY,
                            items: { type: Type.STRING },
                          },
                        },
                        speakerNotes: { type: Type.STRING },
                      },
                      required: ["slideTitle", "bullets"],
                    },
                  },
                },
                required: ["title", "subtitle", "summary", "slides"],
              },
            },
          }),
        primaryModel,
        "gemini-3.8-flash"
      );

      const tokensUsed =
        (response.usageMetadata?.promptTokenCount || 0) +
        (response.usageMetadata?.candidatesTokenCount || 0) || 620;

      return {
        spec: JSON.parse((response.text ?? "{}").trim()),
        modelUsed: actualModel,
        tokensUsed,
      };
    }

    // Word (DOCX) or PDF structured report
    const docPrompt = `You are Mr. Hany's Senior Technical & Executive Document Architect.
Write a comprehensive, custom-tailored ${params.fileType.toUpperCase()} document specification specifically for:
USER REQUEST: "${params.prompt}"
${contextBlock}
TARGET LANGUAGE: ${langInstruction}

CRITICAL REQUIREMENTS:
1. Every section, heading, paragraph, inspection/summary table row, and technical note MUST directly address the exact details of the user's request (e.g., specific room numbers, defect types, project items, inspection findings, financial figures, or technical specs mentioned by the user).
2. Never use generic filler text.
3. Include:
   - Specific title, subtitle, referenceNumber, and departmentOrLocation.
   - Detailed executiveSummary.
   - 3 to 4 structured sections with rich paragraphs and bullet points.
   - A comprehensive inspection/data table (tableTitle, tableHeaders, and 5 to 8 detailed tableRows).
   - A dedicated notes array and recommendations array.`;

    const { result: response, actualModel } = await this.withRetryAndFallback(
      async (modelToUse) =>
        await ai.models.generateContent({
          model: modelToUse,
          contents: buildContents(docPrompt),
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                subtitle: { type: Type.STRING },
                referenceNumber: { type: Type.STRING },
                departmentOrLocation: { type: Type.STRING },
                executiveSummary: { type: Type.STRING },
                sections: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      heading: { type: Type.STRING },
                      paragraphs: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                      bullets: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                    },
                    required: ["heading", "paragraphs"],
                  },
                },
                tableTitle: { type: Type.STRING },
                tableHeaders: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                tableRows: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                notes: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                recommendations: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
              required: [
                "title",
                "executiveSummary",
                "sections",
                "tableTitle",
                "tableHeaders",
                "tableRows",
                "notes",
                "recommendations",
              ],
            },
          },
        }),
      primaryModel,
      "gemini-3.8-flash"
    );

    const tokensUsed =
      (response.usageMetadata?.promptTokenCount || 0) +
      (response.usageMetadata?.candidatesTokenCount || 0) || 720;

    return {
      spec: JSON.parse((response.text ?? "{}").trim()),
      modelUsed: actualModel,
      tokensUsed,
    };
  }
}

export const serverGemini = new ServerGeminiService();
