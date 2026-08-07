import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openai } from "@ai-sdk/openai";
import { createViby, skillRead } from "@viby/sdk";

const chatId = process.env.VIBY_CHAT_ID?.trim();
const prompt = process.env.VIBY_ITERATION_PROMPT?.trim();
for (const [name, value] of Object.entries({
  DATABASE_URL: process.env.DATABASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  VIBY_CHAT_ID: chatId,
  VIBY_ITERATION_PROMPT: prompt,
})) {
  if (!value) throw new Error(`${name} is required.`);
}

const skillDirectory = fileURLToPath(new URL("../skills/product", import.meta.url));
const viby = createViby({
  framework: "farm",
  model: openai(process.env.OPENAI_MODEL ?? "gpt-5.6-sol"),
  skills: { product: [skillRead(skillDirectory)] },
});

try {
  const userViby = viby.forUser({
    tenantId: process.env.VIBY_TENANT_ID ?? "demo-tenant",
    userId: process.env.VIBY_USER_ID ?? "demo-user",
  });
  const chat = await userViby.chats.get(chatId!);
  const current = await chat.latestVersion();
  if (!current) throw new Error(`Chat ${chat.id} does not have a source version.`);

  const next = await current.iterate({ prompt: prompt! });
  const artifact = await next.download();
  const outputDirectory = resolve(process.env.VIBY_OUTPUT_DIR ?? "./output");
  await mkdir(outputDirectory, { recursive: true });
  const artifactPath = resolve(outputDirectory, artifact.filename);
  await writeFile(artifactPath, artifact.bytes);

  console.log(JSON.stringify({
    chatId: chat.id,
    previousVersionId: current.id,
    versionId: next.id,
    versionNumber: next.number,
    sourceZip: artifactPath,
  }, null, 2));
} finally {
  await viby.close();
}
