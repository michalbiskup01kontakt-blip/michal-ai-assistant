"use client";

import { useState } from "react";
import { supabase } from "./lib/supabase";

type Message = {
  role: "user" | "assistant";
  text: string;
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      text: "Cześć Michał. Jestem Twoim prywatnym asystentem AI. W czym mogę pomóc?",
    },
  ]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function loginWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: "https://michal-ai-assistant.vercel.app",
      },
    });
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMessage: Message = {
      role: "user",
      text: input,
    };

    const newMessages = [...messages, userMessage];

    setMessages(newMessages);
    setInput("");
    setLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: newMessages,
        }),
      });

      const data = await response.json();

      const assistantMessage: Message = {
        role: "assistant",
        text: data.text || "Nie udało mi się wygenerować odpowiedzi.",
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Wystąpił błąd połączenia z AI.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-white flex items-center justify-center p-6">
      <div className="w-full max-w-3xl rounded-2xl bg-zinc-900 border border-zinc-800 p-6 shadow-xl">
        <p className="text-sm text-blue-400 mb-2">
          Asystent Michała v1
        </p>

        <h1 className="text-3xl font-bold mb-4">
          Twój prywatny asystent AI
        </h1>

        <div className="h-96 overflow-y-auto rounded-xl bg-zinc-950 border border-zinc-800 p-4 mb-4 space-y-3">
          {messages.map((message, index) => (
            <div
              key={index}
              className={`rounded-xl p-3 max-w-[80%] ${
                message.role === "user"
                  ? "bg-blue-600 ml-auto"
                  : "bg-zinc-800 mr-auto"
              }`}
            >
              {message.text}
            </div>
          ))}

          {loading && (
            <div className="rounded-xl p-3 max-w-[80%] bg-zinc-800 mr-auto">
              Piszę odpowiedź...
            </div>
          )}
        </div>

        <div className="space-y-3">
          <button
            onClick={loginWithGoogle}
            className="w-full rounded-lg bg-white text-black py-3 font-medium"
          >
            Zaloguj przez Google
          </button>

          <div className="flex gap-3">
            <input
              className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-3 outline-none"
              placeholder="Np. zaplanuj mi dzień..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendMessage();
              }}
            />

            <button
              onClick={sendMessage}
              disabled={loading}
              className="rounded-lg bg-blue-500 px-5 py-3 font-medium disabled:opacity-50"
            >
              Wyślij
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}