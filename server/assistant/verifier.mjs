const forbiddenMatchers = {
  eta_or_delay_prediction: [
    /\b(?:will|won't|definitely|certainly|guaranteed to)\s+(?:be\s+)?(?:late|delayed|on time|delivered|arrive)\b/i,
    /\b(?:your|the)\s+(?:package|parcel|shipment|food|order|delivery)\s+(?:will|won't|is going to)\b/i,
    /\b\d{1,3}\s*%\s+(?:chance|probability|odds)\s+(?:of\s+)?(?:delay|being late|arrival|delivery)\b/i
  ],
  exact_setpoint: [
    /\b(?:set|raise|lower|increase|decrease|keep|turn)\s+(?:your\s+)?(?:a\/c|ac|air conditioning|thermostat|indoor temperature)\s+(?:to|at|up to|down to)\s+\d{2}\b/i,
    /\b(?:thermostat|a\/c|ac|air conditioning)\b[^.?!]{0,40}\b\d{2}\s*(?:degrees|deg|f|°f)\b/i
  ],
  traffic_or_road_status: [
    /\b(?:traffic|crashes?|road closures?|construction delays?|511|parking|transit)\b[^.?!]{0,80}\b(?:is|are|will|won't|looks?|seems?|clear|closed|blocked|delayed)\b/i
  ],
  dark_sky_guarantee: [
    /\b(?:guaranteed|definitely|certainly|will)\s+(?:see|have)\s+(?:stars|a clear sky|dark skies)\b/i,
    /\b(?:perfect|guaranteed)\s+(?:dark sky|stargazing|astronomical seeing|visibility)\b/i
  ],
  business_metric_prediction: [
    /\b(?:revenue|profit|loss|cost|sla|otif|throughput|backlog|staffing)\b[^.?!]{0,80}\b(?:will|won't|is going to|should)\b/i,
    /\$[\d,]+/
  ],
  official_safety_clearance: [
    /\b(?:officially safe|all clear|safe to ignore|ignore the warning|no safety risk|definitely safe)\b/i,
    /\b(?:safe to proceed|safe for everyone)\b/i
  ],
  outcome_guarantee: [/\b(?:guaranteed|no problem for sure|definitely fine|certainly fine|will be fine)\b/i],
  medical_advice: [/\b(?:heat stroke treatment|medical diagnosis|dose|medication|call off medication)\b/i]
};

const unsupportedTerms = [
  "traffic",
  "road closure",
  "road closures",
  "crash",
  "crashes",
  "construction delay",
  "parking",
  "transit",
  "moon phase",
  "light pollution",
  "smoke",
  "haze",
  "astronomical seeing",
  "package tracking",
  "courier assignment",
  "restaurant prep",
  "carrier route",
  "delivery network",
  "utility bill",
  "hvac performance",
  "indoor comfort"
];

export function verifyAssistantClaims(response, fallback, context = {}) {
  const answer = String(response?.answer ?? "");
  const text = combinedResponseText(response);
  const violations = [
    ...forbiddenClaimViolations(text, fallback, context),
    ...unsupportedAssertionViolations(answer, fallback),
    ...numericGroundingViolations(answer, fallback)
  ];
  if (!violations.length) {
    return { ok: true, response, violations: [] };
  }
  return {
    ok: false,
    response: verifierFallback(response, fallback, violations),
    violations
  };
}

function combinedResponseText(response) {
  return [
    response?.answer,
    ...(Array.isArray(response?.risks) ? response.risks : []),
    ...(Array.isArray(response?.bestWindows) ? response.bestWindows.flatMap((window) => [window?.label, window?.rationale]) : [])
  ]
    .filter(Boolean)
    .join(" ");
}

function forbiddenClaimViolations(text, fallback, context = {}) {
  const forbidden = new Set([
    ...(Array.isArray(context?.interpretation?.forbiddenClaims) ? context.interpretation.forbiddenClaims : []),
    ...(Array.isArray(context?.evidence?.applicationReasoning?.forbiddenClaims) ? context.evidence.applicationReasoning.forbiddenClaims : []),
    ...(Array.isArray(fallback?.facts?.interpretation?.forbiddenClaims) ? fallback.facts.interpretation.forbiddenClaims : []),
    ...inferForbiddenFromFallback(fallback)
  ]);
  const violations = [];
  for (const id of forbidden) {
    const matchers = forbiddenMatchers[id] ?? [];
    if (matchers.some((matcher) => forbiddenMatcherHits(matcher, text, id))) violations.push({ type: "forbidden_claim", id });
  }
  return violations;
}

function forbiddenMatcherHits(matcher, text, id) {
  if (!["traffic_or_road_status", "business_metric_prediction", "dark_sky_guarantee"].includes(id)) return matcher.test(text);
  return splitSentences(text).some((sentence) => matcher.test(sentence) && !isCaveatedSentence(sentence));
}

function inferForbiddenFromFallback(fallback) {
  const text = [
    fallback?.answerType,
    fallback?.persona,
    fallback?.capabilityNote,
    fallback?.guardrailNote,
    ...(Array.isArray(fallback?.missingData) ? fallback.missingData : [])
  ]
    .join(" ")
    .toLowerCase();
  const ids = [];
  if (/delivery|courier|package|restaurant/.test(text)) ids.push("eta_or_delay_prediction", "traffic_or_road_status");
  if (/route|travel/.test(text)) ids.push("traffic_or_road_status", "official_safety_clearance");
  if (/stargaz|sky/.test(text)) ids.push("dark_sky_guarantee");
  if (/cooling|thermostat|hvac|a\/c|ac/.test(text)) ids.push("exact_setpoint", "outcome_guarantee");
  if (/business|sla|throughput|staffing|financial/.test(text)) ids.push("business_metric_prediction");
  return ids;
}

function unsupportedAssertionViolations(answer, fallback) {
  const missing = new Set([
    ...(Array.isArray(fallback?.missingData) ? fallback.missingData : []),
    ...(Array.isArray(fallback?.facts?.evidenceTable?.unavailable) ? fallback.facts.evidenceTable.unavailable : [])
  ].map((item) => humanize(item).toLowerCase()));
  const terms = unsupportedTerms.filter((term) => missing.has(term) || [...missing].some((item) => item.includes(term) || term.includes(item)));
  const sentences = splitSentences(answer);
  const violations = [];
  for (const term of terms) {
    const termRe = new RegExp(`\\b${escapeRegExp(term)}\\b`, "i");
    for (const sentence of sentences) {
      if (!termRe.test(sentence)) continue;
      if (isCaveatedSentence(sentence)) continue;
      violations.push({ type: "unsupported_assertion", id: term });
      break;
    }
  }
  return violations;
}

function numericGroundingViolations(answer, fallback) {
  const numbers = extractUnitNumbers(answer);
  if (!numbers.length) return [];
  const grounded = collectGroundedNumbers(fallback);
  const violations = [];
  for (const item of numbers) {
    const candidates = grounded[item.unit] ?? [];
    if (!candidates.length) continue;
    const tolerance = item.unit === "in" ? 0.06 : item.unit === "%" ? 4 : item.unit === "mph" ? 3 : item.unit === "CDD" ? 3 : 3;
    if (!candidates.some((value) => Math.abs(value - item.value) <= tolerance)) {
      violations.push({ type: "ungrounded_number", id: `${item.value}${item.unit}` });
    }
  }
  return violations.slice(0, 4);
}

function extractUnitNumbers(answer) {
  const items = [];
  const patterns = [
    { unit: "F", re: /\b(-?\d+(?:\.\d+)?)\s*(?:°\s*)?F\b/gi },
    { unit: "mph", re: /\b(-?\d+(?:\.\d+)?)\s*mph\b/gi },
    { unit: "in", re: /\b(-?\d+(?:\.\d+)?)\s*(?:in|inch|inches)\b/gi },
    { unit: "%", re: /\b(-?\d+(?:\.\d+)?)\s*%/g },
    { unit: "CDD", re: /\b(-?\d+(?:\.\d+)?)\s*CDD\b/gi }
  ];
  for (const pattern of patterns) {
    for (const match of answer.matchAll(pattern.re)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) items.push({ value, unit: pattern.unit });
    }
  }
  return items;
}

function collectGroundedNumbers(fallback) {
  const result = { F: [], mph: [], in: [], "%": [], CDD: [] };
  visitNumbers(fallback?.facts, (path, value) => {
    const key = path.join(".").toLowerCase();
    if (/temp|heat|apparent|lowf|highf|f$/.test(key)) result.F.push(value);
    if (/wind|mph/.test(key)) result.mph.push(value);
    if (/precip|rain|in$/.test(key)) result.in.push(value);
    if (/humidity|cloud|pct|percent/.test(key)) result["%"].push(value);
    if (/cdd|cooling_degree/.test(key)) result.CDD.push(value);
    if (/unit$/.test(key)) return;
  });
  visitEvidenceTable(fallback?.facts?.evidenceTable, result);
  return result;
}

function visitEvidenceTable(table, result) {
  if (!table || typeof table !== "object") return;
  for (const row of table.rows ?? []) {
    for (const [key, value] of Object.entries(row?.values ?? {})) {
      const n = Number(value?.v);
      if (!Number.isFinite(n)) continue;
      const unit = value?.unit;
      if (unit === "F") result.F.push(n);
      else if (unit === "mph") result.mph.push(n);
      else if (unit === "in") result.in.push(n);
      else if (unit === "%") result["%"].push(n);
      else if (unit === "CDD") result.CDD.push(n);
      else if (/temp|heat|apparent/.test(key)) result.F.push(n);
      else if (/wind/.test(key)) result.mph.push(n);
      else if (/precip/.test(key)) result.in.push(n);
      else if (/humidity|cloud/.test(key)) result["%"].push(n);
    }
  }
}

function visitNumbers(value, visitor, path = []) {
  if (Number.isFinite(value)) {
    visitor(path, Number(value));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitNumbers(item, visitor, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) visitNumbers(child, visitor, [...path, key]);
}

function verifierFallback(response, fallback, violations) {
  return {
    ...fallback,
    answer: fallback?.answer ?? response?.answer ?? "I could not verify that answer against the dashboard evidence, so I am falling back to the safer weather-only read.",
    dataUsed: [...new Set([...(fallback?.dataUsed ?? []), "Claim verifier fallback"])],
    guardrailNote: `${fallback?.guardrailNote ?? "Verified dashboard facts only."} Claim verifier blocked: ${violations.map((item) => item.id).slice(0, 3).join(", ")}.`,
    facts: {
      ...(fallback?.facts ?? {}),
      verifier: { ok: false, violations }
    }
  };
}

function isCaveatedSentence(sentence) {
  return /\b(?:not connected|not checking|cannot|can't|do not have|don't have|not available|missing|outside this dashboard|not inferred|not included)\b/i.test(sentence);
}

function splitSentences(text) {
  return String(text ?? "")
    .split(/(?<=[.?!])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function humanize(value) {
  return String(value ?? "").replace(/_/g, " ");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
