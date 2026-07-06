# Assistant Rebuild Log

## Phase 0 - Hygiene, Tracing, Failing Tests

Date: 2026-07-06

### Changed
- Removed unreachable legacy planner/interpreter wrappers from `server/index.mjs`:
  - `planAssistantQuestion`
  - `planAssistantQuestionLocally`
  - `callOpenAiUnifiedPlanner`
  - `unifiedPlannerSchema`
  - `sanitizeUnifiedPlan`
  - `reasonAboutApplication`
  - `callOpenAiApplicationReasoner`
  - `applicationReasoningSchema`
  - `sanitizeApplicationReasoning`
  - `applyApplicationReasoning`
  - `interpretAssistantQuestion`
  - `callOpenAiQuestionInterpreter`
  - `questionInterpretationSchema`
  - `interpretQuestionLocally`
  - `sanitizeQuestionInterpretation`
- Kept reachable helpers still used by the live path:
  - `reasonAboutApplicationLocally`
  - `enrichApplicationWithOntology`
  - `conversationalResponse`
- Added `server/assistant/trace.mjs` for one structured JSON trace per `/api/chat` turn.
- Added local-only `GET /api/debug/traces` when `NODE_ENV !== "production"`.
- Added `RISQ_FORECAST_FIXTURE_PATH` test hook for mocked forecast data.
- Added assistant regression test harness:
  - `server/assistant/tests/regression.test.mjs`
  - `server/assistant/tests/fixtures/forecasts.json`
- Added `npm run test:assistant`.

### Test Results
- `npm run build`: passing.
- `npm run test:assistant`: expected failing baseline.
  - REG-1 fails because `Find me a good outdoor window` answers from current map context instead of asking for/using a typed search scope.
  - REG-2 fails because `Boston next week?` still re-asks for location in a pending delivery flow.
  - REG-3 passes because previous guardrails already prevent hostile pending planner prose from leaking into the user-facing follow-up.

### Deviations
- The full physical split of `server/index.mjs` into `server/http.mjs`, `server/providers/*`, and `server/assistant/index.mjs` is not completed yet. The first Phase 0 slice focused on safe dead-code removal, tracing, and regression harness setup before larger file movement.

## Phase 1 - Server Sessions, Typed Slots, Fixed Follow-Ups

Date: 2026-07-06

### Changed
- Added `server/assistant/session.mjs`:
  - server-side in-memory sessions
  - 500-session LRU cap
  - 2-hour idle TTL
  - transcript storage capped to the last 6 messages
  - pending-slot TTL at turn start
- Added `server/assistant/followupTemplates.mjs` with exactly five user-facing slot templates:
  - `location`
  - `origin`
  - `destination`
  - `time_window`
  - `search_scope`
- Added `server/assistant/slots.mjs` for deterministic pending-slot classification and typed slot merges.
- Changed `/api/chat` so the frontend receives only opaque `conversationState: { sessionId }`.
- Kept accepting legacy full-state blobs by ignoring their stored plan if no `sessionId` is present.
- Updated `src/types.ts` so `AssistantConversationState` is an opaque session object.
- Extended the live planner schema with:
  - `turnType`
  - typed `slotAnswer`
  - nullable typed `scope`
  - enum-only `pendingFacts`
- Replaced user-facing planner follow-up copy with fixed templates only.
- Wired delivery-time follow-ups into the ordinary `time_window` session slot.

### Deleted / Retired From Live Flow
- Removed the old live dependency on browser-carried `plannerPlan` state.
- Removed the old live dependency on `pendingSlot === "delivery_time_window"`.
- Removed old live pending-plan merge behavior from `planWeatherDashboardRequest`.

### Still Present But Not Live-Critical
- Some legacy helper functions remain in `server/http.mjs` during the staged migration:
  - `mergePlannerFollowup`
  - `continuePlannerPlan`
  - `isPlannerContinuationMessage`
  - `canonicalPendingFact`
  - `handleDeliveryTimeFollowup`
- They are not the primary `/api/chat` pending-slot path after Phase 1; they should be removed during the Phase 3 single-interpreter cutover.

### Test Results
- `npm run test:assistant`: passing.
- `npm run build`: passing.

## Phase 2 - Region Catalog and Typed Scope Ranking

Date: 2026-07-06

### Changed
- Added `server/assistant/regionCatalog.mjs` with typed region IDs and curated anchor cities.
- Added planner `scope.regionId` schema enum generated from the region catalog keys.
- Added scope resolution for ranking questions:
  - current map
  - selected region
  - named region
  - named state when anchors exist
  - nationwide
- Updated stargazing ranking to use the resolved scope instead of only `context.visiblePoints`.
- Updated general ranking to use resolved scope while preserving visible-map behavior for explicit visible/current-map requests.
- Added regression coverage:
  - REG-4 nationwide stargazing ranks catalog anchors and names missing astronomy-specific data.
  - REG-5 visible-area fire ranking still uses current-map candidates.

### Test Results
- `npm run test:assistant`: passing, 5/5 tests.
- `npm run build`: passing.

## Phase 3 - Single ContextPacket Interpreter

Date: 2026-07-06

### Changed
- Added `server/assistant/schemas/contextPacket.mjs`.
  - ContextPacket schema is generated from the dashboard `dataManifest` variable IDs.
  - External-factor enum is generated from `dataManifest.notAvailable`.
  - Scope region IDs are generated from `regionCatalog`.
- Added `server/assistant/prompts/interpreter.mjs`.
  - Single structured interpreter prompt.
  - Includes turn-classification rules, data-manifest policy, region list, application-family examples, and few-shot examples.
- Added `server/assistant/localInterpreter.mjs`.
  - Deterministic degraded interpreter for no-key mode.
  - Handles greetings, out-of-scope checks, typed pending-slot answers, scope answers, route travel, delivery, stargazing, clothing, home cooling, exterior work, concrete work, dashboard explanation, and general weather questions.
- Added `server/assistant/interpreter.mjs`.
  - Uses OpenAI Responses API with strict JSON schema when `OPENAI_API_KEY` is present.
  - Falls back to the local interpreter when no key is visible or the LLM call fails.
  - Verifies and clamps all ContextPacket fields after model output.
- Added `server/assistant/packetAdapter.mjs`.
  - Converts ContextPacket into the existing execution-plan shape so the stable weather handlers can continue to run while the orchestration layer is replaced.
- Cut `/api/chat` over to the single ContextPacket interpreter path.
  - The live path no longer calls `normalizeAssistantQuery` or `planWeatherDashboardRequest`.
  - Existing handlers are retained as the execution layer for this phase.
- Added `server/assistant/tests/interpreter.golden.json` with 25 structured golden cases.
- Added `server/assistant/tests/interpreter.test.mjs`.
  - Asserts structured fields, not exact prose.
  - Covers typos, slot answers, scope answers, topic switches, out-of-scope, route travel, delivery, home cooling, clothing, exterior repairs, concrete work, dashboard explanation, stargazing, and broad/current-map rankings.

### Deleted / Retired From Live Flow
- `normalizeAssistantQuery` is no longer called from `/api/chat`.
- `planWeatherDashboardRequest` is no longer called from `/api/chat`.
- Old regex pending-slot pre-classification is no longer called from `/api/chat`.

### Still Present But Not Removed Yet
- Legacy normalizer/planner functions remain in `server/http.mjs` as dead migration code.
- Full physical split into `server/assistant/index.mjs` and provider modules remains future cleanup.

### Test Results
- `npm run test:assistant`: passing, 6/6 tests.
- `npm run build`: passing.
- The Codex shell did not have `OPENAI_API_KEY` visible during verification, so automated tests exercised local deterministic interpreter mode.

## Phase 4 - Shared Evidence Executor, Claim Verifier, Cleanup

Date: 2026-07-06

### Changed
- Expanded `server/assistant/evidence.mjs` into the shared EvidenceTable executor.
  - Supports single-location weather summaries.
  - Supports `go_no_go`, `advise`, and `describe_conditions`.
  - Supports route weather with origin, destination, and optional midpoint evidence.
  - Supports place ranking and broad search scopes such as current map, named regions, states, and nationwide anchors.
  - Supports stargazing from cloud cover, rain, wind, and alerts while naming missing astronomy factors.
  - Supports delivery weather-risk windows while refusing actual ETA/delay claims.
  - Supports clothing and home-cooling guidance from forecast evidence.
  - Computes daily/hourly variables against the requested ContextPacket time window.
  - Carries unavailable external factors into `missingData` instead of guessing.
- Moved the live `/api/chat` execution order so ContextPacket evidence runs before the older specialized handlers.
  - The old route/ranking/delivery handlers remain as fallback compatibility paths.
  - The primary path now builds a ContextPacket -> EvidenceTable -> deterministic advisory -> optional LLM-written answer.
- Added `server/assistant/verifier.mjs`.
  - Verifies LLM-written responses after schema sanitization.
  - Blocks actual delivery outcome claims, exact thermostat setpoints, traffic/road-status claims, dark-sky guarantees, business metric predictions, official safety clearance, and unsupported numeric claims.
  - Allows honest caveats such as "traffic is not connected."
  - Falls back to the deterministic evidence answer when a generated answer violates guardrails.
- Added `server/assistant/tests/verifier.test.mjs`.
  - Covers delivery outcome blocking.
  - Covers allowed caveats for missing traffic/tracking data.
  - Covers exact thermostat setpoint blocking.
- Removed 39 dead legacy functions from `server/http.mjs`, including the old semantic normalizer and old dashboard planner families:
  - `normalizeAssistantQuery`
  - `callOpenAiSemanticNormalizer`
  - `planWeatherDashboardRequest`
  - `callOpenAiDashboardPlanner`
  - old browser-state follow-up helpers
  - old dead pending-plan merge helpers

### Scope
- Phase 4 now makes the evidence table the main execution layer for the major application families discussed so far.
- Some older specialized weather-formatting helpers remain because they are still useful fallback paths and utility functions.
- Full provider-module extraction from `server/http.mjs` remains future cleanup.

### Test Results
- `npm run test:assistant`: passing, 9/9 tests.
- `npm run build`: passing.

### Follow-Up Acceptance Fixes
- Ran an 11-prompt local SkyScout acceptance suite against `/api/chat`.
- Fixed two LLM-interpreter reconciliation misses:
  - Direct delivery questions with an explicit time such as "around 8 PM" no longer ask for time and preserve the exact clock window.
  - Broad ranking/search questions such as "Best place for stargazing anywhere in the US tonight" no longer ask for scope when the user already supplied a nationwide scope.
- Added deterministic reconciliation tests for both cases.
- Added Open-Meteo daily `apparent_temperature_max` and `cloud_cover_mean` to improve heat, clothing, home cooling, route, and stargazing evidence.
- Treated zero active alerts as valid alert evidence instead of missing data.
- Removed user-facing "LLM response unavailable" fallback text from the primary evidence path.
- Latest verification:
  - `npm run test:assistant`: passing, 11/11 tests.
  - `npm run build`: passing.
  - Final local smoke check: "Will my food delivery in Boston be late around 8 PM?" answers with `today around 8 PM` and keeps the delivery caveat weather-only.
