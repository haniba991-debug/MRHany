import fs from "fs";
import path from "path";

const TEMP_STORAGE_DIR = path.join("/tmp", "mr_hany_generated_files");
const RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours retention policy

export interface StoredGeneratedFile {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
}

export class TempFileStorage {
  private static ensureDir() {
    if (!fs.existsSync(TEMP_STORAGE_DIR)) {
      fs.mkdirSync(TEMP_STORAGE_DIR, { recursive: true });
    }
  }

  /**
   * Builds a unique, descriptive filename tailored to the user's request title and extension.
   */
  public static buildUniqueFileName(rawTitle: string, ext: "docx" | "xlsx" | "pdf" | "pptx"): string {
    const cleanBase = (rawTitle || "Mr_Hany_Document")
      .replace(/[^\w\u0600-\u06FF\s-]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .slice(0, 42);

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate()
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(
      now.getMinutes()
    ).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;

    const safePrefix = cleanBase || `Mr_Hany_${ext.toUpperCase()}`;
    return `${safePrefix}_${stamp}.${ext}`;
  }

  /**
   * Writes the validated file buffer to temporary storage and runs retention cleanup.
   */
  public static saveGeneratedFile(buffer: Buffer, fileName: string): StoredGeneratedFile {
    this.ensureDir();
    this.cleanupExpiredFiles();

    const safeName = path.basename(fileName);
    const fullPath = path.join(TEMP_STORAGE_DIR, safeName);
    fs.writeFileSync(fullPath, buffer);
    const stat = fs.statSync(fullPath);

    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`Failed to persist generated file to disk: ${fullPath}`);
    }

    return {
      filePath: fullPath,
      fileName: safeName,
      sizeBytes: stat.size,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Cleans up temporary generated files older than RETENTION_MS.
   */
  public static cleanupExpiredFiles(): void {
    try {
      this.ensureDir();
      const now = Date.now();
      const entries = fs.readdirSync(TEMP_STORAGE_DIR);
      for (const entry of entries) {
        const fullPath = path.join(TEMP_STORAGE_DIR, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (now - stat.mtimeMs > RETENTION_MS) {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // Ignore individual file unlink races
        }
      }
    } catch {
      // Ignore directory cleanup errors
    }
  }
}
