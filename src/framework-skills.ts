import { FRAMEWORK_SKILL_CONTENT } from "./framework-skills.generated.js";
import { isBuiltInFramework, type BuiltInFrameworkId, type FrameworkId } from "./frameworks.js";
import { skillInline } from "./skill-resolver.js";
import type { InlineSkillReference, SkillGroups } from "./types.js";

const legacyFrameworkAliases: Readonly<Record<string, BuiltInFrameworkId>> = {
  farm: "farmjs",
  next: "nextjs",
};

/** Return the package-owned immutable skill for one built-in framework. */
export function frameworkSkill(framework: BuiltInFrameworkId): InlineSkillReference {
  return skillInline({
    name: `viby-framework-${framework}`,
    description: `Bundled generation contract for ${framework}.`,
    files: [{ path: "SKILL.md", content: FRAMEWORK_SKILL_CONTENT[framework] }],
  });
}

/** Add the selected built-in framework contract to the always-resolved core skill group. */
export function withFrameworkSkill(
  framework: FrameworkId,
  groups: SkillGroups = {},
): SkillGroups {
  const builtIn = isBuiltInFramework(framework)
    ? framework
    : legacyFrameworkAliases[framework];
  if (!builtIn) return groups;
  return {
    ...groups,
    core: [frameworkSkill(builtIn), ...(groups.core ?? [])],
  };
}
