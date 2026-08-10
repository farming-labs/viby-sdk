export interface GeneratedProjectQualityScenario {
  readonly id: string;
  readonly framework: string;
  readonly title: string;
  readonly prompt: string;
  readonly sourceDirectory: string;
  readonly accent: string;
}

export const GENERATED_PROJECT_QUALITY_MATRIX: readonly GeneratedProjectQualityScenario[] = [
  {
    id: "farm-saas-dashboard",
    framework: "farm",
    title: "Northstar Analytics",
    prompt: "Build a polished SaaS analytics dashboard with complete interaction states.",
    sourceDirectory: "src",
    accent: "#6558d3",
  },
  {
    id: "tanstack-commerce",
    framework: "tanstack-start",
    title: "Mercury Commerce",
    prompt: "Build a responsive commerce operations workspace with accessible controls.",
    sourceDirectory: "app",
    accent: "#0f766e",
  },
  {
    id: "custom-support-console",
    framework: "custom-web-runtime",
    title: "Relay Support",
    prompt: "Build a dense support console using this custom framework identifier.",
    sourceDirectory: "client",
    accent: "#b45309",
  },
];
