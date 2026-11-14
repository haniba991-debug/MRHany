import ExcelJS from "exceljs";

export interface ExcelSheetSpec {
  sheetName: string;
  title: string;
  subtitle?: string;
  headers: string[];
  rows: Array<Array<string | number>>;
  includeTotalsRow?: boolean;
  notes?: string[];
}

export interface ExcelSpec {
  title: string;
  summary?: string;
  sheetName?: string;
  headers?: string[];
  rows?: Array<Array<string | number>>;
  sheets?: ExcelSheetSpec[];
  notes?: string[];
  isRtl?: boolean;
}

export class ExcelGenerator {
  /**
   * Converts 1-based column index (1 -> A, 2 -> B, 27 -> AA)
   */
  public static colIndexToLetter(colIdx1Based: number): string {
    let temp = colIdx1Based;
    let letter = "";
    while (temp > 0) {
      const mod = (temp - 1) % 26;
      letter = String.fromCharCode(65 + mod) + letter;
      temp = Math.floor((temp - mod) / 26);
    }
    return letter;
  }

  /**
   * Converts column letter (A -> 1, B -> 2)
   */
  public static letterToColIndex(letter: string): number {
    let col = 0;
    const up = letter.toUpperCase();
    for (let i = 0; i < up.length; i++) {
      col = col * 26 + (up.charCodeAt(i) - 64);
    }
    return col;
  }

  /**
   * Normalizes an Excel formula for a specific Excel row number (e.g. Row 3, Row 4...).
   * - Strips leading '='
   * - Replaces {ROW} or [ROW] placeholders with excelRowNum
   * - Fixes common LLM off-by-one row references (e.g., if LLM wrote =B2*C2 for the first data row at Excel Row 3)
   */
  public static normalizeRowFormula(
    rawFormula: string,
    excelRowNum: number,
    dataRowIndex0Based: number,
    firstDataExcelRow: number
  ): string {
    let f = rawFormula.trim().replace(/^=+/, "").trim();

    // Replace explicit placeholders
    f = f.replace(/\{ROW\}|\[ROW\]/gi, String(excelRowNum));

    // If this is not an aggregate range formula (like SUM(D3:D10)), check if cell refs need row alignment
    if (!f.includes(":")) {
      const cellRefRegex = /\b([A-Z]{1,2})(\d{1,4})\b/g;
      const matches = [...f.matchAll(cellRefRegex)];
      if (matches.length > 0) {
        const referencedRows = matches.map((m) => Number(m[2]));
        const allSameRow = referencedRows.every((r) => r === referencedRows[0]);
        if (allSameRow) {
          const refRow = referencedRows[0];
          // If LLM used 1-based data row (1, 2, 3...) or header-based row (2, 3, 4...) instead of excelRowNum
          if (
            refRow !== excelRowNum &&
            (refRow === dataRowIndex0Based + 1 ||
              refRow === dataRowIndex0Based + 2 ||
              refRow === firstDataExcelRow - 1)
          ) {
            f = f.replace(cellRefRegex, `$1${excelRowNum}`);
          }
        }
      }
    }

    return f;
  }

  /**
   * Evaluates basic Excel formulas (arithmetic, ^, ROUND, SUM, AVERAGE, MIN, MAX)
   * so that ExcelJS stores both the live formula AND the pre-calculated numeric result.
   */
  private static evaluateFormula(
    formulaWithoutEquals: string,
    getCellNumericValue: (colIdx1Based: number, excelRow: number) => number
  ): number | undefined {
    try {
      let expr = formulaWithoutEquals.trim();

      // Handle SUM(X3:X10) / AVERAGE(X3:X10) / MIN / MAX
      expr = expr.replace(
        /\b(SUM|AVERAGE|MIN|MAX)\s*\(\s*([A-Z]{1,2})(\d+)\s*:\s*([A-Z]{1,2})(\d+)\s*\)/gi,
        (_match, fnName, col1, row1Str, col2, row2Str) => {
          const c1 = this.letterToColIndex(col1);
          const c2 = this.letterToColIndex(col2);
          const r1 = Math.min(Number(row1Str), Number(row2Str));
          const r2 = Math.max(Number(row1Str), Number(row2Str));
          const vals: number[] = [];
          for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
            for (let r = r1; r <= r2; r++) {
              vals.push(getCellNumericValue(c, r));
            }
          }
          if (vals.length === 0) return "0";
          const sum = vals.reduce((a, b) => a + b, 0);
          const upperFn = String(fnName).toUpperCase();
          if (upperFn === "SUM") return String(sum);
          if (upperFn === "AVERAGE") return String(sum / vals.length);
          if (upperFn === "MIN") return String(Math.min(...vals));
          if (upperFn === "MAX") return String(Math.max(...vals));
          return String(sum);
        }
      );

      // Handle SUM(A3,B3,C3) comma-separated
      expr = expr.replace(/\bSUM\s*\(([^():]+)\)/gi, (_m, inner) => {
        const parts = String(inner).split(",");
        return `(${parts.join("+")})`;
      });

      // Handle ROUND(val, digits)
      expr = expr.replace(/\bROUND\s*\(([^,]+),\s*(\d+)\)/gi, (_m, valExpr, digitsStr) => {
        const factor = Math.pow(10, Number(digitsStr) || 2);
        return `(Math.round((${valExpr}) * ${factor}) / ${factor})`;
      });

      // Replace single cell references (e.g. B3, C4) with their numeric values
      expr = expr.replace(/\b([A-Z]{1,2})(\d{1,4})\b/g, (_m, colLet, rowStr) => {
        const cIdx = this.letterToColIndex(colLet);
        const rIdx = Number(rowStr);
        const val = getCellNumericValue(cIdx, rIdx);
        return String(Number.isFinite(val) ? val : 0);
      });

      // Convert Excel exponentiation (^) to JS (**)
      expr = expr.replace(/\^/g, "**");

      // Only evaluate if expression contains safe math tokens
      if (!/^[0-9+\-*/().,\s*Math.round]+$/.test(expr)) {
        return undefined;
      }

      const evaluated = Function(`"use strict"; return (${expr});`)();
      if (typeof evaluated === "number" && Number.isFinite(evaluated)) {
        return Math.round(evaluated * 10000) / 10000;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  public static async generate(spec: ExcelSpec): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Mr. Hany AI Assistant";
    workbook.lastModifiedBy = "Mr. Hany Dynamic File Engine";
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.calcProperties.fullCalcOnLoad = true;

    const isRtl = Boolean(spec.isRtl);

    const sheetsToRender: ExcelSheetSpec[] =
      Array.isArray(spec.sheets) && spec.sheets.length > 0
        ? spec.sheets
        : [
            {
              sheetName: spec.sheetName || "Sheet1",
              title: spec.title || "Mr. Hany Analytical Sheet",
              subtitle: spec.summary,
              headers: spec.headers || ["Column 1", "Column 2"],
              rows: spec.rows || [],
              includeTotalsRow: true,
              notes: spec.notes,
            },
          ];

    const usedNames = new Set<string>();

    for (let sIdx = 0; sIdx < sheetsToRender.length; sIdx++) {
      const sheetSpec = sheetsToRender[sIdx];
      let cleanSheetName = (sheetSpec.sheetName || `Sheet_${sIdx + 1}`)
        .replace(/[\\/?*[\]:]/g, "")
        .trim()
        .slice(0, 28);
      if (!cleanSheetName) cleanSheetName = `Sheet_${sIdx + 1}`;
      if (usedNames.has(cleanSheetName.toLowerCase())) {
        cleanSheetName = `${cleanSheetName.slice(0, 24)}_${sIdx + 1}`;
      }
      usedNames.add(cleanSheetName.toLowerCase());

      const headers =
        Array.isArray(sheetSpec.headers) && sheetSpec.headers.length > 0
          ? sheetSpec.headers
          : ["Item", "Description", "Value"];
      const colCount = headers.length;
      const hasSubtitle = Boolean(sheetSpec.subtitle && sheetSpec.subtitle.trim());
      const headerExcelRow = hasSubtitle ? 3 : 2;
      const firstDataExcelRow = headerExcelRow + 1;

      const sheet = workbook.addWorksheet(cleanSheetName, {
        views: [{ rightToLeft: isRtl, state: "frozen", ySplit: headerExcelRow }],
        pageSetup: {
          paperSize: 9, // A4
          orientation: colCount > 5 ? "landscape" : "portrait",
          fitToPage: true,
          fitToWidth: 1,
          fitToHeight: 0,
          margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
        },
      });

      // Row 1: Title Banner
      sheet.mergeCells(1, 1, 1, Math.max(colCount, 3));
      const titleCell = sheet.getCell(1, 1);
      titleCell.value = sheetSpec.title || spec.title || "Mr. Hany AI Workbook";
      titleCell.font = { name: "Arial", bold: true, size: 14, color: { argb: "FFFFFFFF" } };
      titleCell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF0F172A" },
      };
      titleCell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      sheet.getRow(1).height = 32;

      // Optional Row 2: Subtitle / Context Banner
      if (hasSubtitle) {
        sheet.mergeCells(2, 1, 2, Math.max(colCount, 3));
        const subCell = sheet.getCell(2, 1);
        subCell.value = sheetSpec.subtitle;
        subCell.font = { name: "Arial", italic: false, size: 10, color: { argb: "FF334155" } };
        subCell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FFF1F5F9" },
        };
        subCell.alignment = {
          vertical: "middle",
          horizontal: isRtl ? "right" : "left",
          wrapText: true,
        };
        sheet.getRow(2).height = 24;
      }

      // Header Row
      const hRow = sheet.getRow(headerExcelRow);
      headers.forEach((hText, idx) => {
        const cell = hRow.getCell(idx + 1);
        cell.value = String(hText);
        cell.font = { name: "Arial", bold: true, size: 11, color: { argb: "FFFFFFFF" } };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF1E293B" },
        };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = {
          top: { style: "medium", color: { argb: "FF0F172A" } },
          bottom: { style: "medium", color: { argb: "FF0F172A" } },
          left: { style: "thin", color: { argb: "FF475569" } },
          right: { style: "thin", color: { argb: "FF475569" } },
        };
        sheet.getColumn(idx + 1).width = Math.max(String(hText).length + 10, 18);
      });
      hRow.height = 28;

      // Track numeric values in memory for formula evaluation
      const numericGrid = new Map<string, number>();
      const getGridVal = (c1: number, r1: number): number => {
        return numericGrid.get(`${c1}:${r1}`) ?? 0;
      };
      const setGridVal = (c1: number, r1: number, val: number) => {
        if (Number.isFinite(val)) {
          numericGrid.set(`${c1}:${r1}`, val);
        }
      };

      const rowsData = Array.isArray(sheetSpec.rows) ? sheetSpec.rows : [];
      const numericColumnsTracker = new Array<boolean>(colCount).fill(false);

      rowsData.forEach((rowVals, rIdx0) => {
        const excelRowNum = firstDataExcelRow + rIdx0;
        const r = sheet.getRow(excelRowNum);
        const isZebra = rIdx0 % 2 === 1;

        for (let cIdx0 = 0; cIdx0 < colCount; cIdx0++) {
          const col1 = cIdx0 + 1;
          const rawVal = rowVals[cIdx0];
          const cell = r.getCell(col1);
          const strVal = String(rawVal ?? "").trim();

          if (strVal.startsWith("=")) {
            const cleanFormula = this.normalizeRowFormula(
              strVal,
              excelRowNum,
              rIdx0,
              firstDataExcelRow
            );
            const computed = this.evaluateFormula(cleanFormula, getGridVal);
            cell.value = {
              formula: cleanFormula,
              result: computed !== undefined ? computed : 0,
            };
            if (computed !== undefined) {
              setGridVal(col1, excelRowNum, computed);
            }
            cell.numFmt = "#,##0.00";
            cell.alignment = { vertical: "middle", horizontal: "right" };
            cell.font = { name: "Arial", bold: true, size: 10.5, color: { argb: "FF0F172A" } };
            numericColumnsTracker[cIdx0] = true;
          } else {
            // Check if pure number (or number with commas/currency)
            const cleanedNumStr = strVal.replace(/,/g, "");
            const numericCandidate =
              typeof rawVal === "number"
                ? rawVal
                : cleanedNumStr !== "" && /^-?\d+(\.\d+)?$/.test(cleanedNumStr)
                ? Number(cleanedNumStr)
                : NaN;

            if (!Number.isNaN(numericCandidate)) {
              cell.value = numericCandidate;
              setGridVal(col1, excelRowNum, numericCandidate);
              // Integer vs decimal formatting
              cell.numFmt = Number.isInteger(numericCandidate) ? "#,##0" : "#,##0.00";
              cell.alignment = { vertical: "middle", horizontal: "right" };
              cell.font = { name: "Arial", size: 10.5, color: { argb: "FF1E293B" } };
              numericColumnsTracker[cIdx0] = true;
            } else {
              cell.value = strVal;
              cell.alignment = {
                vertical: "middle",
                horizontal: cIdx0 === 0 ? "center" : isRtl ? "right" : "left",
                wrapText: true,
              };
              cell.font = { name: "Arial", size: 10.5, color: { argb: "FF1E293B" } };
            }
          }

          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: isZebra ? "FFF8FAFC" : "FFFFFFFF" },
          };
          cell.border = {
            top: { style: "thin", color: { argb: "FFCBD5E1" } },
            bottom: { style: "thin", color: { argb: "FFCBD5E1" } },
            left: { style: "thin", color: { argb: "FFCBD5E1" } },
            right: { style: "thin", color: { argb: "FFCBD5E1" } },
          };

          // Expand column width if needed
          const colObj = sheet.getColumn(col1);
          const displayLen = strVal.startsWith("=") ? 14 : Math.min(strVal.length + 6, 42);
          if ((colObj.width || 16) < displayLen) {
            colObj.width = displayLen;
          }
        }
        r.height = 22;
      });

      // Second pass on formula cells in case a formula referenced a column to its right
      rowsData.forEach((rowVals, rIdx0) => {
        const excelRowNum = firstDataExcelRow + rIdx0;
        const r = sheet.getRow(excelRowNum);
        for (let cIdx0 = 0; cIdx0 < colCount; cIdx0++) {
          const strVal = String(rowVals[cIdx0] ?? "").trim();
          if (strVal.startsWith("=")) {
            const col1 = cIdx0 + 1;
            const cell = r.getCell(col1);
            const cleanFormula = this.normalizeRowFormula(
              strVal,
              excelRowNum,
              rIdx0,
              firstDataExcelRow
            );
            const computed = this.evaluateFormula(cleanFormula, getGridVal);
            if (computed !== undefined) {
              setGridVal(col1, excelRowNum, computed);
              cell.value = { formula: cleanFormula, result: computed };
            }
          }
        }
      });

      // Check if last row is already a Total row
      const lastRowFirstCells =
        rowsData.length > 0
          ? rowsData[rowsData.length - 1]
              .slice(0, 2)
              .map((x) => String(x || "").toLowerCase())
              .join(" ")
          : "";
      const alreadyHasTotalRow =
        lastRowFirstCells.includes("total") ||
        lastRowFirstCells.includes("الإجمالي") ||
        lastRowFirstCells.includes("المجموع") ||
        lastRowFirstCells.includes("اجمالي");

      // Automatically append a working Totals row with =SUM(...) formulas if not already present
      if (
        sheetSpec.includeTotalsRow !== false &&
        rowsData.length > 0 &&
        !alreadyHasTotalRow &&
        numericColumnsTracker.some(Boolean)
      ) {
        const totalExcelRow = firstDataExcelRow + rowsData.length;
        const lastDataExcelRow = totalExcelRow - 1;
        const tRow = sheet.getRow(totalExcelRow);

        for (let cIdx0 = 0; cIdx0 < colCount; cIdx0++) {
          const col1 = cIdx0 + 1;
          const cell = tRow.getCell(col1);
          const headerLower = String(headers[cIdx0] || "").toLowerCase();

          // Do not sum ID, diameter, unit weight, unit rate, or percentage columns
          const isNonSummableRateOrId =
            cIdx0 === 0 ||
            headerLower.includes("id") ||
            headerLower.includes("رقم") ||
            headerLower.includes("كود") ||
            headerLower.includes("diameter") ||
            headerLower.includes("قطر") ||
            headerLower.includes("unit weight") ||
            headerLower.includes("وزن المتر") ||
            headerLower.includes("rate") ||
            headerLower.includes("سعر الوحدة");

          if (cIdx0 === 0) {
            cell.value = isRtl ? "الإجمالي" : "TOTAL";
            cell.alignment = { vertical: "middle", horizontal: "center" };
          } else if (numericColumnsTracker[cIdx0] && !isNonSummableRateOrId) {
            const colLetter = this.colIndexToLetter(col1);
            const sumFormula = `SUM(${colLetter}${firstDataExcelRow}:${colLetter}${lastDataExcelRow})`;
            const sumResult = this.evaluateFormula(sumFormula, getGridVal) ?? 0;
            cell.value = { formula: sumFormula, result: sumResult };
            cell.numFmt = "#,##0.00";
            cell.alignment = { vertical: "middle", horizontal: "right" };
          } else {
            cell.value = "";
          }

          cell.font = { name: "Arial", bold: true, size: 11, color: { argb: "FF0F172A" } };
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFE2E8F0" },
          };
          cell.border = {
            top: { style: "medium", color: { argb: "FF0F172A" } },
            bottom: { style: "double", color: { argb: "FF0F172A" } },
            left: { style: "thin", color: { argb: "FF94A3B8" } },
            right: { style: "thin", color: { argb: "FF94A3B8" } },
          };
        }
        tRow.height = 26;
      }

      // Add Conditional Formatting on the last numeric column for visual clarity
      const lastNumericColIdx = numericColumnsTracker.lastIndexOf(true);
      if (lastNumericColIdx >= 0 && rowsData.length > 1) {
        const colLetter = this.colIndexToLetter(lastNumericColIdx + 1);
        const endRow = firstDataExcelRow + rowsData.length - 1;
        sheet.addConditionalFormatting({
          ref: `${colLetter}${firstDataExcelRow}:${colLetter}${endRow}`,
          rules: [
            {
              type: "cellIs",
              operator: "greaterThan",
              priority: 1,
              formulae: [0],
              style: {
                font: { bold: true, color: { argb: "FF0369A1" } },
              },
            },
          ],
        });
      }

      // Optional Technical Notes below table
      const sheetNotes = sheetSpec.notes || (sIdx === 0 ? spec.notes : undefined);
      if (Array.isArray(sheetNotes) && sheetNotes.length > 0) {
        const noteStartRow = sheet.rowCount + 2;
        const noteHeaderCell = sheet.getCell(noteStartRow, 1);
        noteHeaderCell.value = isRtl ? "ملاحظات فنية وتنظيمية:" : "Technical Notes & Remarks:";
        noteHeaderCell.font = { name: "Arial", bold: true, size: 10.5, color: { argb: "FF0F172A" } };
        sheetNotes.forEach((n, idx) => {
          const rNum = noteStartRow + 1 + idx;
          sheet.mergeCells(rNum, 1, rNum, Math.max(colCount, 3));
          const c = sheet.getCell(rNum, 1);
          c.value = `• ${n}`;
          c.font = { name: "Arial", size: 9.5, color: { argb: "FF475569" } };
          c.alignment = { horizontal: isRtl ? "right" : "left" };
        });
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
