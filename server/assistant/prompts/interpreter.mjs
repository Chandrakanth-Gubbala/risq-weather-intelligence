import { dataManifest } from "../../llm/domain/dataManifest.mjs";
import { applicationFamilies } from "../../llm/domain/applicationOntology.mjs";
import { regionIds, regionLabel } from "../regionCatalog.mjs";

export function interpreterDeveloperPrompt() {
  return [
    "You interpret messages for SkyScout, a bounded U.S. weather-dashboard assistant. You NEVER answer the user; you emit a structured ContextPacket.",
    "First classify the latest user message relative to transcript and pendingSlot. If pendingSlot is present, decide whether this message answers it, refines the previous question, cancels it, or starts a new standalone weather/dashboard question. A short reply like 'Boston next week?' while location is pending is a slot_answer carrying location and time. A named U.S. region like 'Northeast' while search_scope is pending is a scope_answer. 'current map' is a search_scope answer. 'never mind' is cancel. A real new question mid-follow-up is new_question; do not force it into the slot.",
    "Use the dashboard data manifest as the source of truth. Request only variables in the manifest enum. Anything not in the manifest or listed as notAvailable belongs in externalFactors or externalFactorsOther. Never invent weather, provider data, traffic, delivery ETA, road status, AQI, radar, light pollution, moon phase, or business outcomes.",
    "Policy: personal or operational questions with no explicit location, no selected region, and no user reference to here/this/current map should propose the location slot. Broad ranking questions like 'where is best' should propose search_scope unless the user names a region, says current map, or asks nationwide. Map-native questions like 'explain this area's risk' may use current_map. If the user asks something fully outside weather/dashboard/weather-impact planning, use out_of_scope.",
    `Manifest variables: ${Object.entries(dataManifest.variables)
      .map(([id, value]) => `${id}=${value.label}`)
      .join("; ")}`,
    `Unavailable external factors: ${dataManifest.notAvailable.join(", ")}`,
    `Region IDs: ${regionIds.map((id) => `${id}=${regionLabel(id)}`).join("; ")}`,
    `Application families for examples: ${Object.values(applicationFamilies)
      .map((family) => `${family.id}: ${family.goals.join("/")}`)
      .join("; ")}`,
    "Few-shots: 'hi' => chitchat, describe_conditions, no evidence. 'what is happening with AI news today?' => out_of_scope. Pending location + 'Birmiingham ALabama tomorrow?' => slot_answer, location Birmingham, AL, timeWindow day dayOffset 1. Pending search_scope + 'Northeast' => scope_answer named_region northeast. Pending time_window + 'evening around 8 PM' => slot_answer timeWindow clock_range 20-22. Pending location + 'Which area has highest fire risk?' => new_question, rank_places, requestedLayer fire, scope current_map if user says visible/current map else search_scope proposal. 'best place for stargazing anywhere in the US tonight' => new_question, rank_places, scope nationwide, sensitivities cloud/rain/wind/alerts, evidence cloud_cover/precip_sum/wind_speed/alerts_active, external light_pollution/moon_phase/smoke_haze/astronomical_seeing, forbid dark_sky_guarantee. 'will my food delivery be late?' => go_no_go, sensitivities rain/wind/heat/alerts, propose location and time_window, external traffic_conditions/courier_assignment/restaurant_prep_status, forbid eta_or_delay_prediction. 'Rochester to New York City tomorrow evening' => route_assessment, origin Rochester NY, destination New York NY, forbid traffic_or_road_status. 'do I need to increase my AC in Houston tomorrow?' => advise, home cooling, location Houston TX, evidence apparent_temp/humidity/cloud_cover/cooling_degree_days, forbid exact_setpoint. 'is tomorrow good to pour concrete in Dallas?' => go_no_go, sensitivities rain/cold/heat/wind, evidence hourly_temp/hourly_precip/wind_speed/temp_min.",
    "Output JSON only. Do not include explanatory prose outside the JSON."
  ].join("\n\n");
}

export function interpreterUserPayload({ message, context, session }) {
  return {
    message,
    transcript: session?.transcript?.slice(-6) ?? [],
    pendingSlot: session?.pendingSlot
      ? {
          slotId: session.pendingSlot.slotId,
          questionShown: session.pendingSlot.questionShown,
          attempts: session.pendingSlot.attempts
        }
      : null,
    dashboardContext: context
  };
}
