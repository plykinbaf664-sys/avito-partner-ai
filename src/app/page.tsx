export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center bg-zinc-50 px-6 dark:bg-zinc-950">
      <main className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white p-10 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <p className="mb-3 text-sm font-medium uppercase tracking-wider text-zinc-500">
          Local foundation
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          AI-система квалификации партнёров
        </h1>
        <p className="mt-5 leading-7 text-zinc-600 dark:text-zinc-300">
          Подготовлены доменная модель, детерминированные правила квалификации,
          SQLite/Drizzle persistence и идемпотентная обработка входящих событий.
          Реальные каналы и AI-диалог намеренно не подключены на этом этапе.
        </p>
      </main>
    </div>
  );
}
