import { z } from "zod";

import type { LlmProvider, LlmTextResponse } from "../ports/llm-provider";
import {
  businessBarriers,
  launchTimings,
  managementReadinessValues,
  messageIntents,
  primaryGoals,
  type ExtractedMessage,
} from "../../domain/extraction/extracted-message";

const nullableText = z.string().trim().min(1).nullable();

export const extractedMessageSchema = z
  .object({
    intent: z.enum(messageIntents),
    facts: z
      .object({
        city: nullableText,
        budget: z.number().int().nonnegative().nullable(),
        // False also covers an absent budget; merge only reads this flag when
        // a numeric budget is present, avoiding a redundant schema union.
        budgetConfirmed: z.boolean(),
        startingUnits: z.number().int().nonnegative().nullable(),
        scalingPotentialUnits: z.number().int().nonnegative().nullable(),
        hasFreeTime: z.boolean().nullable(),
        availableTimeDetails: nullableText,
        businessExperience: nullableText,
        shortTermRentalExperience: nullableText,
        ownsProperty: z.boolean().nullable(),
        desiredIncome: z.number().int().nonnegative().nullable(),
        // UNKNOWN already represents an absent/unclear goal. Keeping this
        // non-null also avoids an unnecessary union in provider JSON Schema.
        primaryGoal: z.enum(primaryGoals),
        launchTiming: z.enum(launchTimings).nullable(),
        managementReadiness: z.enum(managementReadinessValues).nullable(),
        requiresGuaranteedIncome: z.boolean().nullable(),
        rejectsBusinessModel: z.boolean().nullable(),
      })
      .strict(),
    signals: z
      .object({
        questions: z.array(z.string().trim().min(1)),
        objections: z.array(z.string().trim().min(1)),
        possiblePrimaryFear: z.enum(businessBarriers).nullable(),
        possibleSecondaryFear: z.enum(businessBarriers).nullable(),
        wantsHuman: z.boolean(),
      })
      .strict(),
    // The extractor can always report its confidence, so null adds no meaning.
    confidence: z.number().min(0).max(1),
    uncertainty: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.facts.budget === null && value.facts.budgetConfirmed) {
      context.addIssue({
        code: "custom",
        path: ["facts", "budgetConfirmed"],
        message: "A missing budget cannot be confirmed",
      });
    }
  });

export class InvalidExtractionOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidExtractionOutputError";
  }
}

export interface ExtractMessageResult {
  extraction: ExtractedMessage;
  llm: Pick<
    LlmTextResponse,
    "model" | "inputTokens" | "outputTokens"
  >;
}

export interface ExtractMessageDependencies {
  llmProvider: LlmProvider;
  maxTokens?: number;
}

export const EXTRACTION_SYSTEM_PROMPT = `
Ты извлекаешь структурированные sales/business-факты из одного сообщения потенциального партнёра бизнеса посуточной аренды.

Твоя единственная задача — понять явно сказанное или достаточно однозначно выраженное и вернуть JSON по предоставленной schema.

Правила:
- Не отвечай пользователю и не давай советов.
- Не принимай бизнес-, финансовые или qualification-решения.
- Никогда не выставляй HOT, WARM, PRIORITY, NO_FIT или handoff status.
- Не додумывай отсутствующие данные. Используй null, пустой массив и UNKNOWN только по смыслу schema.
- Вопрос и qualification facts могут присутствовать одновременно: сохрани оба сигнала.
- Любая явно вопросительная формулировка, включая «можно поработать?» или «это проблема?», должна попасть в signals.questions, даже если основной intent выбран другим.
- Не превращай низкий бюджет в придуманное возражение и не оценивай, достаточна ли сумма: это решает бизнес-логика после extraction.
- Текстовые questions, objections и uncertainty сохраняй на языке пользователя.
- budget — целое количество рублей, только если сумма понятна из текста.
- Явные «денег нет», «вложений нет» означают budget=0 и budgetConfirmed=true. Если бюджет просто не упомянут, верни budget=null и budgetConfirmed=false.
- budgetConfirmed=true только для достаточно определённого утверждения о доступном бюджете. Формулировки вроде «думаю, тысяч 300 смогу найти» дают budget=300000 и budgetConfirmed=false.
- ownsProperty отражает наличие недвижимости у человека сейчас. «У меня нет квартир» означает ownsProperty=false.
- startingUnits — сколько объектов человек реально хочет запустить на старте.
- scalingPotentialUnits — до какого количества объектов он потенциально готов масштабироваться.
- «Начну с одной» → startingUnits=1, scalingPotentialUnits=null.
- «Начну с одной, потом хочу пять» → startingUnits=1, scalingPotentialUnits=5.
- «Сразу готов пять» → startingUnits=5, scalingPotentialUnits=5.
- Не используй количество уже имеющихся квартир как эти поля. Отсутствие своей недвижимости не означает ноль объектов.
- launchTiming=NO_PLANS только при прямом отказе запускаться. «Пока изучаю» или «просто смотрю» без прямого отказа — слабая/неопределённая готовность, но не NO_PLANS.
- managementReadiness=NOT_READY только при прямом отказе участвовать, взаимодействовать и коммуницировать в любом формате. «Мало времени» само по себе не означает NOT_READY.
- requiresGuaranteedIncome=true только когда гарантия дохода является явно обязательным условием. Страх, сомнение или вопрос о доходности не являются таким условием.
- rejectsBusinessModel=true только при прямом принципиальном отказе от самой модели продукта, а не при вопросе или возражении.
- possiblePrimaryFear и possibleSecondaryFear — только деловые сигналы для sales-сценария, не психологический диагноз.
- Если цель не выражена, верни primaryGoal=UNKNOWN.
- confidence всегда оцени числом от 0 до 1 для extraction целиком; uncertainty кратко перечисляет существенные неоднозначности без догадок.
- Верни только JSON, без markdown.
`.trim();

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InvalidExtractionOutputError(
      "LLM returned malformed extraction JSON",
      { cause: error },
    );
  }
}

export function createMessageExtractor({
  llmProvider,
  maxTokens = 1_200,
}: ExtractMessageDependencies) {
  return async function extractMessage(text: string): Promise<ExtractMessageResult> {
    const generatedSchema = z.toJSONSchema(extractedMessageSchema);
    const jsonSchema = { ...generatedSchema };
    delete jsonSchema.$schema;
    const response = await llmProvider.generateText({
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      userMessage: text,
      maxTokens,
      jsonSchema,
    });

    const parsed = extractedMessageSchema.safeParse(parseJson(response.text));
    if (!parsed.success) {
      throw new InvalidExtractionOutputError(
        `LLM extraction failed validation: ${z.prettifyError(parsed.error)}`,
        { cause: parsed.error },
      );
    }

    const extraction: ExtractedMessage = {
      ...parsed.data,
      facts: {
        ...parsed.data.facts,
        startingUnits:
          parsed.data.facts.startingUnits === 0
            ? null
            : parsed.data.facts.startingUnits,
        scalingPotentialUnits:
          parsed.data.facts.scalingPotentialUnits === 0
            ? null
            : parsed.data.facts.scalingPotentialUnits,
      },
    };

    return {
      extraction,
      llm: {
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      },
    };
  };
}
