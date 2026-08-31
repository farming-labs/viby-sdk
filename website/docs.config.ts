import { defineDocs } from "@farming-labs/docs";
import { shadcn } from "@farming-labs/theme/shadcn";

const docs = defineDocs({
  entry: "docs",
  contentDir: "docs",
  nav: {
    title: "viby",
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
    default: "dark",
  },
  search: {
    provider: "simple",
    enabled: true,
    maxResults: 12,
  },
  breadcrumb: false,
  readingTime: false,
  pageActions: {
    position: "below-title",
    copyMarkdown: {
      enabled: true,
      label: "Copy Page",
      copiedLabel: "Copied",
    },
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
      {
        label: "Get started",
        children: [
          { label: "Overview", slug: "" },
          { label: "Quickstart", slug: "getting-started" },
          { label: "Core concepts", slug: "concepts" },
          { label: "Capabilities", slug: "capabilities" },
          { label: "Credentials", slug: "credentials" },
        ],
      },
      {
        label: "SDK reference",
        children: [
          { label: "Reference overview", slug: "api" },
          { label: "Client and configuration", slug: "api/client" },
          { label: "Generation engines", slug: "api/generation-engines" },
          { label: "Chats and projects", slug: "api/chats" },
          { label: "Message feedback", slug: "api/message-feedback" },
          { label: "Generations and events", slug: "api/generations" },
          { label: "Versions and artifacts", slug: "api/versions" },
          { label: "Previews and sandboxes", slug: "api/previews" },
          { label: "Tool sources", slug: "api/tool-sources" },
          { label: "Integrations", slug: "api/integrations" },
          { label: "Errors", slug: "api/errors" },
          { label: "Runtime boundaries", slug: "runtime" },
          { label: "Package entry points", slug: "api/entry-points" },
          { label: "Complete v1 contract", slug: "api/v1" },
          { label: "Web API host", slug: "api-host" },
        ],
      },
      {
        label: "Provider guides",
        children: [
          { label: "GitHub", slug: "integrations/github" },
          { label: "Bitbucket", slug: "integrations/bitbucket" },
          { label: "Vercel", slug: "integrations/vercel" },
          { label: "Cloudflare", slug: "integrations/cloudflare" },
        ],
      },
    ],
  },
};
