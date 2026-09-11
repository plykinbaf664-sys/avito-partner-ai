import {
  AvitoApiClient,
  AvitoApiError,
} from "../src/integrations/avito/avito-api-client.ts";

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
    console.log(`AVITO_MESSENGER=PASS http=200 chats_checked=${chats.length}`);
    let messagesPassed = chats.length === 0;
    let lastMessageError: AvitoApiError | null = null;
    for (const chat of chats) {
      try {
        const messages = await client.listMessages(chat.id, { limit: 1 });
        console.log(
          `AVITO_MESSAGES=PASS http=200 messages_checked=${messages.length}`,
        );
        messagesPassed = true;
        break;
      } catch (error) {
        if (error instanceof AvitoApiError) lastMessageError = error;
      }
    }
    if (!messagesPassed) {
      throw lastMessageError ?? new AvitoApiError(
        "AVITO_MESSAGES_UNAVAILABLE",
        null,
        false,
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
