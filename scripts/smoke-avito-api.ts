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

