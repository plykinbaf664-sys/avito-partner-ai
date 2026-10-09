import type { Persistence } from "../ports/repositories";
import { ACCESS_BLOCK_CODES } from "./operational-health";
import { RetryableInfrastructureError } from "../errors/infrastructure-error";
import type { IncomingPartnerEvent, ProcessIncomingEventOptions, ProcessIncomingEventResult } from "../workflows/process-incoming-event";
import { incomingPartnerEventSchema, persistIncomingEventContext } from "../workflows/process-incoming-event";
import { generateId } from "@/shared/id";

export function createAvitoRuntimeSafety(persistence: Persistence, process: (
  input: IncomingPartnerEvent, options?: ProcessIncomingEventOptions,
) => Promise<ProcessIncomingEventResult>, clock = () => new Date()) {
  return {
    async observeHistoryResult(code: string | null) {
      await persistence.operations!.observe("AVITO_MESSENGER", code === null ? "OK" :
        ACCESS_BLOCK_CODES.has(code) ? "BLOCKED" : "DEGRADED", code, clock());
    },
    async processIncomingEvent(input: IncomingPartnerEvent, options?: ProcessIncomingEventOptions) {
      const observations = await persistence.operations!.list();
      if (observations.some(row => row.component === "AVITO_MESSENGER" && row.state === "BLOCKED")) {
        await persistence.transaction(async repositories => {
          const event = await repositories.incomingEvents.findByIdentity(input.source, input.externalEventId);
          if (event?.status === "RECEIVED") await persistIncomingEventContext(repositories, event,
            incomingPartnerEventSchema.parse(input), generateId, input.receivedAt ?? clock());
        });
        // Polling has already persisted this inbound. Do not claim it, spend LLM
        // tokens or exhaust processing attempts while the account cannot reply.
        throw new RetryableInfrastructureError("AVITO_CHANNEL_ACCESS_BLOCKED");
      }
      const lead = await persistence.leads.findByExternalIdentity(input.source, input.externalLeadId);
      const history = lead ? await persistence.messages.listByLeadId(lead.id) : [];
      const managerAnsweredLater = history.some(message => message.direction === "OUTBOUND" &&
        message.actor === "MANAGER" && input.receivedAt !== undefined && message.createdAt.getTime() >= input.receivedAt.getTime());
      return process(input, managerAnsweredLater ? { ...options, suppressOutbound: true } : options);
    },
  };
}
