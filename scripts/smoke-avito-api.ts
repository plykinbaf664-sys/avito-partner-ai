import {
  AvitoApiClient,
  AvitoApiError,
} from "../src/integrations/avito/avito-api-client.ts";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "chat-id": { type: "string" } } });
const testChatId = values["chat-id"]?.trim() || process.env.AVITO_TEST_CHAT_ID?.trim();

const clientId = process.env.AVITO_CLIENT_ID?.trim();
const clientSecret = process.env.AVITO_CLIENT_SECRET?.trim();

if (!clientId || !clientSecret) {
  console.error("AVITO_ENV=FAIL reason=MISSING_CREDENTIALS");
  process.exitCode = 1;
} else {
  const client = new AvitoApiClient({ clientId, clientSecret });
  try {
    const token = await client.requestAccessToken();
    console.log(
      `AVITO_AUTH=PASS http=200 type=${token.tokenType} expires_in=${token.expiresIn}`,
    );
    const account = await client.getOwnAccount(token.accessToken);
    console.log(
      `AVITO_API=PASS http=200 schema=account fields=${account.knownFields.join(",")}`,
    );
    const chats = await client.listChats({ limit: 5 });
    const authenticatedAccount = await client.getAuthenticatedAccount();
    console.log(`AVITO_ACCOUNT=PASS account_id=${authenticatedAccount.id}`);
    console.log(`AVITO_MESSENGER=PASS http=200 chats_checked=${chats.length}`);
    const chatIds = [...new Set([...chats.map((chat) => chat.id), ...(testChatId ? [testChatId] : [])])];
    if (chatIds.length === 0) {
      throw new AvitoApiError("AVITO_MESSAGES_NO_CHAT_TO_VERIFY", null, false);
    }
    for (const chatId of chatIds) {
      const messages = await client.listMessages(chatId, { limit: 1 });
      console.log(
        `AVITO_MESSAGES=PASS http=200 messages_checked=${messages.length} test_chat=${chatId === testChatId}`,
      );
    }
  } catch (error) {
    if (error instanceof AvitoApiError) {
      console.error(
        `AVITO_SMOKE=FAIL code=${error.code} http=${error.status ?? "none"} retryable=${error.retryable}`,
      );
    } else {
      console.error("AVITO_SMOKE=FAIL code=UNEXPECTED_ERROR");
    }
    process.exitCode = 1;
  }
}
