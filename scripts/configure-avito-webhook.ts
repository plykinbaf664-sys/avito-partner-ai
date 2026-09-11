import { AvitoApiClient, AvitoApiError } from "../src/integrations/avito/avito-api-client.ts";

const clientId = process.env.AVITO_CLIENT_ID?.trim();
const clientSecret = process.env.AVITO_CLIENT_SECRET?.trim();
const webhookUrl = process.env.AVITO_WEBHOOK_URL?.trim();

if (!clientId || !clientSecret || !webhookUrl) {
  console.error("AVITO_WEBHOOK=FAIL reason=MISSING_CONFIGURATION");
  process.exitCode = 1;
} else {
  try {
    await new AvitoApiClient({ clientId, clientSecret }).subscribeWebhook(webhookUrl);
    console.log("AVITO_WEBHOOK=PASS configured=true");
  } catch (error) {
    const code = error instanceof AvitoApiError ? error.code : "UNEXPECTED_ERROR";
    console.error(`AVITO_WEBHOOK=FAIL code=${code}`);
    process.exitCode = 1;
  }
}

