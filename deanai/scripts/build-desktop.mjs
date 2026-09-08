import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stage = path.join(root, ".desktop-stage");
const destination = process.env.DEAN_DESKTOP_OUTPUT_DIR
  ? path.resolve(process.env.DEAN_DESKTOP_OUTPUT_DIR)
  : path.join(root, "desktop-web-dist");

function insideRoot(target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function removeGenerated(target) {
  if (!insideRoot(target)) throw new Error(`Refusing to modify path outside project: ${target}`);
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
if (!insideRoot(destination)) throw new Error(`Desktop output must stay inside deanai: ${destination}`);
await removeGenerated(destination);
await mkdir(stage, { recursive: true });
await symlink(path.join(root, "node_modules"), path.join(stage, "node_modules"), process.platform === "win32" ? "junction" : "dir");
for (const directory of ["app", "assets", "components", "lib", "public"]) {
  await cp(path.join(root, directory), path.join(stage, directory), { recursive: true });
}
await removeGenerated(path.join(stage, "app", "api"));
for (const file of ["next-env.d.ts", "package.json", "postcss.config.mjs", "tsconfig.json"]) {
  await cp(path.join(root, file), path.join(stage, file));
}
await writeFile(path.join(stage, "next.config.ts"), `
import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
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
    env: { ...process.env, NEXT_PUBLIC_STATIC_PWA: "0", NEXT_PUBLIC_LOCAL_DESKTOP: "1" },
  });
  await cp(path.join(stage, "out"), destination, { recursive: true });
  console.log(`Desktop web files: ${destination}`);
} finally {
  await removeGenerated(stage);
}
