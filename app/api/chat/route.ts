import { NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import * as XLSX from "xlsx";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const message = body.message;
    const accessToken = body.accessToken;
    const userEmail = body.userEmail;

    if (!message) {
      return NextResponse.json({
        reply: "Brak wiadomości.",
      });
    }

    // ZAPIS USER MSG
    await supabase.from("messages").insert({
      role: "user",
      text: message,
    });

    // =========================
    // GOOGLE AUTH
    // =========================

    const auth = new google.auth.OAuth2();
    auth.setCredentials({
      access_token: accessToken,
    });

    const drive = google.drive({
      version: "v3",
      auth,
    });

    const gmail = google.gmail({
      version: "v1",
      auth,
    });

    const sheets = google.sheets({
      version: "v4",
      auth,
    });

    const lower = message.toLowerCase();

    // =====================================================
    // MEMORY
    // =====================================================

    if (
      lower.includes("zapamiętaj") ||
      lower.includes("pamietaj")
    ) {
      const content = message
        .replace("zapamiętaj", "")
        .replace("pamietaj", "")
        .trim();

      await supabase.from("memory").insert({
        user_email: userEmail,
        key: content.substring(0, 50),
        value: content,
      });

      return NextResponse.json({
        reply: `Zapamiętałem ✅ ${content}`,
      });
    }

    // =====================================================
    // MEMORY SEARCH
    // =====================================================

    if (
      lower.includes("czy pamiętasz") ||
      lower.includes("pamietasz") ||
      lower.includes("przypomnij")
    ) {
      const { data } = await supabase
        .from("memory")
        .select("*")
        .eq("user_email", userEmail);

      if (!data?.length) {
        return NextResponse.json({
          reply: "Nie mam jeszcze zapisanych informacji.",
        });
      }

      const joined = data.map((x) => x.value).join("\n");

      return NextResponse.json({
        reply: `Pamiętam:\n\n${joined}`,
      });
    }

    // =====================================================
    // GMAIL
    // =====================================================

    if (
      lower.includes("mail") ||
      lower.includes("gmail") ||
      lower.includes("maile")
    ) {
      const gmailRes = await gmail.users.messages.list({
        userId: "me",
        maxResults: 5,
      });

      const msgs = gmailRes.data.messages || [];

      if (!msgs.length) {
        return NextResponse.json({
          reply: "Nie znalazłem maili.",
        });
      }

      let result = "📧 Ostatnie maile:\n\n";

      for (const msg of msgs) {
        const full = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
        });

        const headers = full.data.payload?.headers || [];

        const subject =
          headers.find((h) => h.name === "Subject")?.value ||
          "Brak tematu";

        const from =
          headers.find((h) => h.name === "From")?.value ||
          "Nieznany";

        result += `📩 ${subject}\n👤 ${from}\n\n`;
      }

      return NextResponse.json({
        reply: result,
      });
    }

    // =====================================================
    // DRIVE FILES
    // =====================================================

    if (
      lower.includes("plik") ||
      lower.includes("dysk") ||
      lower.includes("drive")
    ) {
      const files = await drive.files.list({
        pageSize: 10,
        fields: "files(id,name,mimeType,webViewLink)",
      });

      const items = files.data.files || [];

      if (!items.length) {
        return NextResponse.json({
          reply: "Nie znalazłem plików.",
        });
      }

      let text = "📁 Oto Twoje pliki:\n\n";

      items.forEach((f, i) => {
        text += `${i + 1}. ${f.name}\n${f.webViewLink}\n\n`;
      });

      return NextResponse.json({
        reply: text,
      });
    }

    // =====================================================
    // FIND SHEET
    // =====================================================

    if (
      lower.includes("arkusz") ||
      lower.includes("excel") ||
      lower.includes("sheet")
    ) {
      const files = await drive.files.list({
        pageSize: 20,
        fields: "files(id,name,mimeType,webViewLink)",
      });

      const items = files.data.files || [];

      const xlsxFile = items.find(
        (f) =>
          f.name?.toLowerCase().includes("personel") ||
          f.name?.toLowerCase().includes("wydatki")
      );

      if (!xlsxFile) {
        return NextResponse.json({
          reply: "Nie znalazłem odpowiedniego arkusza.",
        });
      }

      return NextResponse.json({
        reply: `📄 Znalazłem arkusz:\n\n${xlsxFile.name}\n${xlsxFile.webViewLink}`,
      });
    }

    // =====================================================
    // XLSX / GOOGLE SHEETS SEARCH
    // =====================================================

    if (
      lower.includes("numer") ||
      lower.includes("telefon") ||
      lower.includes("email") ||
      lower.includes("kontakt")
    ) {
      const files = await drive.files.list({
        pageSize: 30,
        fields: "files(id,name,mimeType)",
      });

      const allFiles = files.data.files || [];

      const target = allFiles.find((f) =>
        f.name?.toLowerCase().includes("personel")
      );

      if (!target) {
        return NextResponse.json({
          reply: "Nie znalazłem arkusza Personel.",
        });
      }

      // =========================================
      // GOOGLE SHEETS
      // =========================================

      if (
        target.mimeType ===
        "application/vnd.google-apps.spreadsheet"
      ) {
        const sheetData = await sheets.spreadsheets.values.get({
          spreadsheetId: target.id!,
          range: "A:Z",
        });

        const rows = sheetData.data.values || [];

        const prompt = `
Znajdź poprawną odpowiedź w tabeli.

Tabela:
${JSON.stringify(rows)}

Pytanie:
${message}

Odpowiedz krótko i konkretnie.
`;

        const ai = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        });

        return NextResponse.json({
          reply: ai.choices[0].message.content,
        });
      }

      // =========================================
      // XLSX
      // =========================================

      const fileRes = await drive.files.get(
        {
          fileId: target.id!,
          alt: "media",
        },
        {
          responseType: "arraybuffer",
        }
      );

      const workbook = XLSX.read(fileRes.data, {
        type: "buffer",
      });

      const firstSheet =
        workbook.Sheets[workbook.SheetNames[0]];

      const jsonData = XLSX.utils.sheet_to_json(firstSheet, {
        header: 1,
      });

      const prompt = `
Znajdź poprawną odpowiedź w tabeli Excel.

Tabela:
${JSON.stringify(jsonData)}

Pytanie:
${message}

Odpowiedz bardzo krótko.
`;

      const ai = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      });

      return NextResponse.json({
        reply: ai.choices[0].message.content,
      });
    }

    // =====================================================
    // CALENDAR
    // =====================================================

    if (
      lower.includes("spotkanie") ||
      lower.includes("kalendarz")
    ) {
      const calendar = google.calendar({
        version: "v3",
        auth,
      });

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const start = new Date(tomorrow);
      start.setHours(13, 0, 0);

      const end = new Date(tomorrow);
      end.setHours(14, 0, 0);

      await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: "Spotkanie",
          start: {
            dateTime: start.toISOString(),
          },
          end: {
            dateTime: end.toISOString(),
          },
        },
      });

      return NextResponse.json({
        reply: "✅ Dodałem wydarzenie do kalendarza.",
      });
    }

    // =====================================================
    // DEFAULT AI
    // =====================================================

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Jesteś prywatnym polskim asystentem AI Michała.",
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    const reply =
      completion.choices[0].message.content ||
      "Brak odpowiedzi.";

    await supabase.from("messages").insert({
      role: "assistant",
      text: reply,
    });

    return NextResponse.json({
      reply,
    });
  } catch (error: any) {
    console.error(error);

    return NextResponse.json({
      reply: "Wystąpił błąd serwera.",
    });
  }
}