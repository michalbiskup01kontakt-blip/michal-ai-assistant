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

export async function POST(req: Request) {
  try {
    const { messages, userEmail, googleAccessToken } = await req.json();
    const lastMessage = messages[messages.length - 1]?.text || "";

    await supabase.from("messages").insert({
      role: "user",
      text: lastMessage,
      user_email: userEmail,
    });

    const intentResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
Dzisiaj jest ${new Date().toISOString()}.
Strefa czasowa: Europe/Warsaw.

Rozpoznaj intencję użytkownika.

WAŻNE:
- Jeśli użytkownik pyta o dane z istniejącego arkusza, np. "ile wydałem", "pokaż dane", "sprawdź arkusz", "przeanalizuj arkusz" → action = "read_sheet".
- Jeśli użytkownik chce STWORZYĆ NOWY arkusz, np. "stwórz arkusz", "utwórz tabelę", "załóż arkusz" → action = "create_sheet".
- Jeśli użytkownik chce dodać wydarzenie do kalendarza → action = "calendar".
- Jeśli zwykła rozmowa → action = "none".

Wiadomość użytkownika:
"${lastMessage}"

Zwróć WYŁĄCZNIE JSON.

Dla odczytu arkusza:
{
  "action": "read_sheet",
  "sheetName": "nazwa arkusza",
  "question": "pytanie użytkownika"
}

Dla tworzenia arkusza:
{
  "action": "create_sheet",
  "title": "nazwa arkusza",
  "sheetName": "Dane",
  "headers": ["Data", "Kategoria", "Opis", "Kwota", "Uwagi"],
  "rows": []
}

Dla kalendarza:
{
  "action": "calendar",
  "title": "tytuł wydarzenia",
  "start": "ISO datetime",
  "end": "ISO datetime",
  "description": "opis"
}

Dla zwykłej rozmowy:
{
  "action": "none"
}
      `,
    });

    let action: any = { action: "none" };

    try {
      action = JSON.parse(intentResponse.output_text);
    } catch {
      action = { action: "none" };
    }

    if (
      ["calendar", "create_sheet", "read_sheet"].includes(action.action) &&
      !googleAccessToken
    ) {
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

    if (action.action === "calendar") {
      const calendar = google.calendar({
        version: "v3",
        auth: oauth2Client,
      });

      await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: action.title,
          description: action.description,
          start: {
            dateTime: action.start,
            timeZone: "Europe/Warsaw",
          },
          end: {
            dateTime: action.end,
            timeZone: "Europe/Warsaw",
          },
        },
      });

      const text = `Gotowe ✅ Dodałem wydarzenie do Twojego kalendarza: "${action.title}"`;

      await supabase.from("messages").insert({
        role: "assistant",
        text,
        user_email: userEmail,
      });

      return Response.json({ text });
    }

    if (action.action === "create_sheet") {
      const sheets = google.sheets({
        version: "v4",
        auth: oauth2Client,
      });

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

    if (action.action === "read_sheet") {
      const drive = google.drive({
        version: "v3",
        auth: oauth2Client,
      });

      const sheets = google.sheets({
        version: "v4",
        auth: oauth2Client,
      });

      const sheetNameToFind = action.sheetName || "";

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
        spreadsheetInfo.data.sheets?.[0]?.properties?.title || "Arkusz1";

      const sheetData = await sheets.spreadsheets.values.get({
        spreadsheetId: foundFile.id,
        range: `${firstSheetName}!A1:Z1000`,
      });

      const values = sheetData.data.values || [];

      const analysis = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Użytkownik pyta o dane z istniejącego arkusza Google.

Nazwa znalezionego arkusza:
${foundFile.name}

Pytanie użytkownika:
${action.question || lastMessage}

Dane z arkusza:
${JSON.stringify(values)}

Odpowiedz po polsku. Jeśli dane są puste albo brakuje informacji, powiedz to jasno.
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