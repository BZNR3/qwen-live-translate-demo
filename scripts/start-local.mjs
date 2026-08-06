import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const python = path.join(root, ".venv", "bin", "python");

if (!existsSync(python)) {
  console.error(".venv is missing. Run npm run local:setup first.");
  process.exit(1);
}

const children = [];
let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 100).unref();
}

function watch(child) {
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(
        `A child service exited unexpectedly (${signal || `exit ${code ?? 1}`}); stopping the other service.`,
      );
      stop(code || 1);
    }
  });
}

async function waitForLocalService() {
  const endpoint =
    process.env.LOCAL_TRANSLATOR_URL || "http://127.0.0.1:8765";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint.replace(/\/$/, "")}/health`);
      if (response.ok) return;
    } catch {
      // The Python process normally needs a moment to import MLX.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The local model service did not become ready within 10 seconds.");
}

const pythonChild = spawn(
  python,
  [path.join(root, "local", "local_server.py")],
  { cwd: root, env: process.env, stdio: "inherit" },
);
children.push(pythonChild);
watch(pythonChild);

try {
  await waitForLocalService();
} catch (error) {
  console.error(error.message);
  stop(1);
}

if (!stopping) {
  const nodeChild = spawn(process.execPath, [path.join(root, "server.mjs")], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  children.push(nodeChild);
  watch(nodeChild);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
