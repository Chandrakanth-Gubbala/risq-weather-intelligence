import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { interpretContextPacket, verifyContextPacket } from "../interpreter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, "interpreter.golden.json");
const cases = JSON.parse(await readFile(goldenPath, "utf8"));

test("interpreter golden cases", async () => {
  let checkedFields = 0;
  let correctFields = 0;
  for (const item of cases) {
    const packet = await interpretContextPacket(item.message, {
      forceLocal: true,
      context: assistantContext(),
      session: item.pendingSlot ? fakeSession(item.pendingSlot) : null
    });
    const result = checkExpected(item.expected, packet);
    checkedFields += result.checked;
    correctFields += result.correct;
    assert.deepEqual(result.failures, [], `${item.name}: ${result.failures.join("; ")}`);
  }
  assert.ok(correctFields / checkedFields >= 0.9, `expected >=90% golden accuracy, got ${correctFields}/${checkedFields}`);
});

test("interpreter verifier repairs LLM-missed delivery time from deterministic fallback", () => {
  const raw = basePacket({
    activity: "food delivery",
    decisionType: "go_no_go",
    locations: [{ raw: "Boston", normalized: "Boston, MA", role: "single" }],
    timeWindow: { kind: "clock_range", dayOffset: 0, days: 1, daypart: "evening", startHour: 20, endHour: 22 },
    slotProposals: ["time_window"]
  });
  const fallback = basePacket({
    activity: "food delivery",
    decisionType: "go_no_go",
    locations: [{ raw: "Boston", normalized: "Boston, MA", role: "single" }],
    timeWindow: { kind: "clock_range", dayOffset: 0, days: 1, daypart: "evening", startHour: 19, endHour: 21 },
    slotProposals: []
  });
  const packet = verifyContextPacket(raw, { message: "Will my food delivery in Boston be late around 8 PM?", fallback, context: assistantContext() });
  assert.equal(packet.timeWindow.kind, "clock_range");
  assert.equal(packet.timeWindow.startHour, 19);
  assert.equal(packet.timeWindow.endHour, 21);
  assert.ok(!packet.slotProposals.includes("time_window"));
});

test("interpreter verifier repairs nationwide scope from deterministic fallback", () => {
  const raw = basePacket({
    activity: "stargazing",
    decisionType: "rank_places",
    scope: { kind: "unresolved", regionId: null, stateCode: null },
    slotProposals: ["search_scope"]
  });
  const fallback = basePacket({
    activity: "stargazing",
    decisionType: "rank_places",
    scope: { kind: "nationwide", regionId: "nationwide", stateCode: null },
    timeWindow: { kind: "daypart", dayOffset: 0, days: 1, daypart: "evening", startHour: 18, endHour: 24 },
    slotProposals: []
  });
  const packet = verifyContextPacket(raw, { message: "Best place for stargazing anywhere in the US tonight", fallback, context: assistantContext() });
  assert.equal(packet.scope.kind, "nationwide");
  assert.equal(packet.scope.regionId, "nationwide");
  assert.ok(!packet.slotProposals.includes("search_scope"));
});

function checkExpected(expected, packet) {
  const failures = [];
  const checks = [];
  const add = (name, actual, predicate) => checks.push({ name, actual, ok: predicate(actual) });
  if (expected.turnType) add("turnType", packet.turnType, (value) => value === expected.turnType);
  if (expected.decisionType) add("decisionType", packet.application.decisionType, (value) => value === expected.decisionType);
  if (expected.scopeKind) add("scope.kind", packet.scope.kind, (value) => value === expected.scopeKind);
  if (expected.regionId) add("scope.regionId", packet.scope.regionId, (value) => value === expected.regionId);
  if (expected.requestedLayer) add("requestedLayer", packet.requestedLayer, (value) => value === expected.requestedLayer);
  if (expected.slotAnswerSlotId) add("slotAnswer.slotId", packet.slotAnswer?.slotId, (value) => value === expected.slotAnswerSlotId);
  if (expected.timeKind) add("timeWindow.kind", packet.slotAnswer?.timeWindow?.kind ?? packet.timeWindow.kind, (value) => value === expected.timeKind);
  if (expected.locationIncludes) {
    const locations = [...packet.locations.map((loc) => loc.normalized), packet.slotAnswer?.location?.normalized].filter(Boolean).join(" | ");
    add("locations", locations, (value) => value.includes(expected.locationIncludes));
  }
  if (expected.locationsAtLeast) add("locations.length", packet.locations.length, (value) => value >= expected.locationsAtLeast);
  if (expected.evidenceIncludes) {
    const variables = packet.evidenceRequests.map((request) => request.variable);
    for (const variable of expected.evidenceIncludes) add(`evidence ${variable}`, variables, (value) => value.includes(variable));
  }
  if (expected.externalIncludes) {
    for (const factor of expected.externalIncludes) add(`external ${factor}`, packet.externalFactors, (value) => value.includes(factor));
  }
  if (expected.forbiddenIncludes) {
    for (const claim of expected.forbiddenIncludes) add(`forbidden ${claim}`, packet.claimFrame.forbiddenClaims, (value) => value.includes(claim));
  }
  if (expected.slotProposalsIncludes) {
    for (const slot of expected.slotProposalsIncludes) add(`slot ${slot}`, packet.slotProposals, (value) => value.includes(slot));
  }
  for (const check of checks) {
    if (!check.ok) failures.push(`${check.name} was ${JSON.stringify(check.actual)}`);
  }
  return {
    checked: checks.length,
    correct: checks.filter((check) => check.ok).length,
    failures
  };
}

function fakeSession(slotId) {
  return {
    id: "golden-session",
    turnCounter: 2,
    transcript: [],
    pendingSlot: {
      slotId,
      planId: "golden-plan",
      questionShown: "What missing detail should I use?",
      createdTurn: 1,
      attempts: 1
    },
    entities: { locations: [], lastScope: null, lastTimeWindow: null, lastApplication: null }
  };
}

function assistantContext() {
  return {
    map: { center: { lat: 39.5, lon: -98.35 }, zoom: 4 },
    activeLayer: "risk",
    selected: null,
    visiblePoints: [
      { name: "Houston", state: "TX", lat: 29.7604, lon: -95.3698, score: 46, layers: { risk: 46, fire: 30, heat: 101, temp: 95, wind: 12, humidity: 78, cloud: 38, cdd: 32 } },
      { name: "Dallas", state: "TX", lat: 32.7767, lon: -96.797, score: 62, layers: { risk: 62, fire: 55, heat: 102, temp: 98, wind: 16, humidity: 61, cloud: 14, cdd: 38 } },
      { name: "Phoenix", state: "AZ", lat: 33.4484, lon: -112.074, score: 88, layers: { risk: 88, fire: 80, heat: 107, temp: 109, wind: 13, humidity: 18, cloud: 4, cdd: 50 } }
    ],
    alerts: []
  };
}

function basePacket(overrides = {}) {
  return {
    turnType: "new_question",
    slotAnswer: null,
    application: {
      activity: overrides.activity ?? "weather question",
      decisionType: overrides.decisionType ?? "describe_conditions",
      sensitivities: ["rain", "wind", "heat", "alerts"],
      audienceFlags: ["none"]
    },
    scope: overrides.scope ?? { kind: "unresolved", regionId: null, stateCode: null },
    locations: overrides.locations ?? [],
    timeWindow: overrides.timeWindow ?? { kind: "none", dayOffset: null, days: null, daypart: null, startHour: null, endHour: null },
    evidenceRequests: overrides.evidenceRequests ?? [],
    externalFactors: overrides.externalFactors ?? [],
    externalFactorsOther: [],
    slotProposals: overrides.slotProposals ?? [],
    claimFrame: { allowedClaimLevel: "weather_conditions", forbiddenClaims: [] },
    requestedLayer: null,
    confidence: "medium",
    userReferencedMapContext: false
  };
}
