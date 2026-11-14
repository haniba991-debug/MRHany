import fs from "fs";
import PDFDocument from "pdfkit";
import { DocxSpec } from "./docx.generator";

const FONT_CANDIDATES_REGULAR = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
];

const FONT_CANDIDATES_BOLD = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/noto/NotoSansArabic-Bold.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
];

export class PdfGenerator {
  private static resolveFontPath(candidates: string[]): string | undefined {
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }

  /**
   * Ensures Arabic words in mixed or RTL lines render in proper visual order in PDFKit
   * when OpenType shaping is applied.
   */
  private static hasArabic(text: string): boolean {
    return /[\u0600-\u06FF]/.test(text);
  }

  public static async generate(spec: DocxSpec): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const isRtl = Boolean(spec.isRtl || this.hasArabic(spec.title || "") || this.hasArabic(spec.executiveSummary || ""));
      const doc = new PDFDocument({
        margin: 48,
        size: "A4",
        bufferPages: true,
        info: {
          Title: spec.title || "Mr. Hany Technical Report",
          Author: "Mr. Hany – Advanced AI Assistant",
          Subject: spec.subtitle || "AI Generated Official PDF Report",
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", (err) => reject(err));

      // Register TrueType fonts that contain both Arabic and Latin glyphs
      const regPath = this.resolveFontPath(FONT_CANDIDATES_REGULAR);
      const boldPath = this.resolveFontPath(FONT_CANDIDATES_BOLD);
      const fontRegular = regPath ? "EmbeddedRegular" : "Helvetica";
      const fontBold = boldPath ? "EmbeddedBold" : "Helvetica-Bold";

      if (regPath) {
        doc.registerFont("EmbeddedRegular", regPath);
      }
      if (boldPath) {
        doc.registerFont("EmbeddedBold", boldPath);
      }

      const textAlign = isRtl ? "right" : "left";
      const pageWidth = 595.28;
      const margin = 48;
      const contentWidth = pageWidth - margin * 2;

      const ensureSpace = (neededHeight: number) => {
        if (doc.y + neededHeight > 760) {
          doc.addPage();
        }
      };

      // Top Navy Banner Box
      doc.rect(margin, 44, contentWidth, 68).fill("#0F172A");
      doc
        .font(fontBold)
        .fontSize(17)
        .fillColor("#FFFFFF")
        .text(spec.title || "Official Technical Report", margin + 16, 56, {
          width: contentWidth - 32,
          align: "center",
        });

      const subLine =
        spec.subtitle ||
        (isRtl
          ? `تقرير فني رسمي • مستر هاني • ${new Date().toISOString().slice(0, 10)}`
          : `Official Technical Report • Prepared by Mr. Hany • ${new Date().toISOString().slice(0, 10)}`);

      doc
        .font(fontRegular)
        .fontSize(9.5)
        .fillColor("#CBD5E1")
        .text(subLine, margin + 16, 86, {
          width: contentWidth - 32,
          align: "center",
        });

      doc.y = 128;

      // Optional Embedded Image if provided
      if (spec.imageBase64) {
        try {
          const imgBuf = Buffer.from(spec.imageBase64, "base64");
          if (imgBuf.length > 100) {
            ensureSpace(190);
            doc.image(imgBuf, margin + 80, doc.y, { width: contentWidth - 160, height: 170 });
            doc.y += 184;
          }
        } catch {
          // Ignore image decode issues
        }
      }

      // 1. Executive Summary
      if (spec.executiveSummary) {
        ensureSpace(70);
        doc
          .font(fontBold)
          .fontSize(13)
          .fillColor("#0F172A")
          .text(isRtl ? "الملخص التنفيذي / Executive Summary" : "Executive Summary", margin, doc.y, {
            width: contentWidth,
            align: textAlign,
          });
        doc.moveDown(0.3);
        doc
          .font(fontRegular)
          .fontSize(10)
          .fillColor("#1E293B")
          .text(spec.executiveSummary, margin, doc.y, {
            width: contentWidth,
            align: textAlign,
            lineGap: 3,
          });
        doc.moveDown(0.8);
      }

      // 2. Dynamic Content Sections
      for (const sec of spec.sections || []) {
        ensureSpace(65);
        doc
          .font(fontBold)
          .fontSize(12)
          .fillColor("#0F172A")
          .text(sec.heading, margin, doc.y, {
            width: contentWidth,
            align: textAlign,
          });
        doc.moveDown(0.25);

        for (const p of sec.paragraphs || []) {
          ensureSpace(35);
          doc
            .font(fontRegular)
            .fontSize(10)
            .fillColor("#334155")
            .text(p, margin, doc.y, {
              width: contentWidth,
              align: textAlign,
              lineGap: 2.5,
            });
          doc.moveDown(0.35);
        }

        if (sec.bullets && sec.bullets.length > 0) {
          for (const b of sec.bullets) {
            ensureSpace(24);
            doc
              .font(fontRegular)
              .fontSize(9.5)
              .fillColor("#1E293B")
              .text(`• ${b}`, margin + (isRtl ? 0 : 10), doc.y, {
                width: contentWidth - 10,
                align: textAlign,
              });
            doc.moveDown(0.2);
          }
          doc.moveDown(0.35);
        }
      }

      // 3. Dynamic Bordered Grid Table (Inspection / Data Table)
      if (
        spec.tableHeaders &&
        spec.tableHeaders.length > 0 &&
        spec.tableRows &&
        spec.tableRows.length > 0
      ) {
        ensureSpace(90);
        doc.moveDown(0.3);
        doc
          .font(fontBold)
          .fontSize(12)
          .fillColor("#0F172A")
          .text(
            spec.tableTitle ||
              (isRtl ? "جدول الفحص والبيانات التفصيلية" : "Inspection & Data Schedule"),
            margin,
            doc.y,
            { width: contentWidth, align: textAlign }
          );
        doc.moveDown(0.4);

        const colCount = spec.tableHeaders.length;
        const colWidth = contentWidth / colCount;
        let tableY = doc.y;

        // Draw Table Header Row
        const headerHeight = 26;
        for (let c = 0; c < colCount; c++) {
          const colIdx = isRtl ? colCount - 1 - c : c;
          const cellX = margin + c * colWidth;
          doc.rect(cellX, tableY, colWidth, headerHeight).fillAndStroke("#1E293B", "#0F172A");
          doc
            .font(fontBold)
            .fontSize(9)
            .fillColor("#FFFFFF")
            .text(String(spec.tableHeaders[colIdx] ?? ""), cellX + 4, tableY + 7, {
              width: colWidth - 8,
              align: "center",
            });
        }
        tableY += headerHeight;

        // Draw Table Data Rows
        for (let rIdx = 0; rIdx < spec.tableRows.length; rIdx++) {
          const row = spec.tableRows[rIdx];
          // Estimate row height based on longest cell text
          let maxCellLines = 1;
          for (let c = 0; c < colCount; c++) {
            const cellStr = String(row[c] ?? "");
            const approxCharsPerLine = Math.max(12, Math.floor((colWidth - 10) / 5));
            const lines = Math.ceil(cellStr.length / approxCharsPerLine) || 1;
            if (lines > maxCellLines) maxCellLines = lines;
          }
          const rowHeight = Math.max(22, Math.min(maxCellLines * 14 + 8, 72));

          if (tableY + rowHeight > 750) {
            doc.addPage();
            tableY = 56;
          }

          const bgFill = rIdx % 2 === 1 ? "#F8FAFC" : "#FFFFFF";
          for (let c = 0; c < colCount; c++) {
            const colIdx = isRtl ? colCount - 1 - c : c;
            const cellX = margin + c * colWidth;
            const cellText = String(row[colIdx] ?? "");
            doc.rect(cellX, tableY, colWidth, rowHeight).fillAndStroke(bgFill, "#CBD5E1");
            doc
              .font(fontRegular)
              .fontSize(8.5)
              .fillColor("#1E293B")
              .text(cellText, cellX + 5, tableY + 6, {
                width: colWidth - 10,
                align: c === 0 ? "center" : textAlign,
              });
          }
          tableY += rowHeight;
        }
        doc.y = tableY + 14;
      }

      // 4. Dedicated Notes & Recommendations Section
      const notesCombined = [
        ...(Array.isArray(spec.notes) ? spec.notes : []),
        ...(Array.isArray(spec.recommendations) ? spec.recommendations : []),
      ];

      if (notesCombined.length > 0) {
        ensureSpace(85);
        doc
          .font(fontBold)
          .fontSize(11.5)
          .fillColor("#0F172A")
          .text(
            isRtl ? "الملاحظات الفنية والتوصيات (Notes & Remarks):" : "Notes & Technical Remarks:",
            margin,
            doc.y,
            { width: contentWidth, align: textAlign }
          );
        doc.moveDown(0.3);

        for (const note of notesCombined) {
          ensureSpace(24);
          doc
            .font(fontRegular)
            .fontSize(9.5)
            .fillColor("#1E293B")
            .text(`• ${note}`, margin, doc.y, {
              width: contentWidth,
              align: textAlign,
            });
          doc.moveDown(0.25);
        }
        doc.moveDown(0.5);
      }

      // 5. Official Signature Section
      ensureSpace(75);
      const sigY = doc.y + 10;
      const boxW = (contentWidth - 24) / 3;
      const sigTitles = [
        spec.signatureLabels?.preparedBy || (isRtl ? "إعداد / Prepared By" : "Prepared By"),
        spec.signatureLabels?.reviewedBy || (isRtl ? "مراجعة / Reviewed By" : "Reviewed By"),
        spec.signatureLabels?.approvedBy || (isRtl ? "اعتماد / Approved By" : "Approved By"),
      ];

      sigTitles.forEach((label, idx) => {
        const bx = margin + idx * (boxW + 12);
        doc.rect(bx, sigY, boxW, 52).fillAndStroke("#F8FAFC", "#CBD5E1");
        doc
          .font(fontBold)
          .fontSize(8.5)
          .fillColor("#334155")
          .text(label, bx + 6, sigY + 8, { width: boxW - 12, align: "center" });
        doc
          .font(fontRegular)
          .fontSize(8)
          .fillColor("#94A3B8")
          .text("____________________", bx + 6, sigY + 32, { width: boxW - 12, align: "center" });
      });

      // 6. Stamp Page Numbers & Footer on all buffered pages
      const range = doc.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        doc.switchToPage(i);
        doc
          .font(fontRegular)
          .fontSize(8)
          .fillColor("#64748B")
          .text(
            `Mr. Hany AI Platform • ${new Date().toISOString().slice(0, 10)} • Page ${i + 1} of ${range.count}`,
            margin,
            792,
            { width: contentWidth, align: "center", lineBreak: false }
          );
      }

      doc.end();
    });
  }
}
