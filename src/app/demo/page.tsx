import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DemoClient } from "./demo-client";

export const metadata: Metadata = {
  title: "Демонстрация · Квалификация партнёров",
  description: "Локальная демонстрация анализа и квалификации партнёра",
};

export const dynamic = "force-dynamic";

export default function DemoPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <DemoClient />;
}
