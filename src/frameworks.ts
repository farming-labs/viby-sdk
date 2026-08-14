export const builtInFrameworks = [
  "farmjs",
  "nextjs",
  "svelte",
  "sveltekit",
  "vue",
  "nuxt",
  "solid",
  "solidstart",
  "tanstack-start",
  "react-router",
  "astro",
  "vite",
] as const;

export type BuiltInFrameworkId = (typeof builtInFrameworks)[number];
export type FrameworkId = BuiltInFrameworkId | (string & {});

const builtInFrameworkSet = new Set<string>(builtInFrameworks);

export function isBuiltInFramework(value: string): value is BuiltInFrameworkId {
  return builtInFrameworkSet.has(value);
}
