import { createServer, type Server } from "node:http";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily, type LookupFunction } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createAvitoDispatcher } from "./avito-transport";

const originalAutoSelect = getDefaultAutoSelectFamily();
afterEach(() => setDefaultAutoSelectFamily(originalAutoSelect));

const lookup: LookupFunction = (_host, options, callback) => {
  const addresses = [{ address: "127.0.0.2", family: 4 }, { address: "127.0.0.1", family: 4 }];
  if (options.all) callback(null, addresses);
  else callback(null, addresses[0].address, 4);
};

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return `http://avito-fixture.invalid:${address.port}`;
}

it("uses the next DNS address before sending a single POST despite disabled process autoselection", async () => {
  setDefaultAutoSelectFamily(false);
  let received = 0;
  const server = createServer((request, response) => {
    received++;
    request.resume();
    response.end("ok");
  });
  const url = await listen(server);
  const dispatcher = createAvitoDispatcher(lookup);
  try {
    const options = { method: "POST", body: "synthetic-message", dispatcher, signal: AbortSignal.timeout(2_000) };
    const response = await fetch(url, options);
    expect(await response.text()).toBe("ok");
    expect(received).toBe(1);
    expect(getDefaultAutoSelectFamily()).toBe(false);
  } finally {
    await dispatcher.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("does not resend a POST when the server accepted it but lost the response", async () => {
  setDefaultAutoSelectFamily(false);
  let received = 0;
  const server = createServer((request, response) => {
    received++;
    request.resume();
    request.on("end", () => response.destroy());
  });
  const url = await listen(server);
  const dispatcher = createAvitoDispatcher(lookup);
  try {
    const options = { method: "POST", body: "synthetic-message", dispatcher, signal: AbortSignal.timeout(2_000) };
    await expect(fetch(url, options)).rejects.toThrow();
    expect(received).toBe(1);
  } finally {
    await dispatcher.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
