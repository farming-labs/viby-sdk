import { defineDocs } from "@farming-labs/docs";
import { shadcn } from "@farming-labs/theme/shadcn";

const docs = defineDocs({
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
  theme: shadcn({
    ui: {
      layout: {
        contentWidth: 680,
        sidebarWidth: 272,
        tocWidth: 232,
      },
    },
  }),
  themeToggle: {
    enabled: true,
    default: "light",
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

export default {
  ...docs,
  navigation: {
    sidebar: [
      { label: "Overview", slug: "" },
      { label: "Capabilities", slug: "capabilities" },
      {
        label: "Build with Viby",
        children: [
          { label: "API v1", slug: "api/v1" },
          { label: "Web API host", slug: "api-host" },
          { label: "Runtime boundaries", slug: "runtime" },
          { label: "Quality matrix", slug: "quality-matrix" },
        ],
      },
      {
        label: "Integrations",
        children: [
          { label: "GitHub", slug: "integrations/github" },
          { label: "Vercel", slug: "integrations/vercel" },
          { label: "Cloudflare", slug: "integrations/cloudflare" },
          { label: "Bitbucket", slug: "integrations/bitbucket" },
        ],
      },
      {
        label: "Operations",
        children: [
          { label: "Live provider testing", slug: "live-provider-testing" },
          { label: "Publishing", slug: "publishing" },
          { label: "v0 capability reference", slug: "api/v0-core" },
        ],
      },
    ],
  },
};
