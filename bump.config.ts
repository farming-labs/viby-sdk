import { defineConfig } from "bumpp";

export default defineConfig({
  all: true,
  commit: "chore: release v%s",
  tag: "v%s",
  push: true,
  files: ["package.json", "package-lock.json"],
  execute: "npm run release:prepare",
});
