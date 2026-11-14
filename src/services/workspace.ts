import { getAccessToken } from "./firebase";

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export class GoogleWorkspaceService {
  private static requireToken(): string {
    const token = getAccessToken();
    if (!token) {
      throw new Error("WORKSPACE_AUTH_REQUIRED");
    }
    return token;
  }

  /**
   * 1. Google Docs API: Create a new Google Doc and insert formatted text
   */
  public static async createGoogleDoc(title: string, bodyText: string): Promise<{ documentId: string; url: string }> {
    const token = this.requireToken();
    const createRes = await fetch("https://docs.googleapis.com/v1/documents", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Failed to create Google Doc (${createRes.status})`);
    }

    const created = await createRes.json();
    const documentId = created.documentId;

    if (bodyText && bodyText.trim().length > 0) {
      await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                location: { index: 1 },
                text: bodyText,
              },
            },
          ],
        }),
      });
    }

    return {
      documentId,
      url: `https://docs.google.com/document/d/${documentId}/edit`,
    };
  }

  /**
   * Read an existing Google Doc by Document ID
   */
  public static async readGoogleDoc(documentId: string): Promise<{ title: string; text: string }> {
    const token = this.requireToken();
    const cleanId = documentId.trim();
    const res = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(cleanId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Unable to fetch Google Doc (${res.status})`);
    }
    const data = await res.json();
    let extracted = "";
    const content = data.body?.content || [];
    for (const el of content) {
      if (el.paragraph?.elements) {
        for (const pEl of el.paragraph.elements) {
          if (pEl.textRun?.content) {
            extracted += pEl.textRun.content;
          }
        }
      }
    }
    return {
      title: data.title || "Untitled Document",
      text: extracted,
    };
  }

  /**
   * 2. Google Sheets API: Create a new Spreadsheet and populate rows
   * Best practice: never hardcode Sheet1 without checking metadata
   */
  public static async createGoogleSheet(params: {
    title: string;
    sheetName?: string;
    headers: string[];
    rows: Array<Array<string | number>>;
  }): Promise<{ spreadsheetId: string; url: string }> {
    const token = this.requireToken();
    const tabTitle = (params.sheetName || "BOQ_Data").slice(0, 30);

    const createRes = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: { title: params.title },
        sheets: [{ properties: { title: tabTitle } }],
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Failed to create Google Sheet (${createRes.status})`);
    }

    const created = await createRes.json();
    const spreadsheetId = created.spreadsheetId;
    const actualSheetTitle = created.sheets?.[0]?.properties?.title || tabTitle;

    const values = [params.headers, ...params.rows];
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
        `${actualSheetTitle}!A1`
      )}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ values }),
      }
    );

    return {
      spreadsheetId,
      url: created.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
    };
  }

  /**
   * Read an existing Google Sheet by ID (fetches sheet metadata first to avoid hardcoding Sheet1)
   */
  public static async readGoogleSheet(spreadsheetId: string): Promise<{
    title: string;
    sheetNames: string[];
    activeSheet: string;
    rows: string[][];
  }> {
    const token = this.requireToken();
    const cleanId = spreadsheetId.trim();
    const metaRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cleanId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) {
      const err = await metaRes.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Unable to fetch Spreadsheet metadata (${metaRes.status})`);
    }
    const meta = await metaRes.json();
    const sheetNames: string[] = (meta.sheets || []).map((s: any) => s.properties?.title).filter(Boolean);
    const firstSheet = sheetNames[0] || "Sheet1";

    const valRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cleanId)}/values/${encodeURIComponent(
        `${firstSheet}!A1:Z50`
      )}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const valData = await valRes.json();
    return {
      title: meta.properties?.title || "Spreadsheet",
      sheetNames,
      activeSheet: firstSheet,
      rows: valData.values || [],
    };
  }

  /**
   * 3. Google Slides API: Create a new presentation deck
   */
  public static async createGoogleSlides(params: {
    title: string;
    slides: Array<{ slideTitle: string; bullets: string[] }>;
  }): Promise<{ presentationId: string; url: string }> {
    const token = this.requireToken();
    const createRes = await fetch("https://slides.googleapis.com/v1/presentations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: params.title }),
    });

    if (!createRes.ok) {
      const err = await createRes.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Failed to create Google Slides (${createRes.status})`);
    }

    const created = await createRes.json();
    const presentationId = created.presentationId;

    const requests: any[] = [];
    (params.slides || []).forEach((s, idx) => {
      const slideObjectId = `mr_hany_slide_${idx + 1}_${Date.now()}`;
      const titleId = `mr_hany_title_${idx + 1}_${Date.now()}`;
      const bodyId = `mr_hany_body_${idx + 1}_${Date.now()}`;
      requests.push(
        {
          createSlide: {
            objectId: slideObjectId,
            slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" },
            placeholderIdMappings: [
              {
                layoutPlaceholder: { type: "TITLE", index: 0 },
                objectId: titleId,
              },
              {
                layoutPlaceholder: { type: "BODY", index: 0 },
                objectId: bodyId,
              },
            ],
          },
        },
        {
          insertText: {
            objectId: titleId,
            text: s.slideTitle,
          },
        },
        {
          insertText: {
            objectId: bodyId,
            text: (s.bullets || []).map((b) => `• ${b}`).join("\n"),
          },
        }
      );
    });

    if (requests.length > 0) {
      await fetch(`https://slides.googleapis.com/v1/presentations/${presentationId}:batchUpdate`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requests }),
      });
    }

    return {
      presentationId,
      url: `https://docs.google.com/presentation/d/${presentationId}/edit`,
    };
  }

  /**
   * 4. Gmail API: List recent messages & Send email
   */
  public static async listGmailMessages(maxResults: number = 6): Promise<GmailMessageSummary[]> {
    const token = this.requireToken();
    const listRes = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!listRes.ok) {
      const err = await listRes.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Failed to list Gmail messages (${listRes.status})`);
    }
    const listData = await listRes.json();
    const messages = listData.messages || [];
    const details: GmailMessageSummary[] = [];

    for (const m of messages.slice(0, maxResults)) {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (msgRes.ok) {
        const msgData = await msgRes.json();
        const headers: Array<{ name: string; value: string }> = msgData.payload?.headers || [];
        const getH = (name: string) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
        details.push({
          id: m.id,
          threadId: m.threadId,
          subject: getH("Subject") || "(No Subject)",
          from: getH("From") || "Unknown Sender",
          date: getH("Date") || "",
          snippet: msgData.snippet || "",
        });
      }
    }
    return details;
  }

  public static async sendGmailMessage(params: {
    to: string;
    subject: string;
    body: string;
  }): Promise<{ id: string }> {
    const token = this.requireToken();
    const utf8Subject = `=?utf-8?B?${btoa(unescape(encodeURIComponent(params.subject)))}?=`;
    const rawEmail = [
      `To: ${params.to}`,
      "Content-Type: text/plain; charset=utf-8",
      "MIME-Version: 1.0",
      `Subject: ${utf8Subject}`,
      "",
      params.body,
    ].join("\r\n");

    const base64UrlEmail = btoa(unescape(encodeURIComponent(rawEmail)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: base64UrlEmail }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || `Failed to send Gmail message (${res.status})`);
    }
    return await res.json();
  }

  /**
   * 5. Google Keep API (Enterprise Workspace endpoint with consumer fallback notice)
   */
  public static async tryFetchKeepNotes(): Promise<{ enterpriseSupported: boolean; notes: any[] }> {
    const token = this.requireToken();
    try {
      const res = await fetch("https://keep.googleapis.com/v1/notes", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        return { enterpriseSupported: false, notes: [] };
      }
      const data = await res.json();
      return { enterpriseSupported: true, notes: data.notes || [] };
    } catch {
      return { enterpriseSupported: false, notes: [] };
    }
  }
}
