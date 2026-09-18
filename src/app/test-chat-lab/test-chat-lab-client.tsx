"use client";

import { useMemo, useState } from "react";
import {
  testChatLabScenarios,
  type TestChatLabAction,
  type TestChatLabActionResult,
  type TestChatLabSnapshot,
} from "@/application/test-chat-lab/test-chat-lab-contract";

function freshSession(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `lab-${Date.now()}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function actorLabel(actor: string): string {
  return actor === "USER" ? "Клиент" : actor === "MANAGER" ? "Дмитрий" : "AI";
}

export function TestChatLabClient() {
  const [sessionId, setSessionId] = useState(freshSession);
  const [virtualNow, setVirtualNow] = useState(nowIso);
  const [clientText, setClientText] = useState("");
  const [managerText, setManagerText] = useState("");
  const [state, setState] = useState<TestChatLabSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const history = useMemo(() => state?.messages ?? [], [state]);

  async function run(action: Omit<TestChatLabAction, "sessionId" | "virtualNow"> & { virtualNow?: string }) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/test-chat-lab", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...action, sessionId, virtualNow: action.virtualNow ?? virtualNow }),
      });
      const body = await response.json() as { ok: boolean; result?: TestChatLabActionResult; error?: string };
      if (!response.ok || !body.ok || !body.result) throw new Error(body.error ?? "LAB_FAILED");
      setState(body.result.snapshot);
      setVirtualNow(body.result.snapshot.virtualNow);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "LAB_FAILED");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setSessionId(freshSession());
    setVirtualNow(nowIso());
    setState(null);
    setError(null);
  }

  function plusTwoHours() {
    const next = new Date(new Date(virtualNow).getTime() + 2 * 60 * 60 * 1_000).toISOString();
    void run({ action: "advance_time", virtualNow: next });
  }

  return (
    <main className="min-h-screen bg-slate-950 p-5 text-slate-100">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold">Test Chat Lab</h1>
            <p className="mt-1 text-sm text-slate-400">Тот же conversation pipeline, отдельная SQLite и fake Avito/Telegram adapters.</p>
          </div>
          <button onClick={reset} className="rounded-lg bg-blue-600 px-4 py-2 text-sm hover:bg-blue-500">Новый тестовый диалог</button>
        </header>

        <section className="grid gap-3 rounded-xl border border-slate-800 bg-slate-900/50 p-4 md:grid-cols-3">
          <div><div className="text-xs text-slate-500">Session</div><div className="break-all text-sm">{sessionId}</div></div>
          <label className="text-sm">Виртуальное время<input type="datetime-local" value={virtualNow.slice(0, 16)} onChange={(event) => setVirtualNow(new Date(event.target.value).toISOString())} className="mt-1 block w-full rounded border border-slate-700 bg-slate-950 px-2 py-1" /></label>
          <button disabled={busy} onClick={plusTwoHours} className="self-end rounded-lg border border-amber-500/60 px-3 py-2 text-sm text-amber-200 hover:bg-amber-950/40">Симулировать +2 часа</button>
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <form onSubmit={(event) => { event.preventDefault(); if (clientText.trim()) { void run({ action: "client_message", text: clientText }); setClientText(""); } }} className="space-y-2 rounded-xl border border-slate-800 p-4">
            <h2 className="font-medium">Сообщение клиента</h2>
            <textarea value={clientText} onChange={(event) => setClientText(event.target.value)} rows={3} className="w-full rounded border border-slate-700 bg-slate-950 p-2" placeholder="Например: Москва, есть 300 тысяч..." />
            <button disabled={busy || !clientText.trim()} className="rounded bg-emerald-700 px-3 py-2 text-sm disabled:opacity-50">Обработать сообщение клиента</button>
          </form>
          <form onSubmit={(event) => { event.preventDefault(); if (managerText.trim()) { void run({ action: "manager_message", text: managerText }); setManagerText(""); } }} className="space-y-2 rounded-xl border border-slate-800 p-4">
            <h2 className="font-medium">Сообщение Дмитрия</h2>
            <textarea value={managerText} onChange={(event) => setManagerText(event.target.value)} rows={3} className="w-full rounded border border-slate-700 bg-slate-950 p-2" placeholder="Например: Оставьте номер, я вам позвоню." />
            <button disabled={busy || !managerText.trim()} className="rounded bg-violet-700 px-3 py-2 text-sm disabled:opacity-50">Сохранить сообщение Дмитрия</button>
          </form>
        </section>

        <section className="rounded-xl border border-slate-800 p-4">
          <h2 className="mb-3 font-medium">Сохранённые regression-сценарии</h2>
          <div className="flex flex-wrap gap-2">{testChatLabScenarios.map((scenario) => <button key={scenario.id} disabled={busy} onClick={() => void run({ action: "run_scenario", scenarioId: scenario.id })} className="rounded border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50">{scenario.title}</button>)}</div>
        </section>

        {error ? <div className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-200">Ошибка: {error}</div> : null}

        <section className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-xl border border-slate-800 p-4">
            <h2 className="mb-3 font-medium">История</h2>
            <div className="space-y-2">{history.length === 0 ? <p className="text-sm text-slate-500">Сообщений пока нет.</p> : history.map((message) => <div key={message.id} className="rounded-lg bg-slate-900 p-3"><div className="flex justify-between text-xs text-slate-400"><span>{actorLabel(message.actor)}</span><span>{new Date(message.createdAt).toLocaleString("ru-RU")}</span></div><div className="mt-1 whitespace-pre-wrap text-sm">{message.content}</div></div>)}</div>
          </div>
          <div className="space-y-4 rounded-xl border border-slate-800 p-4">
            <h2 className="font-medium">Текущее состояние</h2>
            <div className="grid grid-cols-2 gap-2 text-sm"><div>Квалификация: <b>{state?.qualification.status ?? "—"}</b></div><div>Телефон: <b>{state?.phone ?? "—"}</b></div><div>Следующий шаг: <b>{state?.currentNextStep ?? "—"}</b></div><div>Ответ AI: <b>{state?.replyAction ?? "NO_REPLY"}</b></div><div>Handoff: <b>{state?.handoff.decision ?? "NONE"}</b></div><div>Telegram: <b>{state?.handoff.notificationStatus ?? "—"}</b></div><div>Follow-up: <b>{state?.followUp.followUpCount ?? 0}</b></div><div>Due: <b>{state?.followUp.eligibleAt ?? "—"}</b></div></div>
            <details><summary className="cursor-pointer text-sm text-slate-300">Structured lead state</summary><pre className="mt-2 max-h-96 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-300">{JSON.stringify(state?.lead ?? null, null, 2)}</pre></details>
            <details><summary className="cursor-pointer text-sm text-slate-300">Qualification / follow-up state</summary><pre className="mt-2 max-h-72 overflow-auto rounded bg-slate-950 p-2 text-xs text-slate-300">{JSON.stringify({ qualification: state?.qualification, followUp: state?.followUp, lastProcessing: state?.lastProcessing }, null, 2)}</pre></details>
          </div>
        </section>
      </div>
    </main>
  );
}
