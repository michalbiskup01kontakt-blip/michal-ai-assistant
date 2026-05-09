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

function extractSheetName(message: string) {
  const text = message.toLowerCase();

  if (text.includes("wydatki maj 2026")) return "Wydatki maj 2026";
  if (text.includes("wydatki")) return "wydatki";

  const match = message.match(/arkusz(?:u)?\s+([a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ0-9\s]+)/i);

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

      await supabase.from("messages").insert({
        role: "assistant",
        text,
        user_email: userEmail,
      });

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

    const shouldReadSheet = detectSheetRead(lastMessage);
    const shouldCreateSheet = detectSheetCreate(lastMessage);

    if (shouldReadSheet) {
      const sheetNameToFind = extractSheetName(lastMessage);

      const files = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.spreadsheet' and name contains '${sheetNameToFind.replace(
          /'/g,
          "\\'"
        )}'`,
        fields: "files(id, name)",
        pageSize: 10,
      });

      const foundFile = files.data.files?.[0];

      if (!foundFile?.id) {
        const text = `Nie znalazłem arkusza o nazwie zawierającej: "${sheetNameToFind}".`;

        await supabase.from("messages").insert({
          role: "assistant",
          text,
          user_email: userEmail,
        });

        return Response.json({ text });
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
Jesteś asystentem analizującym dane z Google Sheets.

Użytkownik pyta:
${lastMessage}

Znaleziony arkusz:
${foundFile.name}

Dane z arkusza:
${JSON.stringify(values)}

Odpowiedz po polsku.

Jeżeli arkusz jest pusty lub nie ma danych o paliwie, powiedz jasno:
"Ten arkusz jest pusty albo nie ma w nim danych o paliwie, więc nie mogę tego policzyć."

Nie podawaj instrukcji jak używać SUMIF. Sam przeanalizuj dane.
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

    if (shouldCreateSheet) {
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

      await supabase.from("messages").insert({
        role: "assistant",
        text,
        user_email: userEmail,
      });

      return Response.json({ text });
    }

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

      await supabase.from("messages").insert({
        role: "assistant",
        text,
        user_email: userEmail,
      });

      return Response.json({ text });
    }

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