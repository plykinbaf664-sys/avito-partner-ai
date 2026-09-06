import { z } from "zod";

import type { ConversationResponsePlan } from "@/domain/conversation/conversation-response";
import type { Lead } from "@/domain/lead/lead";

import type { LlmProvider } from "../ports/llm-provider";

const naturalResponseSchema = z.object({ text: z.string().trim().min(1).max(1_200) }).strict();

export interface NaturalResponseResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export type NaturalResponseGenerator = (input: {
  lead: Lead;
  plan: ConversationResponsePlan;
  recentMessages: { direction: "INBOUND" | "OUTBOUND"; content: string }[];
}) => Promise<NaturalResponseResult>;

export function createNaturalResponseGenerator(params: {
  llmProvider: LlmProvider;
  maxTokens?: number;
}): NaturalResponseGenerator {
  const { llmProvider, maxTokens = 320 } = params;
  return async ({ lead, plan, recentMessages }) => {
    const jsonSchema = z.toJSONSchema(naturalResponseSchema);
    delete jsonSchema.$schema;
    const response = await llmProvider.generateText({
      systemPrompt: `
Ты редактируешь уже безопасно подготовленный ответ AI-квалификатора партнёров.
Верни JSON {"text":"..."}. Пиши только по-русски, коротко, естественно и профессионально — обычно 2–5 предложений.
Сохрани все факты, цены, ограничения и смысл следующего вопроса из черновика. Не добавляй новых цифр, обещаний, условий, кейсов или гарантий.
Не превращай ответ в анкету, не дави и не используй искусственный дефицит.
`.trim(),
      userMessage: JSON.stringify({
        approvedDraft: plan.text,
        currentFacts: {
          city: lead.city,
          budget: lead.budget,
          startingUnits: lead.startingUnits,
          scalingPotentialUnits: lead.scalingPotentialUnits,
          launchTiming: lead.launchTiming,
          primaryGoal: lead.primaryGoal,
        },
        recentMessages: recentMessages.slice(-3),
      }),
      maxTokens,
      jsonSchema,
    });
    const parsed = naturalResponseSchema.parse(JSON.parse(response.text));
    return {
      text: parsed.text,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
    };
  };
}
