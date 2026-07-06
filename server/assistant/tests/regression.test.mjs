import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const fixturePath = join(here, "fixtures", "forecasts.json");
const port = Number(process.env.RISQ_TEST_PORT || 5311);
const baseUrl = `http://127.0.0.1:${port}`;

let server;

test.before(async () => {
  server = spawn(process.execPath, ["server/index.mjs", "--prod"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      RISQ_FORECAST_FIXTURE_PATH: fixturePath,
      OPENAI_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForHealth();
});

test.after(async () => {
  if (!server) return;
  server.kill();
  await once(server, "exit").catch(() => {});
});

test("REG-1: regional search scope should not fall through to city/state ask", async () => {
  let state = null;
  const first = await chat("Find me a good outdoor window", state);
  state = first.conversationState;
  assert.equal(first.answerType, "needs_followup");
  assertNoPlannerLeak(first.answer);

  const second = await chat("Northeast", state);
  assert.notEqual(second.answerType, "needs_followup");
  const namedCities = cityMentions(second.answer);
  assert.ok(second.bestWindows.length >= 3 || namedCities.length >= 3, "expected at least three ranked windows or Northeast city mentions");
  assert.ok(!/city\/state|city and state/i.test(second.answer), "should not ask for city/state after Northeast scope answer");
});

test("REG-2: slot answer with question mark should not loop, then topic switch should clear stale state", async () => {
  let state = null;
  const first = await chat("Will my food delivery be delayed?", state);
  state = first.conversationState;
  assert.equal(first.answerType, "needs_followup");
  assert.match(first.answer, /location|city|time|window/i);

  const second = await chat("Boston next week?", state);
  state = second.conversationState;
  assert.ok(!/what city|city, state|location before/i.test(second.answer), "should not re-ask for location");

  const third = await chat("Boston next week?", state);
  assert.ok(!/what city|city, state|location before/i.test(third.answer), "should not loop on the same slot answer");

  const fourth = await chat("Which area has the highest fire risk?", state);
  assert.ok(!/delivery|courier|package|food/i.test(fourth.answer), "new fire-risk question should not keep delivery language");
});

test("REG-3: hostile stored pendingFacts must never leak into follow-up copy", async () => {
  const injected = "The user did not specify a location for this request";
  const response = await chat("hello again", {
    plannerPlan: {
      domain: "weather_related",
      goal: "Hostile stale state",
      lens: "outdoor_work",
      activity: "outdoor work",
      retrievalMode: "ask_followup",
      shouldGeocode: false,
      geocodeQueries: [],
      locations: [],
      timeWindow: { type: "range", value: "default_next_4d" },
      requiredFacts: [],
      pendingFacts: [injected],
      safetyFlags: [],
      expectedAnswerMode: "ask_followup"
    },
    pendingFacts: [injected]
  });
  assert.ok(!response.answer.includes(injected), "follow-up text leaked stored planner prose");
  assertNoPlannerLeak(response.answer);
});

test("REG-4: nationwide stargazing ranks catalog anchors and names weather-only limits", async () => {
  const response = await chat("best place for stargazing anywhere in the US tonight");
  assert.notEqual(response.answerType, "needs_followup");
  assert.ok(response.bestWindows.length >= 3, "expected at least three ranked stargazing candidates");
  assert.match(response.answer, /Across the U\.S\.|Across the US|light pollution|moon phase/i);
  assert.ok(response.missingData.some((item) => /light|moon|smoke|seeing/i.test(String(item))), "expected astronomy-specific missing data");
});

test("REG-5: visible-area fire ranking still uses current map candidates", async () => {
  const response = await chat("which visible area has the highest fire risk?");
  assert.notEqual(response.answerType, "needs_followup");
  assert.match(response.answer, /current map view|visible/i);
  assert.ok(/Houston|Dallas|Phoenix/.test(response.answer), "expected a visible-map city in the answer");
});

async function chat(message, conversationState = null) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, context: assistantContext(), conversationState })
  });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  const payload = JSON.parse(raw);
  assert.equal(payload.ok, true);
  return payload.data;
}

function assistantContext() {
  return {
    map: { center: { lat: 39.5, lon: -98.35 }, zoom: 4 },
    activeLayer: "risk",
    timeline: { mode: "daily", timeIdx: null },
    visiblePoints: [
      { name: "Houston", state: "TX", lat: 29.7604, lon: -95.3698, score: 46, layers: { risk: 46, fire: 30, heat: 101, temp: 95, wind: 12, humidity: 78, cloud: 38, cdd: 32 } },
      { name: "Dallas", state: "TX", lat: 32.7767, lon: -96.797, score: 62, layers: { risk: 62, fire: 55, heat: 102, temp: 98, wind: 16, humidity: 61, cloud: 14, cdd: 38 } },
      { name: "Phoenix", state: "AZ", lat: 33.4484, lon: -112.074, score: 88, layers: { risk: 88, fire: 80, heat: 107, temp: 109, wind: 13, humidity: 18, cloud: 4, cdd: 50 } }
    ],
    alerts: []
  };
}

async function waitForHealth() {
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("test server did not become healthy");
}

function assertNoPlannerLeak(text) {
  assert.ok(!/_/.test(text), "follow-up text should not contain enum underscores");
  assert.ok(!/The user did not|planner|pendingFacts|slotId/i.test(text), "follow-up text should not expose planner phrasing");
}

function cityMentions(text) {
  const states = new Set(["ME", "NH", "VT", "MA", "RI", "CT", "NY", "NJ", "PA"]);
  return [...String(text).matchAll(/\b([A-Z][A-Za-z .'-]+),\s*(ME|NH|VT|MA|RI|CT|NY|NJ|PA)\b/g)]
    .filter((match) => states.has(match[2]))
    .map((match) => `${match[1]}, ${match[2]}`);
}
