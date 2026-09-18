import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { TestChatLabClient } from "./test-chat-lab-client";

export const metadata: Metadata = {
  title: "Test Chat Lab · AI-продавец",
  description: "Изолированное многоходовое тестирование conversation pipeline",
};

export const dynamic = "force-dynamic";

export default function TestChatLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <TestChatLabClient />;
}
