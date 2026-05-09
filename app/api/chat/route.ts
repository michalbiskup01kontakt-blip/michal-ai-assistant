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

    const actionCheck = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
Dzisiaj jest ${new Date().toISOString()}.
Strefa czasowa: Europe/Warsaw.

Rozpoznaj intencję użytkownika.

Wiadomość:
"${lastMessage}"

Zwróć WYŁĄCZNIE JSON:

Dla kalendarza:
{
  "action": "calendar",
  "title": "...",
  "start": "...",
  "end": "...",
  "description": "..."
}

Dla arkusza Google:
{
  "action": "sheets",
  "title": "nazwa arkusza",
  "sheetName": "Dane",
  "headers": ["Data", "Kategoria", "Opis", "Kwota", "Uwagi"],
  "rows": []
}

Jeśli to zwykła rozmowa:
{
  "action": "none"
}
      `,
    });

    let action: any = { action: "none" };

    try {
      action = JSON.parse(actionCheck.output_text);
    } catch {
      action = { action: "none" };
    }

    if ((action.action === "calendar" || action.action === "sheets") && !googleAccessToken) {
      const text = "Brak dostępu do Google. Wyloguj się i zaloguj ponownie przez Google.";
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

      const text = `Gotowe ✅ Dodałem wydarzenie do kalendarza: "${action.title}"`;

      await supabase.from("messages").insert({
        role: "assistant",
        text,
        user_email: userEmail,
      });

      return Response.json({ text });
    }

    if (action.action === "sheets") {
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