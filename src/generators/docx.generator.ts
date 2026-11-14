import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  WidthType,
  BorderStyle,
  Header,
  Footer,
  PageNumber,
  ImageRun,
} from "docx";

export interface DocxSpec {
  title: string;
  subtitle?: string;
  referenceNumber?: string;
  departmentOrLocation?: string;
  executiveSummary: string;
  sections: Array<{
    heading: string;
    paragraphs: string[];
    bullets?: string[];
  }>;
  tableTitle?: string;
  tableHeaders?: string[];
  tableRows?: string[][];
  notes?: string[];
  recommendations?: string[];
  signatureLabels?: {
    preparedBy?: string;
    reviewedBy?: string;
    approvedBy?: string;
  };
  imageBase64?: string;
  isRtl?: boolean;
}

export class DocxGenerator {
  public static async generate(spec: DocxSpec): Promise<Buffer> {
    const isRtl = Boolean(spec.isRtl);
    const align = isRtl ? AlignmentType.RIGHT : AlignmentType.LEFT;
    const children: any[] = [];

    // 1. Document Main Title
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        bidirectional: isRtl,
        spacing: { after: 120 },
        children: [
          new TextRun({
            text: spec.title || (isRtl ? "تقرير فني رسمي" : "Official Technical Report"),
            bold: true,
            size: 36,
            color: "0F172A",
            rightToLeft: isRtl,
          }),
        ],
      })
    );

    if (spec.subtitle) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          bidirectional: isRtl,
          spacing: { after: 160 },
          children: [
            new TextRun({
              text: spec.subtitle,
              size: 22,
              color: "475569",
              rightToLeft: isRtl,
            }),
          ],
        })
      );
    }

    // Metadata Line (Date, Reference, Location)
    const dateStr = new Date().toISOString().slice(0, 10);
    const refText = spec.referenceNumber || `REF-${Date.now().toString().slice(-6)}`;
    const metaLine = isRtl
      ? `المرجع: ${refText}  |  التاريخ: ${dateStr}${spec.departmentOrLocation ? `  |  الموقع/القسم: ${spec.departmentOrLocation}` : ""}`
      : `Ref: ${refText}  |  Date: ${dateStr}${spec.departmentOrLocation ? `  |  Location/Dept: ${spec.departmentOrLocation}` : ""}`;

    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        bidirectional: isRtl,
        spacing: { after: 320 },
        border: {
          bottom: { color: "CBD5E1", space: 8, style: BorderStyle.SINGLE, size: 6 },
        },
        children: [
          new TextRun({
            text: metaLine,
            size: 18,
            color: "64748B",
            rightToLeft: isRtl,
          }),
        ],
      })
    );

    // Optional Embedded Photo if user uploaded an image
    if (spec.imageBase64) {
      try {
        const imgBuf = Buffer.from(spec.imageBase64, "base64");
        if (imgBuf.length > 100) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 120, after: 240 },
              children: [
                new ImageRun({
                  data: imgBuf,
                  transformation: { width: 420, height: 260 },
                  type: "jpg",
                }),
              ],
            })
          );
        }
      } catch {
        // Ignore invalid image buffer
      }
    }

    // 2. Executive Summary
    if (spec.executiveSummary) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_1,
          alignment: align,
          bidirectional: isRtl,
          spacing: { before: 200, after: 120 },
          children: [
            new TextRun({
              text: isRtl ? "1. الملخص التنفيذي" : "1. Executive Summary",
              bold: true,
              size: 28,
              color: "0F172A",
              rightToLeft: isRtl,
            }),
          ],
        }),
        new Paragraph({
          alignment: align,
          bidirectional: isRtl,
          spacing: { after: 240 },
          children: [
            new TextRun({
              text: spec.executiveSummary,
              size: 22,
              color: "1E293B",
              rightToLeft: isRtl,
            }),
          ],
        })
      );
    }

    // 3. Dynamic Content Sections
    for (const section of spec.sections || []) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          alignment: align,
          bidirectional: isRtl,
          spacing: { before: 240, after: 120 },
          children: [
            new TextRun({
              text: section.heading,
              bold: true,
              size: 26,
              color: "0F172A",
              rightToLeft: isRtl,
            }),
          ],
        })
      );

      for (const p of section.paragraphs || []) {
        children.push(
          new Paragraph({
            alignment: align,
            bidirectional: isRtl,
            spacing: { after: 140 },
            children: [
              new TextRun({
                text: p,
                size: 22,
                color: "334155",
                rightToLeft: isRtl,
              }),
            ],
          })
        );
      }

      if (section.bullets && section.bullets.length > 0) {
        for (const bullet of section.bullets) {
          children.push(
            new Paragraph({
              alignment: align,
              bidirectional: isRtl,
              spacing: { after: 80 },
              children: [
                new TextRun({
                  text: `• ${bullet}`,
                  size: 21,
                  color: "1E293B",
                  rightToLeft: isRtl,
                }),
              ],
            })
          );
        }
      }
    }

    // 4. Dynamic Inspection / Data Table
    if (
      spec.tableHeaders &&
      spec.tableHeaders.length > 0 &&
      spec.tableRows &&
      spec.tableRows.length > 0
    ) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          alignment: align,
          bidirectional: isRtl,
          spacing: { before: 260, after: 120 },
          children: [
            new TextRun({
              text:
                spec.tableTitle ||
                (isRtl ? "جدول الفحص والبيانات التفصيلية" : "Detailed Inspection & Data Table"),
              bold: true,
              size: 26,
              color: "0F172A",
              rightToLeft: isRtl,
            }),
          ],
        })
      );

      const colCount = spec.tableHeaders.length;
      const headerCells = spec.tableHeaders.map(
        (h) =>
          new TableCell({
            width: { size: Math.floor(100 / colCount), type: WidthType.PERCENTAGE },
            shading: { fill: "0F172A" },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                bidirectional: isRtl,
                children: [
                  new TextRun({
                    text: String(h),
                    bold: true,
                    size: 20,
                    color: "FFFFFF",
                    rightToLeft: isRtl,
                  }),
                ],
              }),
            ],
          })
      );

      const dataRows = spec.tableRows.map(
        (row, rIdx) =>
          new TableRow({
            children: spec.tableHeaders!.map((_, idx) => {
              const cellVal = row[idx] ?? "";
              return new TableCell({
                shading: { fill: rIdx % 2 === 1 ? "F8FAFC" : "FFFFFF" },
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
                  bottom: { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
                  left: { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
                  right: { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
                },
                children: [
                  new Paragraph({
                    alignment: align,
                    bidirectional: isRtl,
                    children: [
                      new TextRun({
                        text: String(cellVal),
                        size: 20,
                        color: "1E293B",
                        rightToLeft: isRtl,
                      }),
                    ],
                  }),
                ],
              });
            }),
          })
      );

      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [new TableRow({ children: headerCells }), ...dataRows],
        })
      );
    }

    // 5. Notes & Recommendations Section
    const notesList = [
      ...(Array.isArray(spec.notes) ? spec.notes : []),
      ...(Array.isArray(spec.recommendations) ? spec.recommendations : []),
    ];

    if (notesList.length > 0) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_2,
          alignment: align,
          bidirectional: isRtl,
          spacing: { before: 280, after: 120 },
          children: [
            new TextRun({
              text: isRtl ? "الملاحظات الفنية والتوصيات" : "Technical Notes & Recommendations",
              bold: true,
              size: 26,
              color: "0F172A",
              rightToLeft: isRtl,
            }),
          ],
        })
      );

      for (const note of notesList) {
        children.push(
          new Paragraph({
            alignment: align,
            bidirectional: isRtl,
            spacing: { after: 90 },
            children: [
              new TextRun({
                text: `▪ ${note}`,
                size: 21,
                color: "1E293B",
                rightToLeft: isRtl,
              }),
            ],
          })
        );
      }
    }

    // 6. Signature & Official Approval Section
    const prepLabel =
      spec.signatureLabels?.preparedBy || (isRtl ? "إعداد المهندس / المسؤول" : "Prepared By");
    const revLabel =
      spec.signatureLabels?.reviewedBy || (isRtl ? "مراجعة وتدقيق" : "Reviewed By");
    const appLabel =
      spec.signatureLabels?.approvedBy || (isRtl ? "اعتماد الإدارة" : "Approved By");

    children.push(
      new Paragraph({
        spacing: { before: 360, after: 120 },
        alignment: align,
        bidirectional: isRtl,
        children: [
          new TextRun({
            text: isRtl ? "التوقيعات والاعتماد الرسمي:" : "Official Signatures & Sign-Off:",
            bold: true,
            size: 22,
            color: "0F172A",
            rightToLeft: isRtl,
          }),
        ],
      }),
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [prepLabel, revLabel, appLabel].map(
              (sigTitle) =>
                new TableCell({
                  width: { size: 33, type: WidthType.PERCENTAGE },
                  borders: {
                    top: { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
                    bottom: { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
                    left: { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
                    right: { style: BorderStyle.SINGLE, size: 1, color: "CBD5E1" },
                  },
                  children: [
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      bidirectional: isRtl,
                      spacing: { before: 80, after: 280 },
                      children: [
                        new TextRun({
                          text: sigTitle,
                          bold: true,
                          size: 19,
                          color: "334155",
                          rightToLeft: isRtl,
                        }),
                      ],
                    }),
                    new Paragraph({
                      alignment: AlignmentType.CENTER,
                      spacing: { after: 80 },
                      children: [
                        new TextRun({
                          text: "________________________",
                          size: 18,
                          color: "94A3B8",
                        }),
                      ],
                    }),
                  ],
                })
            ),
          }),
        ],
      })
    );

    const doc = new Document({
      sections: [
        {
          properties: {},
          headers: {
            default: new Header({
              children: [
                new Paragraph({
                  alignment: isRtl ? AlignmentType.LEFT : AlignmentType.RIGHT,
                  children: [
                    new TextRun({
                      text: `${spec.title || "Report"} • Mr. Hany AI`,
                      size: 16,
                      color: "64748B",
                    }),
                  ],
                }),
              ],
            }),
          },
          footers: {
            default: new Footer({
              children: [
                new Paragraph({
                  alignment: AlignmentType.CENTER,
                  children: [
                    new TextRun({
                      text: `Mr. Hany Official Document • ${dateStr} • Page `,
                      size: 16,
                      color: "64748B",
                    }),
                    new TextRun({
                      children: [PageNumber.CURRENT],
                      size: 16,
                      color: "64748B",
                    }),
                    new TextRun({
                      text: " of ",
                      size: 16,
                      color: "64748B",
                    }),
                    new TextRun({
                      children: [PageNumber.TOTAL_PAGES],
                      size: 16,
                      color: "64748B",
                    }),
                  ],
                }),
              ],
            }),
          },
          children,
        },
      ],
    });

    return await Packer.toBuffer(doc);
  }
}
