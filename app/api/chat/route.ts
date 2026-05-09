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

    if (!googleAccessToken) {
      return Response.json({
        text: "Zaloguj się ponownie przez Google.",
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

    // ===== SPRAWDZENIE CZY TO PYTANIE O ARKUSZ =====

    const sheetIntent = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
Sprawdź czy użytkownik pyta o dane z arkusza Google.

Wiadomość:
"${lastMessage}"

Zwróć TYLKO JSON:

{
  "isSheetQuestion": true,
  "sheetName": "nazwa arkusza",
  "question": "krótkie pytanie"
}

lub

{
  "isSheetQuestion": false
}
      `,
    });

    let parsedIntent: any = {
      isSheetQuestion: false,
    };

    try {
      parsedIntent = JSON.parse(sheetIntent.output_text);
    } catch {}

    // ===== ODCZYT ARKUSZA =====

    if (parsedIntent.isSheetQuestion) {
      const driveFiles = await drive.files.list({
        q: `
mimeType='application/vnd.google-apps.spreadsheet'
and name contains '${parsedIntent.sheetName}'
        `,
        fields: "files(id, name)",
      });

      const foundFile = driveFiles.data.files?.[0];

      if (!foundFile?.id) {
        return Response.json({
          text: `Nie znalazłem arkusza "${parsedIntent.sheetName}".`,
        });
      }

      const sheetData = await sheets.spreadsheets.values.get({
        spreadsheetId: foundFile.id,
        range: "A1:Z1000",
      });

      const values = sheetData.data.values || [];

      const analysis = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: `
Użytkownik zadał pytanie o arkusz Google.

PYTANIE:
${parsedIntent.question}

DANE Z ARKUSZA:
${JSON.stringify(values)}

Odpowiedz normalnie po polsku i przeanalizuj dane.
        `,
      });

      const assistantText = analysis.output_text;

      await supabase.from("messages").insert({
        role: "assistant",
        text: assistantText,
        user_email: userEmail,
      });

      return Response.json({
        text: assistantText,
      });
    }

    // ===== NORMALNY CHAT =====

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