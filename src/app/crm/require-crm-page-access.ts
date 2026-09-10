import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { checkCrmAccess } from "@/application/crm/crm-access";

export async function requireCrmPageAccess(): Promise<void> {
  const requestHeaders = await headers();
  if (checkCrmAccess(requestHeaders.get("authorization")) !== "AUTHORIZED") {
    notFound();
  }
}

