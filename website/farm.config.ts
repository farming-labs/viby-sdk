import { defineConfig } from "@farm.js/core";
import { withDocs } from "@farming-labs/farmjs/config";

export default withDocs(
  defineConfig({
    theme: {
      default: "system",
    },
  }),
  {
    codeBlockThemes: {
      light: "github-light-default",
      dark: "vesper",
    },
  },
);
