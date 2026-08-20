const MAX_TITLE_LENGTH = 48;
const MAX_TITLE_WORDS = 7;

const GENERIC_ARTIFACT =
  /^(?:website|site|app|application|dashboard|workspace|platform|landing page|launch page|portfolio|storefront|portal|tool)$/i;

/**
 * Derive an immediate, deterministic project title from a user's first prompt.
 *
 * The helper is runtime- and model-neutral. Applications can persist the result
 * when creating a chat without adding a second model request to the critical path.
 */
export function titleFromPrompt(prompt: string) {
  let title = normalizePrompt(prompt);
  title = removeRequestPrefix(title);
  title = removeLeadingFiller(title);

  const details = title.split(
    /\s+(?:with|that|which|including|featuring|where|using|containing|showing|so that)\s+/i,
    1,
  )[0];
  title = details?.trim() || title;

  const purpose = title.split(/\s+for\s+/i);
  const artifact = removeLeadingFiller(purpose[0] ?? "");
  if (purpose.length === 2 && GENERIC_ARTIFACT.test(artifact)) {
    const subject = removeLeadingFiller(purpose[1] ?? "");
    if (artifact && subject) title = `${subject} ${artifact}`;
  }

  title = title
    .replace(/^(?:my|our)\s+/i, "")
    .replace(/[.!?,:;\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = title.split(" ").filter(Boolean).slice(0, MAX_TITLE_WORDS);
  while (words.length > 1 && words.join(" ").length > MAX_TITLE_LENGTH) words.pop();
  const compact = words.join(" ").slice(0, MAX_TITLE_LENGTH).trim();
  if (!compact) return "New project";
  return `${compact.charAt(0).toLocaleUpperCase()}${compact.slice(1)}`;
}

function normalizePrompt(prompt: string) {
  return prompt
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[`*_#>\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function removeRequestPrefix(value: string) {
  let title = value;
  const prefixes = [
    /^(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?/i,
    /^(?:please\s+)?help\s+me\s+(?:to\s+)?/i,
    /^i\s+(?:want|need|would like)\s+(?:you\s+)?(?:to\s+)?/i,
    /^(?:please\s+)?(?:build|create|design|make|develop|generate|implement|revamp|redesign)\s+(?:me\s+)?/i,
  ];
  for (const prefix of prefixes) title = title.replace(prefix, "");
  return title.trim();
}

function removeLeadingFiller(value: string) {
  return value
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(
      /^(?:(?:new|polished|modern|beautiful|professional|production[- ]ready|responsive|complete|fully[- ]functional|high[- ]converting|great|amazing|clean|sleek)\s+)+/i,
      "",
    )
    .trim();
}
