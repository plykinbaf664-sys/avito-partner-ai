import type { ExtractedMessage } from "../extraction/extracted-message";
import { calculateEconomicsEstimate } from "../economics/economics-calculator";

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

const containsAny = (text: string, terms: readonly string[]) =>
  terms.some((term) => text.includes(term));

const economicsTerms = [
  "заработ",
  "зарабат",
  "принос",
  "доход",
  "прибыл",
  "окуп",
] as const;

const mentionsFiftyThousand = (text: string) =>
  /(^|[^\d])50(?:\s*000|\s*тысяч)/u.test(text);

function formatUnitCount(units: number): string {
  const modulo100 = units % 100;
  const modulo10 = units % 10;
  const noun =
    modulo100 >= 11 && modulo100 <= 14
      ? "объектов"
      : modulo10 === 1
        ? "объекта"
        : modulo10 >= 2 && modulo10 <= 4
          ? "объектов"
          : "объектов";
  return `${units} ${noun}`;
}

export const PARTNER_KNOWLEDGE_BASE: readonly KnowledgeEntry[] = [
  {
    id: "small-business-entry",
    category: "BUSINESS_MODEL",
    answer:
      "Около 50 000 ₽ — ориентир оплаты услуги команды: помощь с подбором подходящего объекта и рекомендации или чек-лист по базовой комплектации. Отдельно партнёр оплачивает аренду, залог, комплектацию и другие расходы по объекту. Текущие ориентиры — около 35 000 ₽ на аренду, около 35 000 ₽ на залог и около 120 000 ₽ минимального капитала на запуск; дополнительно желательно предусмотреть порядка 20 000 ₽ на базовое оснащение. Это не фиксированная смета: итог зависит от конкретного объекта.",
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
      "Оплата включает 100% от стоимости объекта за его поиск, 500 ₽ за размещение одного объекта на одной площадке и 100 ₽ в сутки за обработанную и заселённую бронь. Что именно входит в формулировку «стоимость объекта», лучше отдельно уточнить у менеджера.",
    matches: (text) =>
      containsAny(text, [
        "сколько бер",
        "сколько вы бер",
        "стоимост",
        "цен",
        "комисси",
        "оплат",
      ]),
  },
  {
    id: "guarantees-and-economics",
    category: "GUARANTEES",
    answer:
      "Гарантированного дохода нет. По текущей модели ориентир по доходу партнёров составляет около 20 000 ₽ с одного объекта в месяц, но фактический результат зависит от конкретного объекта и условий.",
    matches: (text) => {
      const incomeContext = containsAny(text, economicsTerms);
      return incomeContext || (text.includes("гарант") && text.includes("в месяц"));
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
    matches: (text) => containsAny(text, ["crm", "срм", "видеть брони", "кабинет"]),
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
      containsAny(text, ["что вы делаете", "как работает", "расскажите подробнее", "обязанност", "управляющая компания"]),
  },
] as const;

export interface KnowledgeAnswer {
  answerFragments: string[];
  entryIds: string[];
  unresolvedQuestions: string[];
}

export function answerFromKnowledgeBase(
  extraction: ExtractedMessage,
): KnowledgeAnswer {
  const userStatements = [
    ...extraction.signals.questions,
    ...extraction.signals.objections,
  ];
  const matched = PARTNER_KNOWLEDGE_BASE.filter((entry) =>
    userStatements.some((statement) =>
      entry.matches(statement.trim().toLocaleLowerCase("ru-RU")),
    ),
  );
  const unresolvedQuestions = extraction.signals.questions.filter((question) => {
    const normalized = question.trim().toLocaleLowerCase("ru-RU");
    return !matched.some((entry) => entry.matches(normalized));
  });

  const asksAboutEconomics = userStatements.some((statement) =>
    containsAny(statement.trim().toLocaleLowerCase("ru-RU"), [
      ...economicsTerms,
      "гарант",
    ]),
  );
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
  const explicitUnits =
    extraction.facts.calculationUnits ??
    extraction.facts.startingUnits ??
    extraction.facts.scalingPotentialUnits;
  const estimate = asksAboutEconomics
    ? calculateEconomicsEstimate(explicitUnits)
    : null;
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
    if (
      extraction.facts.availableCapital !== null ||
      extraction.facts.entryBudget !== null
    ) {
      return "По одному размеру капитала нельзя корректно определить количество объектов: универсальная стоимость запуска объекта пока не подтверждена. Могу посчитать ориентир по доходу, когда определим предполагаемое число объектов.";
    }
    return entry.answer;
  });

  return {
    answerFragments: [...new Set(answerFragments)],
    entryIds: matched.map((entry) => entry.id),
    unresolvedQuestions,
  };
}
