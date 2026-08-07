import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const { stdout } = await execute("git", ["branch", "--show-current"]);
const branch = stdout.trim();

assert.equal(branch, "main", "releases must be created from the main branch");
console.log("Release branch is main.");
