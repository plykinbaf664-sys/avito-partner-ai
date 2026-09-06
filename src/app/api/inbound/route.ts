import { createInboundPostHandler } from "./route-handler";
import { createRuntimeInboundProcessor } from "./runtime";

export const runtime = "nodejs";

let processor: ReturnType<typeof createRuntimeInboundProcessor> | undefined;

function getProcessor(): ReturnType<typeof createRuntimeInboundProcessor> {
  processor ??= createRuntimeInboundProcessor();
  return processor;
}

export const POST = createInboundPostHandler((input) => getProcessor()(input));
