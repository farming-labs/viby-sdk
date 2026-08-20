import assert from "node:assert/strict";
import test from "node:test";
import { titleFromPrompt } from "../src/core.js";

test("derives a concise title from a detailed project prompt", () => {
  assert.equal(
    titleFromPrompt("Build a polished SaaS analytics dashboard with revenue charts"),
    "SaaS analytics dashboard",
  );
  assert.equal(
    titleFromPrompt(
      "Create an AI research workspace with source collections, citations, and focused chat",
    ),
    "AI research workspace",
  );
});

test("moves a project subject before a generic artifact", () => {
  assert.equal(titleFromPrompt("Please create a website for my coffee shop"), "Coffee shop website");
  assert.equal(
    titleFromPrompt("Design a polished launch page for a developer tool with clear pricing"),
    "Developer tool launch page",
  );
});

test("bounds titles and falls back when no prompt text remains", () => {
  const title = titleFromPrompt(
    "Build an inventory management dashboard for distributed warehouse operations across many regions",
  );
  assert.ok(title.length <= 48);
  assert.ok(title.split(" ").length <= 7);
  assert.equal(titleFromPrompt("  https://example.com  "), "New project");
});
