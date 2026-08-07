import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openai } from "@ai-sdk/openai";
import { createViby, skillRead } from "@viby/sdk";

const required = ["DATABASE_URL", "OPENAI_API_KEY"] as const;
for (const name of required) {
  if (!process.env[name]) {
    throw new Error(`${name} is required. Copy .env.example to .env and fill it in.`);
  }
}

const skillDirectory = fileURLToPath(new URL("../skills/product", import.meta.url));
const outputDirectory = resolve(process.env.VIBY_OUTPUT_DIR ?? "./output");

const viby = createViby({
  framework: "farm",
  model: openai(process.env.OPENAI_MODEL ?? "gpt-5.6-sol"),
  skills: {
    product: [skillRead(skillDirectory)],
    frontend: [],
    security: [],
  },
});

try {
  const userViby = viby.forUser({
    tenantId: process.env.VIBY_TENANT_ID ?? "demo-tenant",
    userId: process.env.VIBY_USER_ID ?? "demo-user",
  });

  const chat = await userViby.chats.create({ title: "Signal waitlist" });
  let version = await chat.generate({
    prompt: [
      "Build a compact, polished waitlist page for Signal, a privacy-first analytics product.",
      "Include a concise hero, three proof points, an email form with validation feedback,",
      "and a quiet footer. Return a complete runnable Farm project.",
    ].join(" "),
  });

  const iterationPrompt = process.env.VIBY_ITERATION_PROMPT?.trim();
  if (iterationPrompt) {
    version = await version.iterate({ prompt: iterationPrompt });
  }

  // Re-open through the scoped client to prove the result came back from persistence.
  const persistedChat = await userViby.chats.get(chat.id);
  const persistedVersion = await persistedChat.getVersion(version.id);
  const [messages, versions, files, generation, artifact] = await Promise.all([
    persistedChat.listMessages(),
    persistedChat.listVersions(),
    persistedVersion.files(),
    persistedVersion.generation(),
    persistedVersion.download(),
  ]);

  await mkdir(outputDirectory, { recursive: true });
  const artifactPath = resolve(outputDirectory, artifact.filename);
  await writeFile(artifactPath, artifact.bytes);

  console.log(JSON.stringify({
    chatId: persistedChat.id,
    versionId: persistedVersion.id,
    versionNumber: persistedVersion.number,
    messages: messages.length,
    versions: versions.length,
    files: files.length,
    generationStatus: generation.status,
    totalTokens: generation.totalTokens,
    sourceZip: artifactPath,
    previewUrl: null,
  }, null, 2));
} finally {
  await viby.close();
}
