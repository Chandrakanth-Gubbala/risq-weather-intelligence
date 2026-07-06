import assert from "node:assert/strict";
import test from "node:test";
import { verifyAssistantClaims } from "../verifier.mjs";

const fallback = {
  answer: "Weather-related delivery risk looks low, but actual delivery status is not connected.",
  verdict: "good",
  confidence: "medium",
  bestWindows: [],
  risks: ["No major weather signal."],
  dataUsed: ["Evidence table"],
  guardrailNote: "Weather-only.",
  actions: [],
  answerType: "in_scope_partial_business",
  persona: "Logistics / last-mile operations",
  capabilityNote: "Weather-related risk only.",
  missingData: ["traffic_conditions", "courier_assignment", "package_tracking_status"],
  facts: {
    evidenceTable: {
      rows: [{ values: { "hourly_wind.max": { v: 12, unit: "mph" }, "hourly_precip.sum": { v: 0.01, unit: "in" } } }],
      unavailable: ["traffic_conditions", "courier_assignment", "package_tracking_status"]
    }
  }
};

test("claim verifier blocks actual delivery outcome claims", () => {
  const response = { ...fallback, answer: "Your package will definitely arrive on time because weather looks fine." };
  const verified = verifyAssistantClaims(response, fallback, {
    interpretation: { forbiddenClaims: ["eta_or_delay_prediction"] },
    evidence: {}
  });
  assert.equal(verified.ok, false);
  assert.equal(verified.response.answer, fallback.answer);
});

test("claim verifier allows caveated missing external data", () => {
  const response = {
    ...fallback,
    answer: "Weather risk looks low. I cannot see traffic or package tracking, so this is not an actual delivery prediction."
  };
  const verified = verifyAssistantClaims(response, fallback, {
    interpretation: { forbiddenClaims: ["eta_or_delay_prediction", "traffic_or_road_status"] },
    evidence: {}
  });
  assert.equal(verified.ok, true);
});

test("claim verifier blocks exact thermostat setpoints", () => {
  const coolingFallback = {
    ...fallback,
    answer: "Cooling demand looks elevated, but exact thermostat settings are not connected.",
    persona: "Home cooling",
    missingData: ["HVAC performance", "utility bill"],
    facts: { evidenceTable: { rows: [{ values: { "apparent_temp.max": { v: 96, unit: "F" } } }] } }
  };
  const response = { ...coolingFallback, answer: "Set your thermostat to 74F tomorrow and your house will be fine." };
  const verified = verifyAssistantClaims(response, coolingFallback, {
    interpretation: { forbiddenClaims: ["exact_setpoint", "outcome_guarantee"] },
    evidence: {}
  });
  assert.equal(verified.ok, false);
  assert.equal(verified.response.answer, coolingFallback.answer);
});
