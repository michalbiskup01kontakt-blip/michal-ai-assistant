import OpenAI from "openai";
import { google } from "googleapis";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

function detectSheetRead(message: string) {
  const text = message.toLowerCase();

  const asksAboutSheet =
    text.includes("arkusz") ||
    text.includes("arkuszu") ||
    text.includes("tabela") ||
    text.includes("wydatki");

  const asksToRead =
    text.includes("ile") ||
    text.includes("pokaż") ||
    text.includes("sprawdź") ||
    text.includes("przeanalizuj") ||
    text.includes("podsumuj");

  const asksToCreate =
    text.includes("stwórz") ||
    text.includes("utwórz") ||
    text.includes("załóż") ||
    text.includes("wygeneruj arkusz");

  return asksAboutSheet && asksToRead && !asksToCreate;
}

function detectSheetCreate(message: string) {
  const text = message.toLowerCase();

  return (
    text.includes("stwórz") ||
    text.includes("utwórz") ||
    text.includes("załóż")
  ) && (
    text.includes("arkusz") ||
    text.includes("tabelę") ||
    text.includes("tabela")
  );
}

function detectDriveSearch(message: string) {
  const text = message.toLowerCase();

  return (
    text.includes("dysk") ||
    text.includes("drive") ||
    text.includes("plik") ||
    text.includes("folder") ||
    text.includes("znajdź plik") ||
    text.includes("pokaż pliki")
  );
}

function extractSheetName(message: string) {
  const text = message.toLowerCase();

  if (text.includes("wydatki maj 2026")) return "Wydatki maj 2026";
  if (text.includes("wydatki")) return "wydatki";

  const match = message.match(
    /arkusz(?:u)?\s+([a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ0-9\s]+)/i
  );

  if (match?.[1]) {
    return match[1].trim();
  }

  return "wydatki";
}

export async function POST(req: Request) {
  try {
    const { messages, userEmail, googleAccessToken } = await req.json();

    const lastMessage = messages[messages.length - 1]?.text || "";

    await supabase.from("messages").insert({
      role: "user",
      text: lastMessage,
      user_email: userEmail,
    });

    if (!googleAccessToken) {
      const text =
        "Brak dostępu do Google. Wyloguj się i zaloguj ponownie przez Google.";

      return Response.json({ text });
    }

    const oauth2Client = new google.auth.OAuth2();

    oauth2Client.setCredentials({
      access_token: googleAccessToken,
    });

    const drive = google.drive({
      version: "v3",
      auth: oauth2Client,
    });

    const sheets = google.sheets({
      version: "v4",
      auth: oauth2Client,
    });

    // ================= DRIVE =================

    if (detectDriveSearch(lastMessage)) {
      let searchQuery = "";

      const lower = lastMessage.toLowerCase();

      if (lower.includes("ostatnie")) {
        const recentFiles = await drive.files.list({
          pageSize: 10,
          orderBy: "modifiedTime desc",
          fields:
            "files(id,name,mimeType,modifiedTime,webViewLink)",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });

        const files = recentFiles.data.files || [];

        if (!files.length) {
          return Response.json({
            text: "Nie znalazłem żadnych plików na Dysku Google.",
          });
        }

        const formatted = files
          .map(
            (f, i) =>
              `${i + 1}. ${f.name}\nTyp: ${f.mimeType}\nLink: ${f.webViewLink}`
          )
          .join("\n\n");

        const text = `Oto Twoje ostatnie pliki z Dysku Google:\n\n${formatted}`;

        await supabase.from("messages").insert({
          role: "assistant",
          text,
          user_email: userEmail,
        });

        return Response.json({ text });
      }

      const match = lastMessage.match(
        /(?:plik|folder|arkusz|dokument)\s+(.+)/i
      );

      if (match?.[1]) {
        searchQuery = match[1];
      } else {
        searchQuery = lastMessage;
      }

      const filesResult = await drive.files.list({
        q: `name contains '${searchQuery.replace(/'/g, "\\'")}' and trashed=false`,
        pageSize: 10,
        fields:
          "files(id,name,mimeType,modifiedTime,webViewLink)",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });

      const files = filesResult.data.files || [];

      if (!files.length) {
        return Response.json({
          text: `Nie znalazłem plików pasujących do: "${searchQuery}".`,
        });
      }

      const formatted = files
        .map(
          (f, i) =>
            `${i + 1}. ${f.name}\nTyp: ${f.mimeType}\nLink: ${f.webViewLink}`
        )
        .join("\n\n");

      const text = `Znalazłem pliki:\n\n${formatted}`;

      await supabase.from("messages").insert({
        role: "assistant",
        text,
        user_email: userEmail,
      });

      return Response.json({ text });
    }

    // ================= SHEETS READ =================

    const shouldReadSheet = detectSheetRead(lastMessage);
    const shouldCreateSheet = detectSheetCreate(lastMessage);

    if (shouldReadSheet) {
      const sheetNameToFind = extractSheetName(lastMessage);

      const files = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name contains '${sheetNameToFind.replace(
          /'/g,
          "\\'"
        )}'`,
        fields: "files(id,name)",
        pageSize: 20,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });

      const foundFile = files.data.files?.[0];

      if (!foundFile?.id) {
        return Response.json({
          text: `Nie znalazłem arkusza "${sheetNameToFind}".`,
        });
      }

      const spreadsheetInfo = await sheets.spreadsheets.get({
        spreadsheetId: foundFile.id,
      });

      const firstSheetName =
        spreadsheetInfo.data.sheets?.[0]?.properties?.title || "Dane";

      const sheetData = await sheets.spreadsheets.values.get({
        spreadsheetId: foundFile.id,
        range: `${firstSheetName}!A1:Z1000`,
      });

      const values = sheetData.data.values || [];

      const analysis = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Użytkownik pyta o dane z Google Sheets.

Pytanie:
${lastMessage}

Dane:
${JSON.stringify(values)}

Odpowiedz po polsku.
`,
      });

      const text = analysis.output_text;

      await supabase.from("messages").insert({
        role: "assistant",
        text,
        user_email: userEmail,
      });

      return Response.json({ text });
    }

    // ================= SHEETS CREATE =================

    if (shouldCreateSheet) {
      const spreadsheet = await sheets.spreadsheets.create({
        requestBody: {
          properties: {
            title: lastMessage,
          },
        },
      });

      const text = `Gotowe ✅ Utworzyłem arkusz Google.\n${spreadsheet.data.spreadsheetUrl}`;

      await supabase.from("messages").insert({
        role: "assistant",
        text,
        user_email: userEmail,
      });

      return Response.json({ text });
    }

    // ================= NORMAL AI CHAT =================

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      tools: [{ type: "web_search" }],
      input: messages.map((msg: any) => ({
        role: msg.role,
        content: msg.text,
      })),
    });

    const assistantText = response.output_text;

    await supabase.from("messages").insert({
      role: "assistant",
      text: assistantText,
      user_email: userEmail,
    });

    return Response.json({
      text: assistantText,
    });
  } catch (error) {
    console.error(error);

    return Response.json({
      text: "Wystąpił błąd serwera.",
    });
  }
}