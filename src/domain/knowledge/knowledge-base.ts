import type { ExtractedMessage } from "../extraction/extracted-message";
import {
  buildApprovedEconomicsContext,
  calculateAffordableObjectCount,
  calculateEconomicsEstimate,
  findApprovedRentReference,
  GENERAL_RENT_RANGE_REFERENCE,
  PARTNER_MONTHLY_INCOME_PER_UNIT_REFERENCE,
  type ApprovedEconomicsContext,
  type RentRangeReference,
} from "../economics/economics-calculator";
import { SERVICEABILITY_POLICY } from "../lead/serviceability";
import type { InformationNeed } from "../conversation/information-needs";

export const knowledgeCategories = [
  "BUSINESS_MODEL",
  "PRICING",
  "ECONOMICS",
  "RESPONSIBILITIES",
  "OPERATIONS",
  "CRM",
  "PROOF",
  "GUARANTEES",
  "LIMITATIONS",
  "COMMON_OBJECTION",
] as const;

export type KnowledgeCategory = (typeof knowledgeCategories)[number];

export interface KnowledgeEntry {
  id: string;
  category: KnowledgeCategory;
  answer: string;
  matches: (normalizedText: string) => boolean;
}

export interface ApprovedKnowledgeFact {
  id: string;
  category: KnowledgeCategory;
  answer: string;
}

const containsAny = (text: string, terms: readonly string[]) =>
  terms.some((term) => text.includes(term));

const economicsTerms = [
  "заработ",
  "зарабат",
  "получ",
  "принос",
  "доход",
  "выруч",
  "прибыл",
  "окуп",
] as const;

const mentionsFiftyThousand = (text: string) =>
  /(^|[^\d])50(?:\s*000|\s*тыс)/u.test(text);

const normalizeQuestion = (text: string) =>
  text.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");

// One extracted question can contain both an answerable part and an unknown one.
const questionParts = (text: string) => text
  .split(/[?;\n]+|[,\s]+(?:и|а)\s+(?=(?:как|какие|какой|какая|какую|кто|что|сколько|можно|есть ли)\s)/iu)
  .map((part) => part.trim()).filter(Boolean);

const asksAboutInvestorTerms = (text: string) =>
  /(?:отлич|разниц|услови|сценари|формат).{0,40}инвестор|инвестор.{0,40}(?:отлич|разниц|услови|сценари|формат)/u.test(text);

const needsIndividualAnswer = (text: string) =>
  asksAboutInvestorTerms(text) ||
  /(?:договор(?:а|у|ом|е|ы|ов)?(?:$|[^а-я])|юридич|налог|страхов|рассроч|скидк|хочу оплат|готов оплат|как оплатить|куда оплатить|api|интеграц|экспорт|франшиз|без залога|изменить условия)/u.test(text) ||
  (
    /какие.{0,30}конкретн.{0,30}(?:квартир|объект)/u.test(text) ||
    /(?:конкретн|выбранн).{0,40}(?:квартир|объект).{0,40}(?:адрес|улиц|собственник)/u.test(text) ||
    (/(?:квартир|объект).{0,40}(?:по адресу|за \d)/u.test(text) &&
      containsAny(text, [...economicsTerms, "расчет", "смет", "аренд", "залог", "комплектац", "цен", "стоимост", "услови"])) ||
    /(?:этой|этому|моей|моему).{0,40}(?:квартир|объект)/u.test(text) &&
      containsAny(text, [...economicsTerms, "расчет", "смет", "аренд", "залог", "комплектац", "цен", "стоимост", "услови"])
  ) ||
    /(?:рассчита|посчита).{0,35}(?:конкретн|выбранн|адрес|улиц|собственник)/u.test(text);

function formatUnitCount(units: number): string {
  const modulo100 = units % 100;
  const modulo10 = units % 10;
  const noun =
    modulo100 >= 11 && modulo100 <= 14
      ? "объектов"
      : modulo10 === 1
        ? "объект"
        : modulo10 >= 2 && modulo10 <= 4
          ? "объектов"
          : "объектов";
  return `${units} ${noun}`;
}

export const PARTNER_KNOWLEDGE_BASE: readonly KnowledgeEntry[] = [
  {
    id: "supported-cities",
    category: "LIMITATIONS",
    answer: `Подтверждённые города работы: ${SERVICEABILITY_POLICY.supportedCities.join(", ")}. По другим городам возможность запуска нужно проверять отдельно; отсутствие города в списке не означает автоматический отказ.`,
    matches: (text) =>
      /(?:можно|работ|запуск|схем).{0,35}(?:москв|город)|(?:москв|город).{0,35}(?:можно|работ|запуск|схем)/u.test(text),
  },
  {
    id: "offer-overview",
    category: "BUSINESS_MODEL",
    answer:
      "Вы запускаете свой бизнес на субаренде — это посуточная сдача квартир. Компания помогает подобрать и запустить объект, а управляющая команда помогает с рекламой, бронированиями, гостями и операционной работой. Услуга запуска стоит 50 000 ₽; отдельно партнёр оплачивает аренду, залог, подготовку объекта и операционные расходы. Для предварительного расчёта с залогом в один месяц используется ориентир 80 000 ₽ плюс две месячные аренды, но фактический залог зависит от объекта и собственника. Доход не гарантируется.",
    matches: (text) => /(?:услови|предлага|предложени|схем[аы]|модель работ|формат работ|суть бизнес|что за бизнес|чем занимаетесь)/u.test(text),
  },
  {
    id: "launch-process",
    category: "OPERATIONS",
    answer:
      "Команда помогает подобрать объект, даёт рекомендации по комплектации, помогает с запуском и размещением на площадках. Аренду, залог и комплектацию оплачивает партнёр. Бронирования и гостей ведёт администратор, он же координирует горничную. После запуска с вами работает персональный менеджер, а брони и площадки, с которых они пришли, видны онлайн в CRM.",
    matches: (text) => /организаци[яию] бизнес|(?:как|этап|порядок).{0,35}(?:запуст|организ|запуск)|как.{0,20}(?:устроен|проход).{0,25}(?:бизнес|работ)|после запуска/u.test(text),
  },
  {
    id: "investor-scenario-scope",
    category: "LIMITATIONS",
    answer:
      "В модели малого бизнеса партнёр запускает собственный бизнес на субаренде и несёт расходы по объекту, а управляющая компания помогает с запуском и операционной работой.",
    matches: asksAboutInvestorTerms,
  },
  {
    id: "single-unit-start",
    category: "BUSINESS_MODEL",
    answer:
      "Начать можно с одного объекта. Для малого бизнеса хороший целевой масштаб — 3–5 объектов, но старт с одного не является причиной отказа; расходы выбранного объекта всё равно нужно считать отдельно.",
    matches: (text) => /(?:начать|начинать|старт|запуст).{0,30}(?:одн|1\s*(?:объект|квартир))/u.test(text),
  },
  {
    id: "small-business-scale",
    category: "BUSINESS_MODEL",
    answer:
      "Для малого бизнеса хороший целевой масштаб — 3–5 объектов. Начать можно с одного и масштабироваться постепенно; большее число объектов увеличивает потенциальный абсолютный результат, но не является гарантией более быстрой окупаемости.",
    matches: (text) =>
      /(?:сколько|какое количество|масштаб).{0,35}(?:объект|квартир)|(?:масштабир|расти)(?:.{0,35}(?:объект|квартир))?/u.test(text),
  },
  {
    id: "small-business-entry",
    category: "BUSINESS_MODEL",
    answer:
      "Услуга помощи в запуске бизнеса стоит 50 000 ₽. Отдельно партнёр оплачивает аренду, залог, подготовку объекта — ориентир 30 000 ₽ на один объект — и другие операционные расходы. Залог зависит от объекта и собственника; для предварительного расчёта используется ориентир в один месяц аренды. При таком допущении старт одного объекта составляет около 150 000 ₽ при аренде 35 000 ₽ и около 180 000 ₽ при аренде 50 000 ₽. Это расчётные ориентиры, а не фиксированная смета или рыночная цена конкретного города.",
    matches: (text) =>
      mentionsFiftyThousand(text) ||
      containsAny(text, [
        "первый этап",
        "субаренд",
        "дополнительн",
        "залог",
        "оснащен",
        "расход",
        "сколько нужно",
        "сколько надо",
        "сколько вообще",
        "хватит",
        "бюджет запуска",
        "сколько денег",
        "стартов",
        "комплектац",
        "аренд",
        "на первом этапе",
        "входит в первый",
        "первого этапа",
      ]),
  },
  {
    id: "qualification-fit",
    category: "LIMITATIONS",
    answer:
      "Чтобы понять, подходит ли вам формат, нужно коротко уточнить несколько ключевых моментов по ситуации и планам запуска.",
    matches: (text) =>
      containsAny(text, [
        "подойдёт ли мне",
        "подойдет ли мне",
        "подходит ли мне",
        "могу ли я начать",
      ]),
  },
  {
    id: "pricing",
    category: "PRICING",
    answer:
      "Услуга помощи в запуске бизнеса стоит 50 000 ₽. В неё входят организация и запуск, реклама со стороны компании, CRM, личный менеджер для обработки заявок, бухгалтерское и юридическое сопровождение, а также поиск или предоставление подходящих объектов. Партнёр ездит на подходящие объекты и заключает необходимые договоры; аренда, залог, подготовка и операционные расходы оплачиваются отдельно.",
    matches: (text) =>
      !/перв\p{L}* этап|аренд|залог|комплект|старт|запуск/u.test(text) &&
      containsAny(text, [
        "сколько бер",
        "сколько вы бер",
        "стоимост",
        "цен",
        "комисси",
        "оплат",
        "оплач",
      ]),
  },
  {
    id: "guarantees-and-economics",
    category: "GUARANTEES",
    answer:
      "Гарантированного дохода нет. По текущей модели ориентир по доходу партнёров составляет около 20 000 ₽ с одного объекта в месяц, но фактический результат зависит от конкретного объекта и условий.",
    matches: (text) => {
      const incomeContext = containsAny(text, economicsTerms);
      return incomeContext || (text.includes("гарант") &&
        (text.includes("в месяц") || !containsAny(text, ["хватит", "бюджет", "запуск", "влож", "тысяч"])));
    },
  },
  {
    id: "operations-guests",
    category: "OPERATIONS",
    answer:
      "Заявки и работу с гостями ведёт администратор: обрабатывает обращения, работает с возражениями, запрашивает обратную связь и координирует горничную. После запуска с партнёром также работает персональный менеджер управляющей компании.",
    matches: (text) =>
      containsAny(text, ["гост", "брон", "горнич", "клининг", "администратор", "кто будет заниматься"]),
  },
  {
    id: "property-not-required",
    category: "BUSINESS_MODEL",
    answer:
      "Собственная квартира не обязательна и сама по себе её отсутствие не является причиной отказа: компания помогает искать объекты и договариваться с собственниками.",
    matches: (text) =>
      containsAny(text, ["своей квартир", "своей недвиж", "нет квартир", "нет недвиж", "объект в собственности"]),
  },
  {
    id: "crm-visibility",
    category: "CRM",
    answer:
      "Партнёра добавляют в CRM, где в онлайн-режиме видно, какие брони приходят и с каких площадок.",
    matches: (text) => containsAny(text, ["crm", "срм", "видеть брони", "вижу брони", "видит брони", "кабинет"]) ||
      /(?:как|где).{0,30}(?:смотр|вид|отслеж).{0,20}брон/u.test(text),
  },
  {
    id: "proof-of-results",
    category: "PROOF",
    answer:
      "Сомнение понятно: ориентиры основаны на результатах собственных объектов компании в Московской области и внутреннем анализе. Компания может показать скриншоты выручки по объектам, но это не гарантия результата для нового объекта.",
    matches: (text) =>
      containsAny(text, ["не верю", "доказ", "скрин", "отзыв", "кейс", "цифр"]),
  },
  {
    id: "company-responsibilities",
    category: "RESPONSIBILITIES",
    answer:
      "Управляющая компания помогает с поиском и запуском объектов, объявлениями, бронированиями, дистанционным заселением, гостями, клинингом, календарями и координацией персонала. Расходы по бизнесу несёт партнёр как владелец своего бизнеса.",
    matches: (text) =>
      containsAny(text, ["что вы делаете", "расскажите подробнее", "обязанност", "управляющая компания"]) ||
      /(?:что делает|роль|отвечает|нужно делать).{0,30}(?:компани|партнер|команд)|как работает компания/u.test(text),
  },
  {
    id: "partner-time",
    category: "RESPONSIBILITIES",
    answer:
      "Партнёру нужно участвовать в запуске и ключевых решениях, в том числе ездить на подходящие объекты и заключать договоры. Ориентир вовлечённости — около 3–4 часов в день; если времени меньше, это не автоматический отказ, но менеджеру важно учитывать такой риск.",
    matches: (text) =>
      containsAny(text, ["сколько времени", "часов в день", "свободного времени", "мало времени"]),
  },
] as const;

export interface KnowledgeAnswer {
  answerFragments: string[];
  entryIds: string[];
  unresolvedQuestions: string[];
  contextualReferenceResolved: boolean;
  economicsContext?: ApprovedEconomicsContext;
  approvedFacts: ApprovedKnowledgeFact[];
}

export interface KnowledgeConversationContext {
  previousEntryIds?: readonly string[];
  recentMessages?: readonly { direction: "INBOUND" | "OUTBOUND"; content: string }[];
  rentReference?: RentRangeReference;
  guidanceNeed?: InformationNeed | null;
  leadFacts?: {
    city?: string | null;
    availableCapital?: number | null;
    entryBudget?: number | null;
    startingUnits?: number | null;
    scalingPotentialUnits?: number | null;
  };
}

const refersToPreviousContext = (text: string) =>
  /(?:^|\s)(?:а\s+)?(?:это|эта|эти|такой|такая|также|так же|в эту|входит|получается|итого|всего|если (?:один|два|три|\d+)|на (?:один|два|три|\d+))(?:\s|\?|$)/u.test(text) ||
  /(?:^|[^\d])\d[\d\s]*(?:тыс(?:яч[аиу]?)?|₽|руб)/u.test(text);

const inferUnitCount = (text: string): number | null => {
  const numeric = text.match(/(?:^|\D)(\d{1,2})\s*(?:объект|квартир|помещен)/iu)?.[1];
  if (numeric) return Number(numeric);
  const words: Readonly<Record<string, number>> = {
    один: 1, одного: 1, одной: 1,
    два: 2, двух: 2,
    три: 3, трех: 3, трёх: 3,
    четыре: 4, четырёх: 4, четырех: 4,
    пять: 5, пяти: 5,
  };
  const match = Object.entries(words).find(([word]) =>
    new RegExp(`(?:^|\\s)${word}(?:\\s|$).{0,20}(?:объект|квартир|помещен)`, "iu").test(text),
  );
  return match?.[1] ? match[1] : null;
};

const formatMoney = (amount: number) =>
  `${amount.toLocaleString("ru-RU").replaceAll("\u00a0", " ")} ₽`;

export function answerFromKnowledgeBase(
  extraction: ExtractedMessage,
  context: KnowledgeConversationContext = {},
): KnowledgeAnswer {
  const userStatements = [
    ...extraction.signals.questions,
    ...extraction.signals.objections,
    ...(extraction.signals.resolvedQuestion
      ? [extraction.signals.resolvedQuestion]
      : []),
  ].flatMap(questionParts);
  const directCandidates = PARTNER_KNOWLEDGE_BASE.filter((entry) =>
    userStatements.some((statement) =>
      entry.matches(normalizeQuestion(statement)),
    ),
  );
  const contextualReference =
    extraction.signals.contextualReference === true ||
    userStatements.some((statement) =>
      refersToPreviousContext(normalizeQuestion(statement)),
    );
  const allPreviousCandidates = PARTNER_KNOWLEDGE_BASE.filter((entry) =>
    context.previousEntryIds?.includes(entry.id),
  );
  const latestOutbound = context.recentMessages?.findLast(
    (message) => message.direction === "OUTBOUND",
  );
  const recentGroundedCandidates = latestOutbound
    ? PARTNER_KNOWLEDGE_BASE.filter((entry) =>
      entry.matches(normalizeQuestion(latestOutbound.content)),
    )
    : [];
  const previousCandidates = contextualReference
    ? (recentGroundedCandidates.length > 0
      ? recentGroundedCandidates.slice(0, 3)
      : allPreviousCandidates.slice(-1))
    : [];
  const candidates = [...new Map([...directCandidates, ...previousCandidates]
    .map((entry) => [entry.id, entry])).values()];
  // Overviews already contain these facts; avoid repeating entire KB paragraphs.
  const hasOffer = candidates.some((entry) => entry.id === "offer-overview");
  const hasProcess = candidates.some((entry) => entry.id === "launch-process");
  const matched = candidates.filter((entry) =>
    !(hasOffer && ["small-business-entry", "company-responsibilities"].includes(entry.id)) &&
    !(hasProcess && entry.id === "offer-overview") &&
    !(hasProcess && ["company-responsibilities", "operations-guests", "crm-visibility"].includes(entry.id)));

  const asksAboutEconomics = userStatements.some((statement) =>
    containsAny(statement.trim().toLocaleLowerCase("ru-RU"), [
      ...economicsTerms,
      "гарант",
    ]),
  ) || (contextualReference && previousCandidates.some(
    (entry) => entry.id === "guarantees-and-economics",
  ));
  const asksWhetherLaunchBudgetIsGuaranteed = userStatements.some(
    (statement) => {
      const normalized = statement.trim().toLocaleLowerCase("ru-RU");
      return (
        !containsAny(normalized, economicsTerms) &&
        containsAny(normalized, ["гарант", "хватит"]) &&
        containsAny(normalized, ["тысяч", "бюджет", "запуск", "влож"])
      );
    },
  );
  const asksAboutAffordableObjects = context.guidanceNeed === "STARTING_UNITS" ||
    userStatements.some((statement) => {
    const normalized = statement.trim().toLocaleLowerCase("ru-RU");
    const mentionsObjects = /объект|квартир|помещен/iu.test(normalized);
    const asksCount = /сколько|какое количество|потяну|влезет|начать/iu.test(normalized);
    const mentionsBudget = /капитал|бюджет|деньг|влож|сумм|тысяч|руб/iu.test(normalized);
    return mentionsObjects && asksCount && (
      mentionsBudget ||
      extraction.facts.availableCapital !== null ||
      context.leadFacts?.availableCapital != null
    );
    });
  const availableCapital = extraction.facts.availableCapital ??
    extraction.facts.entryBudget ??
    context.leadFacts?.availableCapital ??
    context.leadFacts?.entryBudget ??
    null;
  const requestedUnits = extraction.facts.calculationUnits ??
    extraction.facts.startingUnits ??
    extraction.facts.scalingPotentialUnits ??
    userStatements.map(inferUnitCount).find((units): units is number => units !== null) ??
    context.leadFacts?.startingUnits ??
    context.leadFacts?.scalingPotentialUnits ??
    null;
  const explicitUnits = requestedUnits;
  const estimate = asksAboutEconomics
    ? calculateEconomicsEstimate(explicitUnits)
    : null;
  const city = extraction.facts.city ?? context.leadFacts?.city ?? null;
  const effectiveRentReference = context.rentReference ?? findApprovedRentReference(city);
  const shouldProvideEconomicsContext =
    asksAboutEconomics ||
    asksAboutAffordableObjects ||
    context.guidanceNeed === "ADDITIONAL_EXPENSES" ||
    extraction.facts.calculationUnits !== null ||
    matched.some((entry) => entry.id === "small-business-entry");
  const economicsContext = shouldProvideEconomicsContext
    ? buildApprovedEconomicsContext({
        availableCapital,
        requestedUnits,
        city,
        rentReference: effectiveRentReference ?? undefined,
      })
    : undefined;
  const affordableObjects = asksAboutAffordableObjects && availableCapital !== null
    ? calculateAffordableObjectCount({
      availableCapital,
      rentReference: effectiveRentReference ?? GENERAL_RENT_RANGE_REFERENCE,
    })
    : null;
  const unresolvedQuestions = extraction.signals.questions.flatMap(questionParts).filter((question) => {
    // Missing literal wording is not an information gap. Claude receives the
    // complete approved fact set and decides semantic coverage. This list is
    // reserved for policy-level gaps such as concrete object/legal details.
    return needsIndividualAnswer(normalizeQuestion(question));
  });
  const answerFragments = matched.map((entry) => {
    if (
      entry.id === "small-business-entry" &&
      asksWhetherLaunchBudgetIsGuaranteed
    ) {
      return "Это рабочий ориентир, а не фиксированная смета или гарантия достаточности бюджета. Итог зависит от конкретного объекта: аренду, залог и комплектацию нужно считать по выбранной квартире.";
    }
    if (entry.id !== "guarantees-and-economics" || !asksAboutEconomics) {
      return entry.answer;
    }
    if (estimate) {
      const monthlyIncome = estimate.estimatedMonthlyIncome
        .toLocaleString("ru-RU")
        .replaceAll("\u00a0", " ");
      return `Для ${formatUnitCount(estimate.units)} ориентир по доходу составляет около ${monthlyIncome} ₽ в месяц. ${estimate.disclaimer}`;
    }
    if (asksAboutEconomics && availableCapital !== null && economicsContext) {
      const incomeScenarios = economicsContext.scenarios
        .filter((scenario) => scenario.affordableObjectCount !== null)
        .map((scenario) => {
          const count = scenario.affordableObjectCount!.maxUnitsAtMinCost;
          const income = (count * PARTNER_MONTHLY_INCOME_PER_UNIT_REFERENCE)
            .toLocaleString("ru-RU").replaceAll("\u00a0", " ");
          return `${scenario.label}: при таком ориентире капитала до ${formatUnitCount(count)}, около ${income} ₽/мес`;
        });
      if (incomeScenarios.length > 0) {
        return `${entry.answer} При капитале около ${formatMoney(availableCapital)} ориентир по доступному объёму и доходу такой: ${incomeScenarios.join("; ")}. Это расчётный ориентир, а не гарантия.`;
      }
    }
    if (
      affordableObjects === null &&
      (availableCapital !== null || extraction.facts.entryBudget !== null)
    ) {
      return `${entry.answer} По одному размеру капитала нельзя корректно определить количество объектов: универсальная стоимость запуска объекта пока не подтверждена. Могу посчитать общий ориентир по доходу, когда определим предполагаемое число объектов.`;
    }
    return entry.answer;
  });

  if (affordableObjects && availableCapital !== null) {
    const scenarios = economicsContext!.scenarios.filter((scenario) => scenario.affordableObjectCount !== null);
    const scenarioText = scenarios.map((scenario) => {
      const count = scenario.affordableObjectCount!;
      const units = count.maxUnitsAtMinCost === count.maxUnitsAtMaxCost
        ? `около ${formatUnitCount(count.maxUnitsAtMinCost)}`
        : `ориентировочно от ${count.maxUnitsAtMaxCost} до ${count.maxUnitsAtMinCost} объектов`;
      const startup = count.totalStartupCostAtMinCost === count.totalStartupCostAtMaxCost
        ? `запуск ${formatMoney(count.totalStartupCostAtMinCost)}`
        : `запуск примерно от ${formatMoney(count.totalStartupCostAtMaxCost)} до ${formatMoney(count.totalStartupCostAtMinCost)}`;
      return `${scenario.label}: ${units}, ${startup}`;
    }).join("; ");
    answerFragments.push(
      `При капитале около ${formatMoney(availableCapital)} ориентир по утверждённым сценариям такой: ${scenarioText}. В расчёте услуга запуска 50 000 ₽ оплачивается один раз, а на каждый объект закладываются аренда, залог и около 30 000 ₽ подготовки; это расчётный ориентир, а не фиксированная смета.`,
    );
  }

  return {
    answerFragments: [...new Set(answerFragments)],
    entryIds: matched.map((entry) => entry.id),
    unresolvedQuestions,
    contextualReferenceResolved:
      contextualReference && previousCandidates.length > 0 && unresolvedQuestions.length === 0,
    economicsContext,
    approvedFacts: PARTNER_KNOWLEDGE_BASE.map(({ id, category, answer }) => ({
      id,
      category,
      answer,
    })),
  };
}
