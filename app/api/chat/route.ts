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

function cleanBase64Url(data?: string | null) {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

async function saveAssistantMessage(text: string, userEmail: string | null) {
  await supabase.from("messages").insert({
    role: "assistant",
    text,
    user_email: userEmail,
  });
}

function detectMemorySave(message: string) {
  const text = normalize(message);
  return (
    text.includes("zapamiętaj") ||
    text.includes("pamietaj") ||
    text.includes("zapamiętasz") ||
    text.includes("następnym razem")
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

function detectGmailSearch(message: string) {
  const text = normalize(message);
  return (
    text.includes("gmail") ||
    text.includes("mail") ||
    text.includes("maile") ||
    text.includes("maila") ||
    text.includes("poczta") ||
    text.includes("wiadomość") ||
    text.includes("wiadomości") ||
    text.includes("faktura") ||
    text.includes("faktury")
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
    text.includes("personel") ||
    text.includes("excel");

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
    text.includes("przeanalizuj") ||
    text.includes("dane");

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

      return Response.json({ text: assistantText });
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

    const gmail = google.gmail({
      version: "v1",
      auth: oauth2Client,
    });

    // ================= GMAIL — WYSZUKIWANIE I ANALIZA MAILI =================

    if (detectGmailSearch(lastMessage) && !detectSheetQuestion(lastMessage)) {
      const gmailIntent = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Użytkownik chce znaleźć albo przeanalizować maile Gmail.

Wiadomość:
"${lastMessage}"

Zamień to na zapytanie Gmail search query.

Zwróć WYŁĄCZNIE JSON:
{
  "query": "zapytanie Gmail",
  "question": "pełne pytanie użytkownika"
}

Przykłady:
- "pokaż ostatnie maile" -> "newer_than:14d"
- "znajdź faktury z maja" -> "faktura OR invoice after:2026/05/01 before:2026/06/01"
- "czy Adam pisał o spotkaniu" -> "Adam spotkanie"
- "pokaż maile od Google" -> "from:google"
        `,
      });

      let gmailParsed: any = {
        query: "newer_than:14d",
        question: lastMessage,
      };

      try {
        gmailParsed = JSON.parse(gmailIntent.output_text);
      } catch {
        gmailParsed = {
          query: "newer_than:14d",
          question: lastMessage,
        };
      }

      const list = await gmail.users.messages.list({
        userId: "me",
        q: gmailParsed.query || "newer_than:14d",
        maxResults: 10,
      });

      const ids = list.data.messages || [];

      if (!ids.length) {
        const text = `Nie znalazłem maili pasujących do zapytania: "${gmailParsed.query}".`;

        await saveAssistantMessage(text, userEmail);

        return Response.json({ text });
      }

      const emails: any[] = [];

      for (const item of ids) {
        if (!item.id) continue;

        const msg = await gmail.users.messages.get({
          userId: "me",
          id: item.id,
          format: "full",
        });

        const headers = msg.data.payload?.headers || [];

        const subject =
          headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
        const from =
          headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
        const date =
          headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

        let body = "";

        if (msg.data.payload?.body?.data) {
          body = cleanBase64Url(msg.data.payload.body.data);
        } else if (msg.data.payload?.parts?.length) {
          const plainPart =
            msg.data.payload.parts.find((p) => p.mimeType === "text/plain") ||
            msg.data.payload.parts.find((p) => p.mimeType === "text/html");

          body = cleanBase64Url(plainPart?.body?.data);
        }

        emails.push({
          subject,
          from,
          date,
          snippet: msg.data.snippet,
          body: body.slice(0, 2500),
        });
      }

      const analysis = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Jesteś prywatnym asystentem analizującym Gmail użytkownika.

${memoryContext}

Pytanie użytkownika:
${gmailParsed.question || lastMessage}

Zapytanie Gmail:
${gmailParsed.query}

Znalezione maile:
${JSON.stringify(emails)}

Zasady:
- Odpowiedz po polsku.
- Nie mów, że nie masz dostępu do Gmaila, bo dane maili masz powyżej.
- Jeśli użytkownik pyta o faktury, wypisz znalezione faktury i nadawców.
- Jeśli użytkownik pyta o ważne maile, wybierz najważniejsze.
- Jeśli pytanie dotyczy konkretnej osoby/tematu, znajdź pasujące maile.
- Jeśli nie ma jednoznacznej informacji, napisz to jasno.
        `,
      });

      const text = analysis.output_text;

      await saveAssistantMessage(text, userEmail);

      return Response.json({ text });
    }

    // ================= GOOGLE SHEETS — INTELIGENTNE WYSZUKIWANIE DANYCH =================

    if (detectSheetQuestion(lastMessage)) {
      const sheetIntent = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Użytkownik pyta o dane z arkusza Google.

Wiadomość:
"${lastMessage}"

Wyciągnij:
1. nazwę arkusza,
2. pytanie,
3. szukaną osobę/temat, jeśli występuje,
4. typ operacji.

Zwróć WYŁĄCZNIE JSON:
{
  "sheetName": "nazwa arkusza",
  "question": "pełne pytanie użytkownika",
  "searchTerm": "osoba, temat albo kategoria",
  "operation": "find | sum | list | analyze"
}

Jeśli nazwa arkusza nie jest jasna, wpisz pusty string.
        `,
      });

      let parsedSheet: any = {
        sheetName: extractBasicSheetName(lastMessage),
        question: lastMessage,
        searchTerm: "",
        operation: "analyze",
      };

      try {
        parsedSheet = JSON.parse(sheetIntent.output_text);
      } catch {
        parsedSheet = {
          sheetName: extractBasicSheetName(lastMessage),
          question: lastMessage,
          searchTerm: "",
          operation: "analyze",
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
          range: `${tabName}!A1:Z2000`,
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

Szukana fraza:
${parsedSheet.searchTerm || ""}

Typ operacji:
${parsedSheet.operation || "analyze"}

Dane ze wszystkich zakładek arkusza:
${JSON.stringify(allData)}

Zasady:
- Odpowiedz po polsku.
- Sam analizuj dane, nie dawaj instrukcji.
- Jeśli w pamięci jest korekta dotycząca pytanej osoby/wartości, pamięć ma pierwszeństwo.
- Jeśli pytanie dotyczy numeru telefonu, maila, osoby lub konkretnego rekordu, znajdź najlepszy pasujący wiersz.
- Jeśli pytanie dotyczy sumy, policz sumę na podstawie danych.
- Jeśli pytanie dotyczy listy, wypisz pasujące rekordy.
- Jeśli dane są puste, napisz że arkusz jest pusty.
- Jeśli nie ma pasujących danych, napisz że nie znalazłeś.
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