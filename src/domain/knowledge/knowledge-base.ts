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
  /(^|[^\d])50(?:\s*000|\s*тыс)/u.test(text);

const normalizeQuestion = (text: string) =>
  text.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е");

// One extracted question can contain both an answerable part and an unknown one.
const questionParts = (text: string) => text
  .split(/[?;\n]+|[,\s]+(?:и|а)\s+(?=(?:как(?:ая|ие|ой|ую)?|кто|что|сколько|можно|есть ли)\s)/iu)
  .map((part) => part.trim()).filter(Boolean);

const asksAboutInvestorTerms = (text: string) =>
  /(?:отлич|разниц|услови|сценари|формат).{0,40}инвестор|инвестор.{0,40}(?:отлич|разниц|услови|сценари|формат)/u.test(text);

const needsIndividualAnswer = (text: string) =>
  asksAboutInvestorTerms(text) ||
  /(?:договор(?:а|у|ом|е|ы|ов)?(?:$|[^а-я])|юридич|налог|страхов|рассроч|скидк|хочу оплат|готов оплат|как оплатить|куда оплатить|api|интеграц|экспорт|франшиз|без залога|изменить условия)/u.test(text) ||
  (/(?:конкретн|выбранн|этой|этому|моей|моему).{0,40}(?:квартир|объект)|(?:квартир|объект).{0,40}(?:по адресу|за \d)/u.test(text) &&
    containsAny(text, [...economicsTerms, "расчет", "смет", "аренд", "залог", "комплектац", "цен", "стоимост", "услови"])) ||
  /(?:точн|индивидуальн).{0,25}(?:расчет|услови|доход|прибыл|смет)|(?:рассчита|посчита).{0,35}(?:аренд|залог|комплектац|смет)/u.test(text);

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
    id: "offer-overview",
    category: "BUSINESS_MODEL",
    answer:
      "Вы запускаете свой бизнес на субаренде, а команда помогает подобрать и запустить объект. Первый этап — около 50 000 ₽ за помощь с подбором и рекомендации по комплектации; аренду, залог и комплектацию оплачиваете отдельно. Ориентир минимального запуска — около 120 000 ₽, плюс желательно около 20 000 ₽ на базовое оснащение. Дальше управляющая компания помогает с бронированиями, гостями и координацией персонала. Это не фиксированная смета, доход не гарантируется.",
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
      "Можно рассмотреть старт с одного объекта: команда помогает с подбором и запуском, а партнёр финансирует аренду, залог и комплектацию. Ориентиры по расходам не заменяют расчёт выбранного объекта.",
    matches: (text) => /(?:начать|начинать|старт|запуст).{0,30}(?:одн|1\s*(?:объект|квартир))/u.test(text),
  },
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
      "Оплата включает 100% от стоимости объекта за его поиск, 500 ₽ за размещение одного объекта на одной площадке и 100 ₽ в сутки за обработанную и заселённую бронь. Что именно входит в формулировку «стоимость объекта», лучше отдельно уточнить у менеджера.",
    matches: (text) =>
      !/перв\p{L}* этап|аренд|залог|комплект|старт|запуск/u.test(text) &&
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
  ].flatMap(questionParts);
  const candidates = PARTNER_KNOWLEDGE_BASE.filter((entry) =>
    userStatements.some((statement) =>
      entry.matches(normalizeQuestion(statement)),
    ),
  );
  const unresolvedQuestions = extraction.signals.questions.flatMap(questionParts).filter((question) => {
    const normalized = normalizeQuestion(question);
    return needsIndividualAnswer(normalized) || !candidates.some((entry) => entry.matches(normalized));
  });
  // Overviews already contain these facts; avoid repeating entire KB paragraphs.
  const hasOffer = candidates.some((entry) => entry.id === "offer-overview");
  const hasProcess = candidates.some((entry) => entry.id === "launch-process");
  const matched = candidates.filter((entry) =>
    !(hasOffer && ["small-business-entry", "company-responsibilities"].includes(entry.id)) &&
    !(hasProcess && ["company-responsibilities", "operations-guests", "crm-visibility"].includes(entry.id)));

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
      return `${entry.answer} По одному размеру капитала нельзя корректно определить количество объектов: универсальная стоимость запуска объекта пока не подтверждена. Могу посчитать общий ориентир по доходу, когда определим предполагаемое число объектов.`;
    }
    return entry.answer;
  });

  return {
    answerFragments: [...new Set(answerFragments)],
    entryIds: matched.map((entry) => entry.id),
    unresolvedQuestions,
  };
}
