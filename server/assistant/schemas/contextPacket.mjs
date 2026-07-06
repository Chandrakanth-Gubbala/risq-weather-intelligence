import { dataManifest } from "../../llm/domain/dataManifest.mjs";
import { regionIds } from "../regionCatalog.mjs";

export const contextPacketTurnTypes = ["new_question", "slot_answer", "scope_answer", "refinement", "cancel", "chitchat", "out_of_scope", "unsafe"];
export const decisionTypes = ["go_no_go", "rank_places", "pick_time_window", "explain_dashboard", "compare_places", "route_assessment", "describe_conditions", "advise"];
export const sensitivityIds = ["rain", "wind", "heat", "cold", "humidity", "cloud", "alerts"];
export const audienceFlags = ["elderly", "children", "workers", "pets", "none"];
export const scopeKinds = ["explicit_locations", "selected_region", "current_map", "named_region", "named_state", "nationwide", "unresolved"];
export const timeKinds = ["none", "now", "day", "daypart", "clock_range", "multi_day"];
export const evidenceOps = ["mean", "max", "min", "sum", "count", "threshold", "rank_locations", "best_window"];
export const appliesToIds = ["each_location", "each_candidate", "route_points"];
export const allowedClaimLevels = ["weather_conditions", "weather_suitability", "weather_exposure_risk", "dashboard_explanation"];
export const forbiddenClaimIds = [
  "outcome_guarantee",
  "eta_or_delay_prediction",
  "exact_setpoint",
  "traffic_or_road_status",
  "dark_sky_guarantee",
  "medical_advice",
  "business_metric_prediction",
  "official_safety_clearance"
];
export const requestedLayerIds = ["risk", "heat", "temp", "fire", "wind", "humidity", "cloud", "cdd"];

export const manifestVariableIdsArray = Object.freeze(Object.keys(dataManifest.variables));
export const manifestExternalFactorsArray = Object.freeze(dataManifest.notAvailable);

export function contextPacketSchema() {
  const timeWindowSchema = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "dayOffset", "days", "daypart", "startHour", "endHour"],
    properties: {
      kind: { type: "string", enum: timeKinds },
      dayOffset: { type: ["number", "null"] },
      days: { type: ["number", "null"] },
      daypart: { type: ["string", "null"] },
      startHour: { type: ["number", "null"] },
      endHour: { type: ["number", "null"] }
    }
  };
  const scopeSchema = {
    type: "object",
    additionalProperties: false,
    required: ["kind", "regionId", "stateCode"],
    properties: {
      kind: { type: "string", enum: scopeKinds },
      regionId: { type: ["string", "null"], enum: [...regionIds, null] },
      stateCode: { type: ["string", "null"] }
    }
  };
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "turnType",
      "slotAnswer",
      "application",
      "scope",
      "locations",
      "timeWindow",
      "evidenceRequests",
      "externalFactors",
      "externalFactorsOther",
      "slotProposals",
      "claimFrame",
      "requestedLayer",
      "confidence",
      "userReferencedMapContext"
    ],
    properties: {
      turnType: { type: "string", enum: contextPacketTurnTypes },
      slotAnswer: {
        type: ["object", "null"],
        additionalProperties: false,
        required: ["slotId", "location", "timeWindow", "scope"],
        properties: {
          slotId: { type: "string", enum: ["location", "origin", "destination", "time_window", "search_scope"] },
          location: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["raw", "normalized", "role"],
            properties: {
              raw: { type: "string" },
              normalized: { type: "string" },
              role: { type: "string", enum: ["single", "origin", "destination"] }
            }
          },
          timeWindow: { anyOf: [timeWindowSchema, { type: "null" }] },
          scope: { anyOf: [scopeSchema, { type: "null" }] }
        }
      },
      application: {
        type: "object",
        additionalProperties: false,
        required: ["activity", "decisionType", "sensitivities", "audienceFlags"],
        properties: {
          activity: { type: "string" },
          decisionType: { type: "string", enum: decisionTypes },
          sensitivities: { type: "array", items: { type: "string", enum: sensitivityIds } },
          audienceFlags: { type: "array", items: { type: "string", enum: audienceFlags } }
        }
      },
      scope: scopeSchema,
      locations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["raw", "normalized", "role"],
          properties: {
            raw: { type: "string" },
            normalized: { type: "string" },
            role: { type: "string", enum: ["single", "origin", "destination", "comparison"] }
          }
        }
      },
      timeWindow: timeWindowSchema,
      evidenceRequests: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["variable", "op", "over", "threshold", "appliesTo"],
          properties: {
            variable: { type: "string", enum: manifestVariableIdsArray },
            op: { type: "string", enum: evidenceOps },
            over: { type: "string", enum: ["window", "per_day", "hourly"] },
            threshold: {
              type: ["object", "null"],
              additionalProperties: false,
              required: ["cmp", "value"],
              properties: {
                cmp: { type: "string", enum: ["gte", "lte"] },
                value: { type: "number" }
              }
            },
            appliesTo: { type: "string", enum: appliesToIds }
          }
        }
      },
      externalFactors: { type: "array", items: { type: "string", enum: manifestExternalFactorsArray } },
      externalFactorsOther: { type: "array", items: { type: "string" } },
      slotProposals: { type: "array", items: { type: "string", enum: ["location", "origin", "destination", "time_window", "search_scope"] } },
      claimFrame: {
        type: "object",
        additionalProperties: false,
        required: ["allowedClaimLevel", "forbiddenClaims"],
        properties: {
          allowedClaimLevel: { type: "string", enum: allowedClaimLevels },
          forbiddenClaims: { type: "array", items: { type: "string", enum: forbiddenClaimIds } }
        }
      },
      requestedLayer: { type: ["string", "null"], enum: [...requestedLayerIds, null] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      userReferencedMapContext: { type: "boolean" }
    }
  };
}
