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
        contentWidth: 640,
        sidebarWidth: 288,
        tocWidth: 256,
      },
    },
  }),
  sidebar: {
    flat: true,
    collapsible: false,
  },
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
  readingTime: false,
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
      { label: "API v1", slug: "api/v1" },
      { label: "Web API host", slug: "api-host" },
      { label: "Runtime boundaries", slug: "runtime" },
      { label: "Quality matrix", slug: "quality-matrix" },
      { label: "GitHub integration", slug: "integrations/github" },
      { label: "Vercel integration", slug: "integrations/vercel" },
      { label: "Cloudflare integration", slug: "integrations/cloudflare" },
      { label: "Bitbucket integration", slug: "integrations/bitbucket" },
      { label: "Live provider testing", slug: "live-provider-testing" },
      { label: "Publishing", slug: "publishing" },
      { label: "v0 capability reference", slug: "api/v0-core" },
    ],
  },
};
