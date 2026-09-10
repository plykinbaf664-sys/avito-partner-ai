import { checkCrmAccess, crmAccessResponse } from "@/application/crm/crm-access";
import { createCrmCsv } from "@/application/crm/csv-export";
import { withCrmService } from "@/application/crm/crm-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const denial = crmAccessResponse(
    checkCrmAccess(request.headers.get("authorization")),
  );
  if (denial) return denial;

  try {
    const records = await withCrmService((service) => service.exportLeads());
    return new Response(createCrmCsv(records), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="partner-leads.csv"',
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "CRM temporarily unavailable" }, { status: 503 });
  }
}

