import mammoth from "mammoth";
import ExcelJS from "exceljs";

export interface ParsedDocumentResult {
  fileName: string;
  mimeType: string;
  totalCharacters: number;
  chunkCount: number;
  extractedText: string;
  chunks: string[];
  tablesPreview?: string[][];
}

export class DocumentParser {
  public static async parseDocx(buffer: Buffer): Promise<string> {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  public static async parseXlsx(buffer: Buffer): Promise<{ text: string; tablesPreview: string[][] }> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    let output = "";
    const tablesPreview: string[][] = [];

    workbook.eachSheet((worksheet) => {
      output += `\n=== Sheet: ${worksheet.name} ===\n`;
      worksheet.eachRow((row, rowNumber) => {
        const rawValues = Array.isArray(row.values) ? row.values.slice(1) : [];
        const cleanCells = rawValues.map((v) => {
          if (v === null || v === undefined) return "";
          if (typeof v === "object" && "result" in (v as any)) return String((v as any).result ?? "");
          if (typeof v === "object" && "text" in (v as any)) return String((v as any).text ?? "");
          return String(v);
        });
        if (rowNumber <= 25 && tablesPreview.length < 25) {
          tablesPreview.push(cleanCells);
        }
        output += cleanCells.join(" | ") + "\n";
      });
    });

    return { text: output, tablesPreview };
  }

  public static chunkText(text: string, chunkSize: number = 4000): string[] {
    const normalized = text.replace(/\r\n/g, "\n").trim();
    if (!normalized) return [];
    const chunks: string[] = [];
    let start = 0;
    while (start < normalized.length) {
      chunks.push(normalized.slice(start, start + chunkSize));
      start += chunkSize;
    }
    return chunks;
  }

  public static async extractDocument(
    buffer: Buffer,
    mimeType: string,
    fileName: string
  ): Promise<ParsedDocumentResult> {
    const lowerName = fileName.toLowerCase();
    let extractedText = "";
    let tablesPreview: string[][] | undefined;

    if (
      mimeType.includes("wordprocessingml") ||
      lowerName.endsWith(".docx")
    ) {
      extractedText = await this.parseDocx(buffer);
    } else if (
      mimeType.includes("spreadsheetml") ||
      lowerName.endsWith(".xlsx")
    ) {
      const parsed = await this.parseXlsx(buffer);
      extractedText = parsed.text;
      tablesPreview = parsed.tablesPreview;
    } else if (
      mimeType.includes("csv") ||
      lowerName.endsWith(".csv")
    ) {
      extractedText = buffer.toString("utf-8");
      const lines = extractedText.split(/\r?\n/).filter(Boolean).slice(0, 20);
      tablesPreview = lines.map((line) => line.split(",").map((c) => c.trim()));
    } else if (
      mimeType.includes("text") ||
      lowerName.endsWith(".txt") ||
      lowerName.endsWith(".md") ||
      lowerName.endsWith(".json")
    ) {
      extractedText = buffer.toString("utf-8");
    }

    const chunks = this.chunkText(extractedText, 4000);
    return {
      fileName,
      mimeType,
      totalCharacters: extractedText.length,
      chunkCount: chunks.length,
      extractedText,
      chunks,
      tablesPreview,
    };
  }
}
