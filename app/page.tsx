"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import Linkify from "react-linkify";

type Message = {
  role: string;
  text: string;
};

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    checkUser();

    const loadMessages = async () => {
      const { data } = await supabase
        .from("messages")
        .select("*")
        .order("created_at", { ascending: true });

      if (data) {
        setMessages(data);
      }
    };

    loadMessages();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function checkUser() {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user?.email) {
      setUserEmail(session.user.email);
    }
  }

  async function loginWithGoogle() {
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        scopes:
          "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/gmail.readonly",
        redirectTo: window.location.origin,
      },
    });
  }

  async function logout() {
    await supabase.auth.signOut();
    location.reload();
  }

  async function sendMessage() {
    if (!input.trim()) return;

    const userMessage = {
      role: "user",
      text: input,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    await supabase.from("messages").insert(userMessage);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({
          message: input,
          email: userEmail,
        }),
      });

      const data = await res.json();

      const assistantMessage = {
        role: "assistant",
        text: data.reply,
      };

      setMessages((prev) => [...prev, assistantMessage]);

      await supabase.from("messages").insert(assistantMessage);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Wystąpił błąd podczas pobierania odpowiedzi.",
        },
      ]);
    }

    setLoading(false);
  }

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="w-full max-w-4xl rounded-2xl bg-zinc-900 p-6 shadow-2xl border border-zinc-800">
        <p className="text-blue-400 mb-2">Asystent Michała v2</p>

        <h1 className="text-5xl font-bold mb-6">
          Twój prywatny asystent AI
        </h1>

        {userEmail && (
          <p className="text-green-400 mb-4">
            Zalogowano jako: {userEmail}
          </p>
        )}

        <div className="h-[500px] overflow-y-auto rounded-xl bg-black p-4 border border-zinc-800 space-y-4">
          {messages.map((msg, index) => (
            <div
              key={index}
              className={`max-w-[85%] rounded-2xl px-5 py-4 text-lg whitespace-pre-wrap break-words ${
                msg.role === "user"
                  ? "ml-auto bg-blue-600"
                  : "bg-zinc-800"
              }`}
            >
              <Linkify
                componentDecorator={(href, text, key) => (
                  <a
                    href={href}
                    key={key}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 underline break-all"
                  >
                    {text}
                  </a>
                )}
              >
                {msg.text}
              </Linkify>
            </div>
          ))}

          {loading && (
            <div className="bg-zinc-800 rounded-2xl px-5 py-4 w-fit">
              Asystent pisze...
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <div className="mt-5 space-y-3">
          {!userEmail ? (
            <button
              onClick={loginWithGoogle}
              className="w-full rounded-xl bg-white text-black py-4 text-lg font-semibold hover:bg-zinc-200 transition"
            >
              Zaloguj przez Google
            </button>
          ) : (
            <button
              onClick={logout}
              className="w-full rounded-xl bg-red-500 py-4 text-lg font-semibold hover:bg-red-600 transition"
            >
              Wyloguj
            </button>
          )}

          <div className="flex gap-3">
            <input
              className="flex-1 rounded-xl bg-zinc-800 border border-zinc-700 px-4 py-4 outline-none text-lg"
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
              className="rounded-xl bg-blue-600 px-8 py-4 text-lg font-semibold hover:bg-blue-700 transition disabled:opacity-50"
            >
              Wyślij
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}