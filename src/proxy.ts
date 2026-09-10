import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { checkCrmAccess, crmAccessResponse } from "@/application/crm/crm-access";

export function proxy(request: NextRequest): Response {
  const denial = crmAccessResponse(
    checkCrmAccess(request.headers.get("authorization")),
  );
  return denial ?? NextResponse.next();
}

export const config = {
  matcher: ["/crm/:path*", "/api/crm/:path*"],
};

