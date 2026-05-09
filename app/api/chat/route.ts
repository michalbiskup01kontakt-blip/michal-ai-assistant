import OpenAI from "openai";
import { supabase } from "@/app/lib/supabase";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(request: Request) {
  const { messages, userEmail } = await request.json();

  const lastMessage = messages[messages.length - 1];

  await supabase.from("messages").insert([
    {
      role: lastMessage.role,
      text: lastMessage.text,
      user_email: userEmail,
    },
  ]);

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