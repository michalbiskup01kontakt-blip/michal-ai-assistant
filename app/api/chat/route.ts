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
    const body = await req.json();

    const { messages, userEmail, googleAccessToken } = body;

    const lastMessage = messages[messages.length - 1]?.text || "";

    // zapis wiadomości użytkownika
    await supabase.from("messages").insert({
      role: "user",
      text: lastMessage,
      user_email: userEmail,
    });

    // sprawdzenie czy użytkownik chce utworzyć wydarzenie
    const calendarIntent = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: `
Dzisiaj jest ${new Date().toISOString()}.

Przeanalizuj wiadomość użytkownika i sprawdź,
czy chce utworzyć wydarzenie w kalendarzu.

Wiadomość:
"${lastMessage}"

Jeśli TAK:
zwróć WYŁĄCZNIE JSON:

{
  "calendar": true,
  "title": "...",
  "start": "...",
  "end": "...",
  "description": "..."
}

Daty zwracaj w formacie ISO.

Jeśli NIE:
{
  "calendar": false
}
      `,
    });

    let parsed: any = {};

    try {
      parsed = JSON.parse(calendarIntent.output_text);
    } catch {
      parsed = { calendar: false };
    }

    // tworzenie wydarzenia
    if (parsed.calendar === true) {
      if (!googleAccessToken) {
        return Response.json({
          text: "Brak dostępu do Google Calendar. Zaloguj się ponownie.",
        });
      }

      const oauth2Client = new google.auth.OAuth2();

      oauth2Client.setCredentials({
        access_token: googleAccessToken,
      });

      const calendar = google.calendar({
        version: "v3",
        auth: oauth2Client,
      });

      const createdEvent = await calendar.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: parsed.title,
          description: parsed.description,
          start: {
            dateTime: parsed.start,
            timeZone: "Europe/Warsaw",
          },
          end: {
            dateTime: parsed.end,
            timeZone: "Europe/Warsaw",
          },
        },
      });

      const assistantResponse = `Gotowe ✅ Dodałem wydarzenie do Twojego kalendarza: "${parsed.title}"`;

      await supabase.from("messages").insert({
        role: "assistant",
        text: assistantResponse,
        user_email: userEmail,
      });

      return Response.json({
        text: assistantResponse,
        eventLink: createdEvent.data.htmlLink,
      });
    }

    // normalna odpowiedź AI
    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      tools: [{ type: "web_search" }],
      input: messages.map((msg: any) => ({
        role: msg.role,
        content: msg.text,
      })),
    });

    const assistantText = response.output_text;

    // zapis odpowiedzi AI
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