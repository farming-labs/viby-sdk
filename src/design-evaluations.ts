import { ConfigurationError } from "./errors.js";
import { normalizeChatMetadata } from "./metadata.js";
import type {
  ChatMetadata,
  DesignEvaluationCriterionInput,
  DesignEvaluationEvidence,
  DesignEvaluationStatus,
  RecordDesignEvaluationInput,
} from "./types.js";
import { assertIdentifier, normalizeProjectPath } from "./utils.js";

const MAX_CRITERIA = 50;
const MAX_EVIDENCE_PER_RESULT = 100;
const MAX_EVALUATION_BYTES = 256_000;

export function normalizeDesignEvaluation(
  input: RecordDesignEvaluationInput,
): Omit<RecordDesignEvaluationInput, "evidence" | "metadata"> & {
  readonly evidence: readonly DesignEvaluationEvidence[];
  readonly metadata: ChatMetadata;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigurationError("A design evaluation must be an object.");
  }
  const evaluator = normalizeText(input.evaluator, "Design evaluator", 200);
  const status = normalizeStatus(input.status);
  const score = normalizeScore(input.score, "Design evaluation score");
  const summary = normalizeText(input.summary, "Design evaluation summary", 4_000);
  if (!Array.isArray(input.criteria) || input.criteria.length < 1 || input.criteria.length > MAX_CRITERIA) {
    throw new ConfigurationError(`A design evaluation must contain 1-${MAX_CRITERIA} criteria.`);
  }
  const seen = new Set<string>();
  const criteria = input.criteria.map((criterion, index) => {
    const normalized = normalizeCriterion(criterion, index);
    if (seen.has(normalized.id)) {
      throw new ConfigurationError(`Design evaluation criterion is duplicated: ${normalized.id}`);
    }
    seen.add(normalized.id);
    return normalized;
  });
  const evidence = normalizeEvidenceList(input.evidence ?? [], "Design evaluation evidence");
  const metadata = normalizeChatMetadata(input.metadata);
  const normalized = { evaluator, status, score, summary, criteria, evidence, metadata };
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_EVALUATION_BYTES) {
    throw new ConfigurationError(`A design evaluation cannot exceed ${MAX_EVALUATION_BYTES} bytes.`);
  }
  return normalized;
}

function normalizeCriterion(
  criterion: DesignEvaluationCriterionInput,
  index: number,
): DesignEvaluationCriterionInput {
  if (!criterion || typeof criterion !== "object" || Array.isArray(criterion)) {
    throw new ConfigurationError(`Design evaluation criterion ${index + 1} must be an object.`);
  }
  const id = assertIdentifier(criterion.id, `Design evaluation criterion ${index + 1} id`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
    throw new ConfigurationError(`Design evaluation criterion id is invalid: ${id}`);
  }
  return {
    id,
    label: normalizeText(criterion.label, `Design evaluation criterion ${id} label`, 200),
    status: normalizeStatus(criterion.status),
    score: normalizeScore(criterion.score, `Design evaluation criterion ${id} score`),
    summary: normalizeText(criterion.summary, `Design evaluation criterion ${id} summary`, 2_000),
    evidence: normalizeEvidenceList(
      criterion.evidence ?? [],
      `Design evaluation criterion ${id} evidence`,
    ),
  };
}

function normalizeEvidenceList(
  evidence: readonly DesignEvaluationEvidence[],
  label: string,
): DesignEvaluationEvidence[] {
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE_PER_RESULT) {
    throw new ConfigurationError(`${label} must be an array with at most ${MAX_EVIDENCE_PER_RESULT} items.`);
  }
  return evidence.map((item, index) => normalizeEvidence(item, `${label} ${index + 1}`));
}

function normalizeEvidence(
  evidence: DesignEvaluationEvidence,
  label: string,
): DesignEvaluationEvidence {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new ConfigurationError(`${label} must be an object.`);
  }
  switch (evidence.type) {
    case "version-file":
      return {
        type: "version-file",
        path: normalizeProjectPath(evidence.path),
        ...normalizeDescription(evidence.description, label),
      };
    case "attachment":
      return {
        type: "attachment",
        attachmentId: assertIdentifier(evidence.attachmentId, `${label} attachment id`),
        ...normalizeDescription(evidence.description, label),
      };
    case "artifact":
      return {
        type: "artifact",
        artifactId: assertIdentifier(evidence.artifactId, `${label} artifact id`),
        ...normalizeDescription(evidence.description, label),
      };
    case "url": {
      const url = normalizeUrl(evidence.url, label);
      return { type: "url", url, ...normalizeDescription(evidence.description, label) };
    }
    case "note":
      return { type: "note", text: normalizeText(evidence.text, `${label} note`, 4_000) };
    default:
      throw new ConfigurationError(`${label} type is unsupported.`);
  }
}

function normalizeDescription(value: string | undefined, label: string) {
  return value === undefined
    ? {}
    : { description: normalizeText(value, `${label} description`, 1_000) };
}

function normalizeUrl(value: string, label: string): string {
  const normalized = normalizeText(value, `${label} URL`, 2_048);
  let url: URL;
  try {
    url = new URL(normalized);
  } catch (error) {
    throw new ConfigurationError(`${label} URL is invalid.`, { cause: error });
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new ConfigurationError(`${label} URL must use HTTP(S) without embedded credentials.`);
  }
  return url.toString();
}

function normalizeStatus(value: DesignEvaluationStatus): DesignEvaluationStatus {
  if (value !== "passed" && value !== "warning" && value !== "failed") {
    throw new ConfigurationError("Design evaluation status must be passed, warning, or failed.");
  }
  return value;
}

function normalizeScore(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new ConfigurationError(`${label} must be a finite number between 0 and 100.`);
  }
  return value;
}

function normalizeText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new ConfigurationError(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ConfigurationError(`${label} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}
