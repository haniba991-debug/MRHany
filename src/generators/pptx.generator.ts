import pptxgen from "pptxgenjs";

export interface PptxSlideSpec {
  slideTitle: string;
  bullets: string[];
  keyMetric?: string;
  tableHeaders?: string[];
  tableRows?: string[][];
  speakerNotes?: string;
}

export interface PptxSpec {
  title: string;
  subtitle?: string;
  summary?: string;
  slides: PptxSlideSpec[];
  isRtl?: boolean;
}

export class PptxGenerator {
  public static async generate(spec: PptxSpec): Promise<Buffer> {
    const pres = new pptxgen();
    pres.layout = "LAYOUT_16x9";
    pres.author = "Mr. Hany AI Assistant";
    pres.title = spec.title || "Mr. Hany AI Presentation";
    const isRtl = Boolean(spec.isRtl || /[\u0600-\u06FF]/.test(spec.title || ""));
    const textAlign = isRtl ? "right" : "left";

    // Cover Slide
    const cover = pres.addSlide();
    cover.background = { color: "0F172A" };
    cover.addText(spec.title || "Executive Presentation", {
      x: 0.8,
      y: 1.7,
      w: "84%",
      fontSize: 30,
      bold: true,
      color: "FFFFFF",
      align: "center",
      rtlMode: isRtl,
    });
    cover.addText(spec.subtitle || (isRtl ? "إعداد: مستر هاني – المساعد الذكي" : "Prepared by Mr. Hany – Advanced AI Assistant"), {
      x: 1.0,
      y: 3.1,
      w: "80%",
      fontSize: 15,
      color: "94A3B8",
      align: "center",
      rtlMode: isRtl,
    });
    if (spec.summary) {
      cover.addText(spec.summary, {
        x: 1.2,
        y: 3.9,
        w: "76%",
        fontSize: 12,
        color: "CBD5E1",
        align: "center",
        rtlMode: isRtl,
      });
    }

    // Content Slides
    for (const slideData of spec.slides || []) {
      const slide = pres.addSlide();
      slide.background = { color: "F8FAFC" };

      slide.addText(slideData.slideTitle, {
        x: 0.6,
        y: 0.35,
        w: "88%",
        fontSize: 22,
        bold: true,
        color: "0F172A",
        align: textAlign,
        rtlMode: isRtl,
      });

      if (slideData.keyMetric) {
        slide.addText(slideData.keyMetric, {
          x: 0.6,
          y: 0.95,
          w: "88%",
          fontSize: 13,
          bold: true,
          color: "0284C7",
          align: textAlign,
          rtlMode: isRtl,
        });
      }

      const hasSlideTable =
        Array.isArray(slideData.tableHeaders) &&
        slideData.tableHeaders.length > 0 &&
        Array.isArray(slideData.tableRows) &&
        slideData.tableRows.length > 0;

      const bulletItems = (slideData.bullets || []).map((b) => ({
        text: b,
        options: {
          fontSize: 13.5,
          bullet: true,
          breakLine: true,
          color: "1E293B",
          rtlMode: isRtl,
        },
      }));

      if (bulletItems.length > 0) {
        slide.addText(bulletItems, {
          x: 0.6,
          y: slideData.keyMetric ? 1.45 : 1.15,
          w: "88%",
          h: hasSlideTable ? 1.8 : 3.7,
          lineSpacing: 22,
          align: textAlign,
        });
      }

      if (hasSlideTable) {
        const headerRow = slideData.tableHeaders!.map((h) => ({
          text: String(h),
          options: { bold: true, fill: { color: "0F172A" }, color: "FFFFFF", fontSize: 11 },
        }));
        const bodyRows = slideData.tableRows!.slice(0, 6).map((r) =>
          slideData.tableHeaders!.map((_, idx) => ({
            text: String(r[idx] ?? ""),
            options: { fontSize: 10.5, color: "1E293B" },
          }))
        );
        slide.addTable([headerRow, ...bodyRows] as any, {
          x: 0.6,
          y: bulletItems.length > 0 ? 3.3 : 1.4,
          w: 8.8,
          border: { pt: 1, color: "CBD5E1" },
        });
      }

      if (slideData.speakerNotes) {
        slide.addNotes(slideData.speakerNotes);
      }
    }

    const out = await pres.write({ outputType: "nodebuffer" });
    return Buffer.from(out as ArrayBuffer);
  }
}
