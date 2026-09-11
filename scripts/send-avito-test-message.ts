import { AvitoApiClient, AvitoApiError } from "../src/integrations/avito/avito-api-client.ts";

const clientId = process.env.AVITO_CLIENT_ID?.trim();
const clientSecret = process.env.AVITO_CLIENT_SECRET?.trim();
const chatId = process.env.AVITO_TEST_CHAT_ID?.trim();
const text = process.env.AVITO_TEST_MESSAGE?.trim();
const confirmed = process.env.AVITO_TEST_SEND_CONFIRM === "YES";

if (!clientId || !clientSecret || !chatId || !text || !confirmed) {
  console.error("AVITO_SEND=BLOCKED reason=EXPLICIT_TEST_CONFIGURATION_REQUIRED");
  process.exitCode = 1;
} else {
  try {
    const messageId = await new AvitoApiClient({ clientId, clientSecret })
      .sendTextMessage(chatId, text);
    console.log(`AVITO_SEND=PASS message_id_present=${Boolean(messageId)}`);
  } catch (error) {
    const code = error instanceof AvitoApiError ? error.code : "UNEXPECTED_ERROR";
    console.error(`AVITO_SEND=FAIL code=${code}`);
    process.exitCode = 1;
  }
}

