import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

const SkyScoutState = Annotation.Root({
  message: Annotation({ reducer: (_left, right) => right, default: () => "" }),
  context: Annotation({ reducer: (_left, right) => right, default: () => ({}) }),
  session: Annotation({ reducer: (_left, right) => right, default: () => null }),
  contextPacket: Annotation({ reducer: (_left, right) => right, default: () => null }),
  plannerPlan: Annotation({ reducer: (_left, right) => right, default: () => null }),
  capability: Annotation({ reducer: (_left, right) => right, default: () => null }),
  evidenceTable: Annotation({ reducer: (_left, right) => right, default: () => null }),
  advisory: Annotation({ reducer: (_left, right) => right, default: () => null }),
  finalResponse: Annotation({ reducer: (_left, right) => right, default: () => null }),
  route: Annotation({ reducer: (_left, right) => right, default: () => null }),
  trace: Annotation({ reducer: (_left, right) => right, default: () => [] })
});

const nodeDescriptions = [
  ["receive_request", "Validate /api/chat input, start or resume the SkyScout session, and open a trace."],
  ["fast_path_gate", "Short-circuit simple greetings and alert-term explanations before invoking the planner."],
  ["greeting_response", "Return SkyScout's warm intro response and clear stale pending slots."],
  ["alert_glossary_response", "Explain weather alert language from the local glossary when the user asks what an alert means."],
  ["context_interpreter", "Use the OpenAI structured interpreter when available, with deterministic local fallback, to produce a ContextPacket."],
  ["planner_adapter", "Convert and verify the ContextPacket into the older internal planner shape used by the current server route."],
  ["session_memory_merge", "Merge slot answers or refinements with the stored plan, then clear satisfied pending slots."],
  ["planner_guardrail_gate", "Route out-of-domain, cancel, and missing-slot states before fetching weather evidence."],
  ["out_of_scope_response", "Return a weather-dashboard scope response without pretending to answer unrelated questions."],
  ["cancel_pending_response", "Clear pending SkyScout state when the user cancels or changes course."],
  ["followup_response", "Ask one typed follow-up question using fixed templates for location, route endpoint, time, or search scope."],
  ["plan_execution_setup", "Store the validated plan, derive the application lens, interpretation, and capability verdict."],
  ["capability_gate", "Block unsafe or unsupported answers and allow partial weather-only answers with explicit missing data."],
  ["capability_response", "Return a guarded response for unsafe, out-of-domain, or unsupported-by-data requests."],
  ["layer_explanation_gate", "Answer dashboard-layer explanation questions directly from the active layer and map context."],
  ["layer_explanation_response", "Explain the selected map layer without invoking forecast retrieval."],
  ["evidence_scope_resolver", "Resolve whether evidence should be fetched for one location, a route, visible/ranked candidates, or a selected map point."],
  ["route_targets", "Resolve origin, destination, and optional midpoint targets for route weather questions."],
  ["ranking_targets", "Resolve visible, regional, statewide, or nationwide candidate locations for ranking questions."],
  ["single_location_target", "Resolve an explicit city, selected region, or map-center fallback for single-place advice."],
  ["fetch_forecast_evidence", "Fetch live forecast rows for resolved points through the provider layer and its fallbacks."],
  ["build_evidence_table", "Compute verified weather facts requested by the ContextPacket: heat, wind, rain, cloud, CDD, alerts, rankings, and windows."],
  ["deterministic_answer", "Render a safe deterministic answer from the evidence table. This is the fallback answer and verifier baseline."],
  ["llm_writer_gate", "Use OpenAI only when a key exists and the answer is not a follow-up; otherwise keep deterministic output."],
  ["llm_answer_writer", "Ask the final answer writer to humanize the response using only verified evidence and explicit boundaries."],
  ["claim_verifier", "Block unsupported claims, ungrounded numbers, exact setpoints, ETA promises, traffic claims, and unsafe guarantees."],
  ["legacy_specialized_fallback", "Compatibility path for old route/ranking/single-location handlers when the evidence-table path cannot resolve enough data."],
  ["finalize_session_response", "Append the response to session memory, return conversationState, and close the trace."]
];

const noop = async (state) => ({ trace: [...(state.trace ?? []), "visited"] });

function pickRoute(state, fallback) {
  return typeof state.route === "string" ? state.route : fallback;
}

export function createSkyScoutLangGraph() {
  return new StateGraph(SkyScoutState)
    .addNode("receive_request", noop)
    .addNode("fast_path_gate", noop)
    .addNode("greeting_response", noop)
    .addNode("alert_glossary_response", noop)
    .addNode("context_interpreter", noop)
    .addNode("planner_adapter", noop)
    .addNode("session_memory_merge", noop)
    .addNode("planner_guardrail_gate", noop)
    .addNode("out_of_scope_response", noop)
    .addNode("cancel_pending_response", noop)
    .addNode("followup_response", noop)
    .addNode("plan_execution_setup", noop)
    .addNode("capability_gate", noop)
    .addNode("capability_response", noop)
    .addNode("layer_explanation_gate", noop)
    .addNode("layer_explanation_response", noop)
    .addNode("evidence_scope_resolver", noop)
    .addNode("route_targets", noop)
    .addNode("ranking_targets", noop)
    .addNode("single_location_target", noop)
    .addNode("fetch_forecast_evidence", noop)
    .addNode("build_evidence_table", noop)
    .addNode("deterministic_answer", noop)
    .addNode("llm_writer_gate", noop)
    .addNode("llm_answer_writer", noop)
    .addNode("claim_verifier", noop)
    .addNode("legacy_specialized_fallback", noop)
    .addNode("finalize_session_response", noop)
    .addEdge(START, "receive_request")
    .addEdge("receive_request", "fast_path_gate")
    .addConditionalEdges("fast_path_gate", (state) => pickRoute(state, "context_interpreter"), {
      greeting_response: "greeting_response",
      alert_glossary_response: "alert_glossary_response",
      context_interpreter: "context_interpreter"
    })
    .addEdge("greeting_response", "finalize_session_response")
    .addEdge("alert_glossary_response", "finalize_session_response")
    .addEdge("context_interpreter", "planner_adapter")
    .addEdge("planner_adapter", "session_memory_merge")
    .addEdge("session_memory_merge", "planner_guardrail_gate")
    .addConditionalEdges("planner_guardrail_gate", (state) => pickRoute(state, "plan_execution_setup"), {
      out_of_scope_response: "out_of_scope_response",
      cancel_pending_response: "cancel_pending_response",
      followup_response: "followup_response",
      plan_execution_setup: "plan_execution_setup"
    })
    .addEdge("out_of_scope_response", "finalize_session_response")
    .addEdge("cancel_pending_response", "finalize_session_response")
    .addEdge("followup_response", "finalize_session_response")
    .addEdge("plan_execution_setup", "capability_gate")
    .addConditionalEdges("capability_gate", (state) => pickRoute(state, "layer_explanation_gate"), {
      capability_response: "capability_response",
      layer_explanation_gate: "layer_explanation_gate"
    })
    .addEdge("capability_response", "finalize_session_response")
    .addConditionalEdges("layer_explanation_gate", (state) => pickRoute(state, "evidence_scope_resolver"), {
      layer_explanation_response: "layer_explanation_response",
      evidence_scope_resolver: "evidence_scope_resolver"
    })
    .addEdge("layer_explanation_response", "finalize_session_response")
    .addConditionalEdges("evidence_scope_resolver", (state) => pickRoute(state, "single_location_target"), {
      route_targets: "route_targets",
      ranking_targets: "ranking_targets",
      single_location_target: "single_location_target",
      legacy_specialized_fallback: "legacy_specialized_fallback"
    })
    .addEdge("route_targets", "fetch_forecast_evidence")
    .addEdge("ranking_targets", "fetch_forecast_evidence")
    .addEdge("single_location_target", "fetch_forecast_evidence")
    .addEdge("fetch_forecast_evidence", "build_evidence_table")
    .addConditionalEdges("build_evidence_table", (state) => pickRoute(state, "deterministic_answer"), {
      deterministic_answer: "deterministic_answer",
      legacy_specialized_fallback: "legacy_specialized_fallback"
    })
    .addEdge("deterministic_answer", "llm_writer_gate")
    .addConditionalEdges("llm_writer_gate", (state) => pickRoute(state, "claim_verifier"), {
      llm_answer_writer: "llm_answer_writer",
      claim_verifier: "claim_verifier"
    })
    .addEdge("llm_answer_writer", "claim_verifier")
    .addEdge("claim_verifier", "finalize_session_response")
    .addEdge("legacy_specialized_fallback", "finalize_session_response")
    .addEdge("finalize_session_response", END)
    .compile();
}

export function skyScoutLangGraphMermaid() {
  return createSkyScoutLangGraph().getGraph().drawMermaid();
}

export function skyScoutGraphNodeDescriptions() {
  return nodeDescriptions.map(([id, description]) => ({ id, description }));
}
