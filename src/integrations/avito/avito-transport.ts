import { Agent } from "undici";
import type { LookupFunction } from "node:net";

export function createAvitoDispatcher(lookup?: LookupFunction) {
  // Override legacy process-wide IPv4 settings for Avito only. Node tries DNS
  // alternatives while establishing TCP, before sending any HTTP request.
  return new Agent({
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    connectTimeout: 8_000,
    connect: { lookup },
  });
}

let dispatcher: Agent | undefined;
export const avitoFetch: typeof fetch = (input, init) => {
  const options = { ...init, dispatcher: dispatcher ??= createAvitoDispatcher() };
  return fetch(input, options);
};
