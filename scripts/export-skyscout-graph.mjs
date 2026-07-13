import { mkdir, writeFile } from "node:fs/promises";
import { skyScoutGraphNodeDescriptions, skyScoutLangGraphMermaid } from "../server/assistant/skyscoutGraph.mjs";

const docsDir = new URL("../docs/", import.meta.url);
const mermaidPath = new URL("./skyscout-langgraph.mmd", docsDir);
const markdownPath = new URL("./SKYSCOUT_LANGGRAPH.md", docsDir);

const nodeDescriptions = skyScoutGraphNodeDescriptions();
const mermaid = humanizeMermaid(skyScoutLangGraphMermaid(), nodeDescriptions);
const rows = skyScoutGraphNodeDescriptions()
  .map(({ id, description }) => `| \`${id}\` | ${titleFromId(id)} | ${description} |`)
  .join("\n");

const markdown = `# SkyScout LangGraph Orchestration

This document is generated from \`server/assistant/skyscoutGraph.mjs\`.

SkyScout currently runs in \`server/http.mjs\` as a guarded assistant pipeline. The LangGraph below captures the intended orchestration shape: fast-path responses, structured interpretation, session-aware follow-up handling, evidence retrieval, deterministic fallback, optional LLM answer writing, claim verification, and final session response.

\`\`\`mermaid
${mermaid}
\`\`\`

## Node Reference

| Node ID | Label | Purpose |
| --- | --- | --- |
${rows}

## How To Regenerate

\`\`\`powershell
npm.cmd run graph:skyscout
\`\`\`

The generated Mermaid file is also written to \`docs/skyscout-langgraph.mmd\`.
`;

await mkdir(docsDir, { recursive: true });
await writeFile(mermaidPath, mermaid, "utf8");
await writeFile(markdownPath, markdown, "utf8");

console.log(`Wrote ${mermaidPath.pathname}`);
console.log(`Wrote ${markdownPath.pathname}`);

function humanizeMermaid(source, descriptions) {
  let next = source;
  for (const { id } of descriptions) {
    const escaped = escapeRegExp(id);
    next = next.replace(new RegExp(`\\b${escaped}\\(${escaped}\\)`, "g"), `${id}["${titleFromId(id)}"]`);
  }
  return next;
}

function titleFromId(id) {
  const overrides = {
    llm_writer_gate: "LLM Writer Gate",
    llm_answer_writer: "LLM Answer Writer"
  };
  if (overrides[id]) return overrides[id];
  return id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
