import {
  MESSAGE_PART_TYPES,
  generationEventCursor,
  skillInline,
  titleFromPrompt,
} from "@viby/sdk/core";

postMessage({
  cursor: generationEventCursor(new Headers({ "Last-Event-ID": "21" })),
  hasToolCalls: MESSAGE_PART_TYPES.includes("tool-call"),
  skillSource: skillInline({
    name: "worker-rules",
    files: [{ path: "SKILL.md", content: "# Worker rules" }],
  }).source,
  title: titleFromPrompt("Build a polished analytics dashboard with charts"),
});
