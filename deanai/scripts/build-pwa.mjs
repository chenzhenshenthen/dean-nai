import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, ".pwa-stage");
const destination = path.join(root, "pwa-dist");
const serviceWorkerBuildToken = "__DEANAI_PWA_BUILD_ID__";

function assertInsideRoot(target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to modify path outside the project: ${target}`);
  }
}

async function removeGenerated(target) {
  assertInsideRoot(target);
  await rm(target, { recursive: true, force: true });
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Command exited with code ${code}`)));
  });
}

await removeGenerated(stage);
await removeGenerated(destination);
await mkdir(stage, { recursive: true });
await symlink(
  path.join(root, "node_modules"),
  path.join(stage, "node_modules"),
  process.platform === "win32" ? "junction" : "dir",
);

for (const directory of ["app", "assets", "components", "lib", "public"]) {
  await cp(path.join(root, directory), path.join(stage, directory), { recursive: true });
}
await removeGenerated(path.join(stage, "app", "api"));
for (const file of ["next-env.d.ts", "package.json", "postcss.config.mjs", "tsconfig.json"]) {
  await cp(path.join(root, file), path.join(stage, file));
}

const basePath = String(process.env.PWA_BASE_PATH || "").replace(/^\/?/, "/").replace(/\/$/, "");
await writeFile(path.join(stage, "next.config.ts"), `
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  basePath: ${JSON.stringify(basePath === "/" ? "" : basePath)},
  images: { unoptimized: true },
  reactStrictMode: true,
  devIndicators: false,
  turbopack: { root: import.meta.dirname },
  webpack(config) {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, "fs/promises": false };
    return config;
  },
};
export default nextConfig;
`, "utf8");

const packageJson = JSON.parse(await readFile(path.join(stage, "package.json"), "utf8"));
packageJson.scripts = { build: "next build" };
await writeFile(path.join(stage, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");

const nextBinary = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "next.cmd" : "next");
try {
  await run(nextBinary, ["build", "--webpack"], {
    cwd: stage,
    env: {
      ...process.env,
      NEXT_PUBLIC_STATIC_PWA: "1",
      NEXT_PUBLIC_BASE_PATH: basePath === "/" ? "" : basePath,
    },
  });
  await cp(path.join(stage, "out"), destination, { recursive: true });
  const buildId = String(process.env.GITHUB_SHA || process.env.PWA_BUILD_ID || Date.now())
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 64);
  const serviceWorkerPath = path.join(destination, "sw.js");
  const serviceWorker = await readFile(serviceWorkerPath, "utf8");
  if (!serviceWorker.includes(serviceWorkerBuildToken)) {
    throw new Error("PWA service worker build token is missing");
  }
  await writeFile(serviceWorkerPath, serviceWorker.replaceAll(serviceWorkerBuildToken, buildId), "utf8");
  console.log(`\nPWA static files: ${destination}`);
} finally {
  await removeGenerated(stage);
}
