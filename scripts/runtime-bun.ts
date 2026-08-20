const worker = new Worker(
  new URL("../test/fixtures/runtime/core-worker.ts", import.meta.url).href,
  { type: "module" },
);

const result = await new Promise<{
  cursor: string;
  hasToolCalls: boolean;
  skillSource: string;
  title: string;
}>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Portable core Worker timed out.")), 5_000);
  worker.onmessage = (event) => {
    clearTimeout(timeout);
    resolve(event.data);
  };
  worker.onerror = (event) => {
    clearTimeout(timeout);
    reject(event.error ?? new Error(event.message));
  };
});

worker.terminate();
if (
  result.cursor !== "21" ||
  !result.hasToolCalls ||
  result.skillSource !== "inline" ||
  result.title !== "Analytics dashboard"
) {
  throw new Error(`Unexpected portable Worker result: ${JSON.stringify(result)}`);
}
console.log("Verified the published portable core inside a Bun Worker.");
