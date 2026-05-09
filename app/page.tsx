"use client";

import { useEffect, useState } from "react";
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
  const [userEmail, setUserEmail] = useState<string | null>(null);

  useEffect(() => {
    async function loadUserAndMessages() {
      const { data } = await supabase.auth.getUser();

      const email = data.user?.email ?? null;

      setUserEmail(email);

      if (!email) return;

      const { data: savedMessages } = await supabase
        .from("messages")
        .select("role, text")
        .eq("user_email", email)
        .order("created_at", { ascending: true });

      if (savedMessages && savedMessages.length > 0) {
        setMessages(
          savedMessages.map((message) => ({
            role: message.role as "user" | "assistant",
            text: message.text,
          }))
        );
      }
    }

    loadUserAndMessages();
  }, []);

  async function loginWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,

        scopes: [
          "email",
          "profile",
          "openid",
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/drive",
          "https://www.googleapis.com/auth/gmail.modify",
        ].join(" "),

        queryParams: {
          access_type: "offline",
          prompt: "consent",
        },
      },
    });

    if (error) {
      alert("Błąd logowania: " + error.message);
    }
  }

  async function logout() {
    await supabase.auth.signOut();

    setUserEmail(null);

    setMessages([
      {
        role: "assistant",
        text: "Cześć Michał. Jestem Twoim prywatnym asystentem AI. W czym mogę pomóc?",
      },
    ]);
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
  userEmail,
  googleAccessToken: (await supabase.auth.getSession()).data.session?.provider_token,
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
          Asystent Michała v2
        </p>

        <h1 className="text-3xl font-bold mb-4">
          Twój prywatny asystent AI
        </h1>

        {userEmail && (
          <p className="mb-4 text-sm text-green-400">
            Zalogowano jako: {userEmail}
          </p>
        )}

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
          {!userEmail ? (
            <button
              onClick={loginWithGoogle}
              className="w-full rounded-lg bg-white text-black py-3 font-medium"
            >
              Zaloguj przez Google
            </button>
          ) : (
            <button
              onClick={logout}
              className="w-full rounded-lg bg-red-500 text-white py-3 font-medium"
            >
              Wyloguj
            </button>
          )}

          <div className="flex gap-3">
            <input
              className="flex-1 rounded-lg bg-zinc-800 border border-zinc-700 px-4 py-3 outline-none"
              placeholder="Np. zaplanuj mi dzień..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  sendMessage();
                }
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
