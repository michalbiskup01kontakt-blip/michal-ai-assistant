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

function normalize(text: string) {
  return text.toLowerCase();
}

function escapeGoogleQuery(text: string) {
  return text.replace(/'/g, "\\'");
}

function detectMemorySave(message: string) {
  const text = normalize(message);

  return (
    text.includes("zapamiętaj") ||
    text.includes("pamietaj") ||
    text.includes("zapamiętasz") ||
    text.includes("następnym razem będziesz pamiętał") ||
    text.includes("następnym razem bedziesz pamietal")
  );
}

function detectDriveSearch(message: string) {
  const text = normalize(message);

  return (
    text.includes("dysk") ||
    text.includes("drive") ||
    text.includes("plik") ||
    text.includes("folder")
  );
}

function detectSheetCreate(message: string) {
  const text = normalize(message);

  return (
    (text.includes("stwórz") ||
      text.includes("utwórz") ||
      text.includes("załóż")) &&
    (text.includes("arkusz") ||
      text.includes("arkuszu") ||
      text.includes("tabelę") ||
      text.includes("tabela"))
  );
}

function detectSheetQuestion(message: string) {
  const text = normalize(message);

  const mentionsSheet =
    text.includes("arkusz") ||
    text.includes("arkuszu") ||
    text.includes("arkusza") ||
    text.includes("tabela") ||
    text.includes("wydatki") ||
    text.includes("personel");

  const asksData =
    text.includes("znajdź") ||
    text.includes("wyszukaj") ||
    text.includes("pokaż") ||
    text.includes("sprawdź") ||
    text.includes("ile") ||
    text.includes("jaki") ||
    text.includes("jaka") ||
    text.includes("jakie") ||
    text.includes("kto") ||
    text.includes("numer") ||
    text.includes("telefon") ||
    text.includes("mail") ||
    text.includes("email") ||
    text.includes("suma") ||
    text.includes("podsumuj") ||
    text.includes("przeanalizuj");

  return mentionsSheet && asksData && !detectSheetCreate(message);
}

function extractBasicSheetName(message: string) {
  const text = normalize(message);

  if (text.includes("wydatki maj 2026")) return "Wydatki maj 2026";
  if (text.includes("wydatki")) return "wydatki";
  if (text.includes("personel")) return "Personel";

  const match = message.match(
    /arkusz(?:u|a)?\s+["']?([a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ0-9\s_-]+)["']?/i
  );

  if (match?.[1]) {
    return match[1].trim();
  }

  return "";
}

async function saveAssistantMessage(text: string, userEmail: string | null) {
  await supabase.from("messages").insert({
    role: "assistant",
    text,
    user_email: userEmail,
  });
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

    // ================= MEMORY SAVE =================

    if (detectMemorySave(lastMessage)) {
      const memoryAI = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Wyciągnij z wiadomości użytkownika informację do zapamiętania.

Wiadomość:
"${lastMessage}"

Zwróć WYŁĄCZNIE JSON:
{
  "key": "krótka nazwa informacji",
  "value": "konkretna wartość do zapamiętania"
}

Przykład:
Wiadomość: "Zapamiętaj że numer do Wiolety Biskup to 665331400"
Odpowiedź:
{
  "key": "numer do Wiolety Biskup",
  "value": "665331400"
}
        `,
      });

      let parsedMemory: any = null;

      try {
        parsedMemory = JSON.parse(memoryAI.output_text);
      } catch {
        parsedMemory = null;
      }

      if (parsedMemory?.key && parsedMemory?.value) {
        await supabase.from("memory").insert({
          user_email: userEmail,
          key: parsedMemory.key,
          value: parsedMemory.value,
        });

        const text = `Zapamiętałem ✅ ${parsedMemory.key}: ${parsedMemory.value}`;

        await saveAssistantMessage(text, userEmail);

        return Response.json({ text });
      }
    }

    // ================= MEMORY LOAD =================

    const { data: memoryData } = await supabase
      .from("memory")
      .select("*")
      .eq("user_email", userEmail);

    const memoryContext =
      memoryData && memoryData.length > 0
        ? `
Zapamiętane informacje użytkownika:
${memoryData.map((m) => `${m.key}: ${m.value}`).join("\n")}
`
        : "";

    if (!googleAccessToken) {
      const response = await openai.responses.create({
        model: "gpt-4.1-mini",
        tools: [{ type: "web_search" }],
        input: [
          {
            role: "system",
            content: memoryContext,
          },
          ...messages.map((msg: any) => ({
            role: msg.role,
            content: msg.text,
          })),
        ],
      });

      const assistantText = response.output_text;

      await saveAssistantMessage(assistantText, userEmail);

      return Response.json({
        text: assistantText,
      });
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

    // ================= GOOGLE SHEETS — ODCZYT I ANALIZA =================

    if (detectSheetQuestion(lastMessage)) {
      const sheetNameAI = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Z wiadomości użytkownika wyciągnij nazwę arkusza Google, którego dotyczy pytanie.

Wiadomość:
"${lastMessage}"

Zwróć WYŁĄCZNIE JSON:
{
  "sheetName": "nazwa arkusza",
  "question": "pełne pytanie użytkownika"
}

Jeśli nazwa arkusza nie jest jasna, wpisz pusty string.
        `,
      });

      let parsedSheet: any = {
        sheetName: extractBasicSheetName(lastMessage),
        question: lastMessage,
      };

      try {
        parsedSheet = JSON.parse(sheetNameAI.output_text);
      } catch {
        parsedSheet = {
          sheetName: extractBasicSheetName(lastMessage),
          question: lastMessage,
        };
      }

      const sheetNameToFind =
        parsedSheet.sheetName?.trim() || extractBasicSheetName(lastMessage);

      if (!sheetNameToFind) {
        const text =
          "Podaj proszę nazwę arkusza, z którego mam odczytać dane.";

        await saveAssistantMessage(text, userEmail);

        return Response.json({ text });
      }

      const files = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and name contains '${escapeGoogleQuery(
          sheetNameToFind
        )}'`,
        fields: "files(id,name,webViewLink,modifiedTime)",
        pageSize: 10,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });

      const foundFile = files.data.files?.[0];

      if (!foundFile?.id) {
        const text = `Nie znalazłem arkusza o nazwie zawierającej: "${sheetNameToFind}".`;

        await saveAssistantMessage(text, userEmail);

        return Response.json({ text });
      }

      const spreadsheetInfo = await sheets.spreadsheets.get({
        spreadsheetId: foundFile.id,
      });

      const allSheets =
        spreadsheetInfo.data.sheets?.map((sheet) => sheet.properties?.title) ||
        [];

      const allData: Record<string, any[][]> = {};

      for (const tabName of allSheets) {
        if (!tabName) continue;

        const sheetData = await sheets.spreadsheets.values.get({
          spreadsheetId: foundFile.id,
          range: `${tabName}!A1:Z1000`,
        });

        allData[tabName] = sheetData.data.values || [];
      }

      const analysis = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Jesteś asystentem analizującym dane z Google Sheets.

${memoryContext}

Znaleziony arkusz:
${foundFile.name}

Link do arkusza:
${foundFile.webViewLink}

Pytanie użytkownika:
${parsedSheet.question || lastMessage}

Dane ze wszystkich zakładek arkusza:
${JSON.stringify(allData)}

Zasady odpowiedzi:
- Odpowiedz po polsku.
- Nie dawaj instrukcji typu "użyj funkcji SUMIF".
- Sam przeanalizuj dane.
- Jeśli w pamięci jest korekta dotycząca pytanej osoby lub wartości, użyj pamięci jako ważniejszego źródła.
- Jeśli użytkownik pyta o numer telefonu, mail, nazwisko albo konkretną osobę, znajdź pasujący wiersz i podaj znalezione dane.
- Jeśli użytkownik pyta o sumę, policz ją na podstawie danych.
- Jeśli dane są puste albo nie ma szukanej informacji, powiedz to jasno.
- Na końcu podaj link do arkusza.
        `,
      });

      const text = analysis.output_text;

      await saveAssistantMessage(text, userEmail);

      return Response.json({ text });
    }

    // ================= GOOGLE DRIVE — WYSZUKIWANIE PLIKÓW =================

    if (detectDriveSearch(lastMessage)) {
      const lower = normalize(lastMessage);

      if (lower.includes("ostatnie")) {
        const recentFiles = await drive.files.list({
          pageSize: 10,
          orderBy: "modifiedTime desc",
          fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
          includeItemsFromAllDrives: true,
          supportsAllDrives: true,
        });

        const files = recentFiles.data.files || [];

        if (!files.length) {
          const text = "Nie znalazłem żadnych plików na Dysku Google.";

          await saveAssistantMessage(text, userEmail);

          return Response.json({ text });
        }

        const formatted = files
          .map(
            (f, i) =>
              `${i + 1}. ${f.name}\nTyp: ${f.mimeType}\nLink: ${f.webViewLink}`
          )
          .join("\n\n");

        const text = `Oto Twoje ostatnie pliki z Dysku Google:\n\n${formatted}`;

        await saveAssistantMessage(text, userEmail);

        return Response.json({ text });
      }

      let searchQuery = lastMessage;

      const match = lastMessage.match(
        /(?:plik|folder|arkusz|dokument)\s+(.+)/i
      );

      if (match?.[1]) {
        searchQuery = match[1];
      }

      const filesResult = await drive.files.list({
        q: `name contains '${escapeGoogleQuery(searchQuery)}' and trashed=false`,
        pageSize: 10,
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });

      const files = filesResult.data.files || [];

      if (!files.length) {
        const text = `Nie znalazłem plików pasujących do: "${searchQuery}".`;

        await saveAssistantMessage(text, userEmail);

        return Response.json({ text });
      }

      const formatted = files
        .map(
          (f, i) =>
            `${i + 1}. ${f.name}\nTyp: ${f.mimeType}\nLink: ${f.webViewLink}`
        )
        .join("\n\n");

      const text = `Znalazłem pliki:\n\n${formatted}`;

      await saveAssistantMessage(text, userEmail);

      return Response.json({ text });
    }

    // ================= GOOGLE SHEETS — TWORZENIE ARKUSZA =================

    if (detectSheetCreate(lastMessage)) {
      const createIntent = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Użytkownik chce stworzyć arkusz Google.

Wiadomość:
"${lastMessage}"

Zwróć WYŁĄCZNIE JSON:
{
  "title": "nazwa arkusza",
  "sheetName": "Dane",
  "headers": ["Data", "Kategoria", "Opis", "Kwota", "Uwagi"],
  "rows": []
}
        `,
      });

      let action: any = {};

      try {
        action = JSON.parse(createIntent.output_text);
      } catch {
        action = {
          title: "Nowy arkusz AI",
          sheetName: "Dane",
          headers: ["Data", "Kategoria", "Opis", "Kwota", "Uwagi"],
          rows: [],
        };
      }

      const spreadsheet = await sheets.spreadsheets.create({
        requestBody: {
          properties: {
            title: action.title || "Nowy arkusz AI",
          },
          sheets: [
            {
              properties: {
                title: action.sheetName || "Dane",
              },
            },
          ],
        },
      });

      const spreadsheetId = spreadsheet.data.spreadsheetId!;
      const sheetName = action.sheetName || "Dane";

      const headers = action.headers?.length
        ? action.headers
        : ["Data", "Kategoria", "Opis", "Kwota", "Uwagi"];

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [headers, ...(action.rows || [])],
        },
      });

      const text = `Gotowe ✅ Utworzyłem arkusz Google: "${action.title}". Link: ${spreadsheet.data.spreadsheetUrl}`;

      await saveAssistantMessage(text, userEmail);

      return Response.json({ text });
    }

    // ================= GOOGLE CALENDAR =================

    const calendarIntent = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
Dzisiaj jest ${new Date().toISOString()}.
Strefa czasowa: Europe/Warsaw.

Sprawdź, czy użytkownik chce dodać wydarzenie do kalendarza.

Wiadomość:
"${lastMessage}"

Zwróć WYŁĄCZNIE JSON:
{
  "calendar": true,
  "title": "...",
  "start": "...",
  "end": "...",
  "description": "..."
}

albo:

{
  "calendar": false
}
      `,
    });

    let calendarData: any = { calendar: false };

    try {
      calendarData = JSON.parse(calendarIntent.output_text);
    } catch {
      calendarData = { calendar: false };
    }

    if (calendarData.calendar === true) {
      const calendar = google.calendar({
        version: "v3",
        auth: oauth2Client,
      });

      await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: calendarData.title,
          description: calendarData.description,
          start: {
            dateTime: calendarData.start,
            timeZone: "Europe/Warsaw",
          },
          end: {
            dateTime: calendarData.end,
            timeZone: "Europe/Warsaw",
          },
        },
      });

      const text = `Gotowe ✅ Dodałem wydarzenie do Twojego kalendarza: "${calendarData.title}"`;

      await saveAssistantMessage(text, userEmail);

      return Response.json({ text });
    }

    // ================= NORMALNY CHAT + INTERNET + MEMORY =================

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      tools: [{ type: "web_search" }],
      input: [
        {
          role: "system",
          content: memoryContext,
        },
        ...messages.map((msg: any) => ({
          role: msg.role,
          content: msg.text,
        })),
      ],
    });

    const assistantText = response.output_text;

    await saveAssistantMessage(assistantText, userEmail);

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