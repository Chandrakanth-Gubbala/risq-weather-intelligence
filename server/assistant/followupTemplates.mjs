export const followupTemplates = new Map([
  ["location", "What city and state should I check?"],
  ["origin", "What starting point should I use for the route?"],
  ["destination", "What destination should I use for the route?"],
  ["time_window", "What time window should I check: today, tomorrow, this evening, or a rough time like 5 PM?"],
  ["search_scope", "Should I search the current map view, a city/state, or a U.S. region like the Northeast or Southwest?"]
]);

export const slotIds = Object.freeze([...followupTemplates.keys()]);

export function canonicalSlotId(value) {
  return slotIds.includes(value) ? value : null;
}

export function followupQuestionForSlot(slotId) {
  return followupTemplates.get(canonicalSlotId(slotId)) ?? followupTemplates.get("location");
}
