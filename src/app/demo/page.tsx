import type { Metadata } from "next";

import { DemoClient } from "./demo-client";

export const metadata: Metadata = {
  title: "Демонстрация · Квалификация партнёров",
  description: "Локальная демонстрация анализа и квалификации партнёра",
};

export default function DemoPage() {
  return <DemoClient />;
}
