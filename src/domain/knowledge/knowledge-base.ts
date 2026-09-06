import type { ExtractedMessage } from "../extraction/extracted-message";

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

export const PARTNER_KNOWLEDGE_BASE: readonly KnowledgeEntry[] = [
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
      "Гарантированного дохода нет. По текущим объектам компании в Московской области и внутреннему анализу посуточной аренды ориентир составляет около 30 000 ₽ на один объект и около 150 000 ₽ на пять объектов в месяц, но результат зависит от города, объекта, загрузки и расходов.",
    matches: (text) =>
      containsAny(text, ["гарант", "150 тысяч", "150 000", "доход", "прибыл", "окуп"]),
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

  return {
    answerFragments: [...new Set(matched.map((entry) => entry.answer))],
    entryIds: matched.map((entry) => entry.id),
    unresolvedQuestions,
  };
}
