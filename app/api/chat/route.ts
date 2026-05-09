import OpenAI from "openai";
import { google } from "googleapis";
import { supabase } from "@/app/lib/supabase";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: Request) {
  const { messages, userEmail, googleAccessToken } = await request.json();

  const lastMessage = messages[messages.length - 1];

  await supabase.from("messages").insert([
    {
      role: lastMessage.role,
      text: lastMessage.text,
      user_email: userEmail,
    },
  ]);

  const calendarCheck = await client.responses.create({
    model: "gpt-4.1-mini",
    input: `
Dzisiaj jest: ${new Date().toISOString()}.
Strefa czasowa użytkownika: Europe/Warsaw.

Sprawdź, czy użytkownik chce utworzyć wydarzenie w kalendarzu Google.

Wiadomość użytkownika:
"${lastMessage.text}"

Odpowiedz TYLKO czystym JSON bez markdown:
{
  "isCalendarRequest": true/false,
  "title": "tytuł wydarzenia",
  "startDateTime": "ISO datetime",
  "endDateTime": "ISO datetime",
  "description": "opis"
}

Jeśli brakuje godziny lub daty, ustaw isCalendarRequest na false.
    `,
  });

  let calendarData: any = null;

  try {
    calendarData = JSON.parse(calendarCheck.output_text);
  } catch {
    calendarData = { isCalendarRequest: false };
  }

  if (calendarData.isCalendarRequest) {
    if (!googleAccessToken) {
      const assistantText =
        "Musisz zalogować się ponownie przez Google i zaakceptować dostęp do kalendarza.";

      await supabase.from("messages").insert([
        {
          role: "assistant",
          text: assistantText,
          user_email: userEmail,
        },
      ]);

      return Response.json({ text: assistantText });
    }

    const oauth2Client = new google.auth.OAuth2();

    oauth2Client.setCredentials({
      access_token: googleAccessToken,
    });

    const calendar = google.calendar({
      version: "v3",
      auth: oauth2Client,
    });

    const event = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: calendarData.title,
        description: calendarData.description,
        start: {
          dateTime: calendarData.startDateTime,
          timeZone: "Europe/Warsaw",
        },
        end: {
          dateTime: calendarData.endDateTime,
          timeZone: "Europe/Warsaw",
        },
      },
    });

    const assistantText = `Gotowe — dodałem wydarzenie do Twojego kalendarza: ${calendarData.title}.`;

    await supabase.from("messages").insert([
      {
        role: "assistant",
        text: assistantText,
        user_email: userEmail,
      },
    ]);

    return Response.json({
      text: assistantText,
      eventLink: event.data.htmlLink,
    });
  }

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    tools: [{ type: "web_search" }],
    input: messages.map((message: any) => ({
      role: message.role,
      content: message.text,
    })),
  });

  const assistantText = response.output_text;

  await supabase.from("messages").insert([
    {
      role: "assistant",
      text: assistantText,
      user_email: userEmail,
    },
  ]);

  return Response.json({
    text: assistantText,
  });
}