import { defineDocs } from "@farming-labs/docs";
import { shadcn } from "@farming-labs/theme/shadcn";

export default defineDocs({
  entry: "docs",
  contentDir: "docs",
  nav: {
    title: "Viby",
    url: "/",
  },
  metadata: {
    titleTemplate: "%s · Viby",
    description:
      "Build persistent, framework-neutral vibe coding products with durable generations, portable adapters, and immutable source versions.",
  },
  theme: shadcn(),
  themeToggle: {
    enabled: true,
    default: "system",
  },
  search: {
    provider: "simple",
    enabled: true,
    maxResults: 12,
  },
  breadcrumb: true,
  readingTime: true,
  pageActions: {
    position: "below-title",
    copyMarkdown: true,
    openDocs: {
      enabled: true,
      target: "markdown",
    },
  },
  llmsTxt: {
    enabled: true,
    siteTitle: "Viby SDK",
    siteDescription: "Framework-neutral infrastructure for vibe coding products.",
  },
  sitemap: true,
  robots: true,
});
