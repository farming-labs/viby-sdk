import { defineConfig, definePlugin } from "@farm.js/core";
import { withDocs } from "@farming-labs/farmjs/config";

const serializedThemeScriptPlugin = definePlugin({
  name: "viby-serialized-theme-script",
  build: {
    configure(buildConfig) {
      return {
        ...buildConfig,
        esbuild: {
          ...buildConfig.esbuild,
          options: {
            ...buildConfig.esbuild?.options,
            // The docs theme serializes its initializer with Function#toString.
            // Name-preservation helpers live outside that inline script.
            keepNames: false,
          },
        },
      };
    },
  },
});

export default withDocs(
  defineConfig({
    theme: {
      default: "system",
    },
    plugins: [serializedThemeScriptPlugin],
  }),
  {
    codeBlockThemes: {
      light: "github-light-default",
      dark: "vesper",
    },
  },
);
