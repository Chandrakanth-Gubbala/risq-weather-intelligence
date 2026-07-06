import type { AssistantConversationState, AssistantResponse } from "../types";

export type AssistantController = {
  el: HTMLElement;
  update: (label: string) => void;
};

type ChatItem = {
  role: "user" | "assistant";
  html: string;
};

const starters = [
  "Find me a good outdoor window",
  "Explain this area's risk",
  "Where is best for stargazing?",
  "Check travel weather"
];

export function createAssistant(args: {
  onAsk: (message: string, conversationState: AssistantConversationState | null) => Promise<AssistantResponse>;
  inline?: boolean;
}): AssistantController {
  const root = document.createElement("section");
  const inline = args.inline === true;
  root.className = inline ? "assistant-widget inline open" : "assistant-widget";
  root.setAttribute("aria-label", "SkyScout weather assistant");
  const messages: ChatItem[] = [
    {
      role: "assistant",
      html: "Hi, I am SkyScout. Tell me a place, route, map area, or plan, and I will use the dashboard weather signals to help you find the least-chaotic window."
    }
  ];
  let contextLabel = "Using current map";
  let conversationState: AssistantConversationState | null = null;
  let open = inline;
  let busy = false;

  function render(): void {
    root.classList.toggle("open", open);
    root.classList.toggle("inline", inline);
    root.innerHTML = open
      ? `
        <div class="assistant-panel">
          <header>
            <div><b>SkyScout</b><span>${escapeHtml(contextLabel)}</span></div>
            ${inline ? "" : `<button type="button" class="assistant-close" aria-label="Close SkyScout">×</button>`}
          </header>
          <div class="assistant-messages" aria-live="polite">
            ${messages.map((item) => `<div class="assistant-msg ${item.role}">${item.html}</div>`).join("")}
            ${busy ? `<div class="assistant-msg assistant">SkyScout is checking the map, forecast, and alert signals...</div>` : ""}
          </div>
          <div class="assistant-starters">
            ${starters.map((text) => `<button type="button">${escapeHtml(text)}</button>`).join("")}
          </div>
          <form class="assistant-form">
            <input type="text" placeholder="Ask SkyScout about a place, plan, or weather window..." aria-label="Ask SkyScout" ${busy ? "disabled" : ""}/>
            <button type="submit" ${busy ? "disabled" : ""}>Ask</button>
          </form>
        </div>
      `
      : `<button type="button" class="assistant-fab" aria-label="Open SkyScout"><b>Ask SkyScout</b><span>Weather advisor</span></button>`;
    root.querySelector(".assistant-fab")?.addEventListener("click", () => {
      open = true;
      render();
    });
    root.querySelector(".assistant-close")?.addEventListener("click", () => {
      open = inline ? true : false;
      render();
    });
    root.querySelectorAll<HTMLButtonElement>(".assistant-starters button").forEach((btn) => {
      btn.addEventListener("click", () => void ask(btn.textContent ?? ""));
    });
    root.querySelector<HTMLFormElement>(".assistant-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = root.querySelector<HTMLInputElement>(".assistant-form input");
      const value = input?.value.trim() ?? "";
      if (input) input.value = "";
      void ask(value);
    });
    const scroller = root.querySelector(".assistant-messages");
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  async function ask(message: string): Promise<void> {
    if (!message || busy) return;
    open = true;
    messages.push({ role: "user", html: escapeHtml(message) });
    busy = true;
    render();
    try {
      const response = await args.onAsk(message, conversationState);
      conversationState = response.conversationState ?? null;
      messages.push({ role: "assistant", html: renderResponse(response) });
    } catch (error) {
      messages.push({
        role: "assistant",
        html: `SkyScout could not reach the weather brain for a second. ${escapeHtml(error instanceof Error ? error.message : "Try again shortly.")}`
      });
    } finally {
      busy = false;
      render();
    }
  }

  render();
  return {
    el: root,
    update(label) {
      contextLabel = label;
      const node = root.querySelector(".assistant-panel header span");
      if (node) node.textContent = label;
    }
  };
}

function renderResponse(response: AssistantResponse): string {
  const meta = responseMeta(response);
  const showWindows = shouldShowWindows(response);
  const showRisks = shouldShowRisks(response);
  return `
    <div class="assistant-verdict" data-verdict="${response.verdict}">
      <b>${escapeHtml(labelResponse(response))}</b><span>${escapeHtml(meta)}</span>
    </div>
    <p>${escapeHtml(response.answer)}</p>
    ${response.capabilityNote && shouldShowCapabilityNote(response)
      ? `<div class="assistant-mini"><b>${escapeHtml(capabilityHeading(response))}</b><span>${escapeHtml(response.capabilityNote)}</span></div>`
      : ""}
    ${showWindows ? `<div class="assistant-mini"><b>${windowHeading(response.verdict)}</b>${response.bestWindows
      .map((w) => `<span>${escapeHtml(w.label)}: ${escapeHtml(w.rationale)}</span>`)
      .join("")}</div>` : ""}
    ${showRisks ? `<div class="assistant-mini"><b>Worth watching</b>${response.risks
      .slice(0, 2)
      .map((risk) => `<span>${escapeHtml(risk)}</span>`)
      .join("")}</div>` : ""}
    <small>${escapeHtml(sourceText(response.dataUsed))}</small>
  `;
}

function labelVerdict(verdict: AssistantResponse["verdict"]): string {
  if (verdict === "good") return "Good";
  if (verdict === "marginal") return "Marginal";
  if (verdict === "avoid") return "Avoid";
  return "Insufficient data";
}

function labelResponse(response: AssistantResponse): string {
  if (response.answerType === "greeting") return "Hi";
  if (response.answerType === "needs_followup") return "Quick question";
  if (response.answerType === "in_scope_partial_business") return "Partial";
  if (response.answerType === "in_scope_dashboard_explainer") return "Explainer";
  if (response.answerType === "unsupported_by_data") return "Not available";
  if (response.answerType === "out_of_domain") return "Outside scope";
  return labelVerdict(response.verdict);
}

function windowHeading(verdict: AssistantResponse["verdict"]): string {
  if (verdict === "avoid") return "After this clears, recheck";
  return "Good times to consider";
}

function confidenceText(response: AssistantResponse): string {
  if (response.verdict === "insufficient_data") return "I need a little more info";
  if (response.confidence === "high") return "I have a solid read";
  if (response.confidence === "medium") return "A decent read";
  return "Limited read";
}

function responseMeta(response: AssistantResponse): string {
  const base = confidenceText(response);
  if (response.persona && response.persona !== "General planning") return `${base} · ${response.persona}`;
  if (response.answerType === "in_scope_partial_business") return `${base} · partial weather answer`;
  return base;
}

function shouldShowCapabilityNote(response: AssistantResponse): boolean {
  return Boolean(
      response.answerType === "in_scope_partial_business" ||
      response.answerType === "needs_followup" ||
      response.answerType === "unsupported_by_data" ||
      response.answerType === "out_of_domain"
  );
}

function shouldShowWindows(response: AssistantResponse): boolean {
  if (!response.bestWindows.length) return false;
  if (response.answerType === "needs_followup" || response.answerType === "out_of_domain" || response.answerType === "unsupported_by_data") {
    return false;
  }
  const answer = response.answer.toLowerCase();
  if (answer.includes("top options") || answer.includes("best day") || answer.includes("best pick")) return false;
  return response.answerType === "in_scope_partial_business" || response.verdict === "avoid";
}

function shouldShowRisks(response: AssistantResponse): boolean {
  if (!response.risks.length) return false;
  if (response.answerType === "greeting") return false;
  if (response.answerType === "needs_followup" || response.answerType === "out_of_domain" || response.answerType === "unsupported_by_data") {
    return true;
  }
  const answer = response.answer.toLowerCase();
  const firstRisk = response.risks[0]?.toLowerCase().slice(0, 42) ?? "";
  if (firstRisk && answer.includes(firstRisk)) return false;
  if (answer.includes("watch-outs") || answer.includes("not checking") || answer.includes("not connected")) return false;
  return response.verdict === "avoid" || response.answerType === "in_scope_partial_business";
}

function capabilityHeading(response: AssistantResponse): string {
  if (response.answerType === "in_scope_partial_business") return "What I can and cannot infer";
  if (response.answerType === "needs_followup") return "What I need";
  if (response.answerType === "unsupported_by_data") return "Not currently in this dashboard";
  if (response.answerType === "out_of_domain") return "Scope";
  return "Context";
}

function sourceText(dataUsed: string[]): string {
  const joined = dataUsed.join(" ").toLowerCase();
  if (joined.includes("guardrail")) return "SkyScout kept this inside the weather-dashboard lane.";
  if (joined.includes("demo") || joined.includes("static")) return "Based on demo weather data, so treat this as a product preview.";
  if (joined.includes("alert")) return "Based on the current forecast and alert context.";
  return "Based on the current forecast and map context.";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[ch] ?? ch;
  });
}
