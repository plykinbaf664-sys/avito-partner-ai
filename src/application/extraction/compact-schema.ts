/** Field meaning belongs next to its schema. No customer phrase routing. */
export function describeCompactExtractionSchema(properties: Record<string, { required?: string[]; description?: string;
  properties?: Record<string, { description?: string }> }>) {
  properties.intent!.description = "Classify the current user's communicative act, not business feasibility. DECLINE means an expressed choice to reject/stop; a financial barrier or a factual answer is not DECLINE.";
  const meanings: Record<string, string> = {
    availableCapital: "Money the user actually has/can invest in the complete business launch. A general launch budget is available capital; company service fee is a separate concept. Omit if unknown.",
    availableCapitalConfirmed: "User confidently reports availability of this amount; not a qualification verdict. Report only together with a known availableCapital.",
    entryBudget: "Amount explicitly restricted to paying the company's service/entry stage. Never map a general business launch budget here merely because it relates to starting a business.",
    additionalLaunchCapital: "Explicit extra money beyond a restricted entry budget. Omit when not discussed; absence is not zero.",
    capitalScope: "TOTAL_LIMIT=total available launch capital; ENTRY_ONLY=explicitly restricted to company fee/entry stage; ADDITIONAL_AVAILABLE=explicit extra funds; UNKNOWN=scope not established.",
    launchTiming: "An actually expressed intended launch time horizon. Willingness/readiness to invest or pay alone does not establish when the person will launch.",
    startingUnits: "The user's chosen starting scale. Never substitute calculator capacity, an AI recommendation or an arbitrarily selected endpoint of an ambiguous range/options for their choice. Omit when undecided; preserve discussed alternatives in uncertainty.",
    calculationUnits: "Number of objects for the current cost/income calculation, including a hypothetical scale. For discussed alternatives, an explicitly mentioned option may be a calculation argument without being a chosen startingUnits fact. Resolve an ongoing unanswered calculation from reliable recent context when the user supplies a missing input. This is a conversational calculation argument, never their chosen startingUnits.",
    scalingPotentialUnits: "Future scale actually expressed by the user, not inferred from budget.",
    hasFreeTime: "User's stated availability to spend time. Asking how much time is needed does not establish availability.",
    businessModelReadiness: "User's actual acceptance/consideration/rejection of the operating business model. Money, phone, or location alone does not imply acceptance or rejection.",
    buyingIntent: "Current expressed business interest/choice. On clearly renewed interest or reversed refusal, update the old DECLINED state. Do not infer DECLINED from a barrier or inability to invest today.",
    rejectsBusinessModel: "Only the user's expressed rejection of the model. A consultant's refusal or old qualification verdict is not a user rejection.",
    requiresGuaranteedIncome: "Only the user's expressed demand for guaranteed income. Company disclaimers do not establish such a demand.",
  };
  const facts = properties.facts!.properties!;
  for (const [key, description] of Object.entries(meanings)) facts[key]!.description = description;
}
