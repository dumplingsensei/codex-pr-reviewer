#!/usr/bin/env node
/**
 * Bundle `plugins/cross-model-advisor/src` into the plugin `dist/`.
 *
 * - Every source module is emitted to `dist/modules/<source-relative-path>`
 *   with in-plugin relative imports preserved and npm dependencies bundled.
 * - Control, worker, auth-control, and setup-control modules are also emitted as
 *   executable entry points at `dist/<name>.mjs`.
 * - Dependencies resolve from this tooling directory via esbuild `nodePaths`.
 *
 * Usage: `npm run build -- [--outdir <dir>]`
 */
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolingRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolingRoot, "../..");
const pluginRoot = path.join(repoRoot, "plugins/cross-model-advisor");
const srcRoot = path.join(pluginRoot, "src");
const nodeModules = path.join(toolingRoot, "node_modules");

const ENTRY_FILES = ["control.mjs", "worker.mjs", "auth-control.mjs", "setup-control.mjs"];

/** Provider factories/catalogs that may appear in a bundle. */
const ALLOWED_PROVIDER_FILES = new Set([
  "openai.js",
  "openai.models.js",
  "anthropic.js",
  "anthropic.models.js",
  "google.js",
  "google.models.js",
  "openrouter.js",
  "openrouter.models.js",
  "openrouter-images.js",
  "openai-codex.js",
  "openai-codex.models.js",
  "github-copilot.js",
  "github-copilot.models.js",
  "zai.js",
  "zai.models.js",
  "xai.js",
  "xai.models.js",
  "moonshotai.js",
  "moonshotai.models.js",
  "kimi-coding.js",
  "kimi-coding.models.js",
  "faux.js",
]);

// pi-ai's public factory loads these private flows through import(variable).
// Resolve only the pinned, explicitly supported implementations into bundles.
const selectedOAuthImports = {
  name: "selected-oauth-imports",
  setup(build) {
    build.onResolve(
      { filter: /^@earendil-works\/pi-ai\/auth\/oauth\/(openai-codex|github-copilot|xai|kimi-coding)$/ },
      ({ path: specifier }) => ({
        path: path.join(nodeModules, "@earendil-works/pi-ai/dist/auth/oauth", `${specifier.split("/").at(-1)}.js`)
      })
    );
  }
};

const DISALLOWED_PATHS = [
  /[/\\]providers[/\\]all\.js$/,
  /[/\\]bedrock-provider\.js$/,
  /[/\\]bun-oauth\.js$/,
  /[/\\]node_modules[/\\]@aws-sdk[/\\]/,
  /[/\\]node_modules[/\\]@modelcontextprotocol[/\\]/,
];

const LICENSE_BASENAMES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "LICENCE",
  "LICENCE.md",
  "LICENCE.txt",
  "COPYING",
  "NOTICE",
];

/**
 * @param {string[]} argv
 * @returns {{ outdir: string }}
 */
function parseArgs(argv) {
  let outdir = path.join(pluginRoot, "dist");
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--outdir" || arg === "--out-dir") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a path`);
      }
      outdir = path.resolve(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--outdir=")) {
      outdir = path.resolve(arg.slice("--outdir=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { outdir };
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listSourceFiles(dir) {
  /** @type {string[]} */
  const files = [];
  /**
   * @param {string} current
   * @param {string} rel
   */
  function walk(current, rel) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const nextAbs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(nextAbs, nextRel);
        continue;
      }
      if (entry.name.endsWith(".mjs") || entry.name.endsWith(".js")) {
        files.push(nextRel);
      }
    }
  }
  walk(dir, "");
  return files.sort();
}

/**
 * @param {string} child
 * @param {string} parent
 */
function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Keep relative imports between plugin source modules so tests can import
 * `dist/modules/<file>` without duplicating sibling graphs.
 *
 * @returns {import("esbuild").Plugin}
 */
function externalLocalSrcPlugin() {
  return {
    name: "external-local-src",
    setup(build) {
      build.onResolve({ filter: /^\.\.?[/\\]/ }, (args) => {
        if (args.kind === "entry-point") {
          return undefined;
        }
        let abs = path.resolve(args.resolveDir, args.path);
        if (!fs.existsSync(abs)) {
          if (fs.existsSync(`${abs}.mjs`)) {
            abs = `${abs}.mjs`;
          } else if (fs.existsSync(`${abs}.js`)) {
            abs = `${abs}.js`;
          } else {
            return undefined;
          }
        }
        const real = fs.realpathSync(abs);
        if (!isInside(real, srcRoot)) {
          return undefined;
        }
        if (!real.endsWith(".mjs") && !real.endsWith(".js")) {
          return undefined;
        }
        return { path: args.path, external: true };
      });
    },
  };
}

/**
 * @param {string} filePath
 */
function posixPath(filePath) {
  return filePath.replaceAll("\\", "/");
}

/**
 * Metafile inputs are relative to absWorkingDir unless already absolute.
 * Resolve them against toolingRoot so `/node_modules/` extraction works.
 *
 * @param {string} input
 */
function canonicalizeInput(input) {
  const asPath = input.split("/").join(path.sep);
  if (path.isAbsolute(asPath)) {
    return path.resolve(asPath);
  }
  return path.resolve(toolingRoot, asPath);
}

/**
 * @param {string} filePath
 */
function isDisallowedAdapter(filePath) {
  const normalized = posixPath(filePath);
  if (DISALLOWED_PATHS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  const provider = normalized.match(/\/pi-ai\/dist\/providers\/([^/]+)$/);
  if (provider && provider[1] !== "data" && !ALLOWED_PROVIDER_FILES.has(provider[1])) {
    return true;
  }
  if (/\/pi-ai\/dist\/oauth\.js$/.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * @param {import("esbuild").Metafile} metafile
 */
function assertSelectedAdapters(metafile) {
  const banned = Object.keys(metafile.inputs)
    .filter((input) => isDisallowedAdapter(canonicalizeInput(input)))
    .sort();
  if (banned.length > 0) {
    throw new Error(
      `Bundle included disallowed adapters (selected direct providers only):\n${banned.join("\n")}`,
    );
  }
}

/**
 * @param {string} input
 * @returns {string | null}
 */
function packageNameFromInput(input) {
  const normalized = posixPath(input);
  const marker = "/node_modules/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) {
    return null;
  }
  const rest = normalized.slice(index + marker.length);
  if (rest.startsWith("@")) {
    const parts = rest.split("/");
    if (parts.length < 2) {
      return null;
    }
    return `${parts[0]}/${parts[1]}`;
  }
  const name = rest.split("/")[0];
  return name || null;
}

/**
 * @param {string} input
 * @param {string} packageName
 */
function packageRootFromInput(input, packageName) {
  const normalized = posixPath(input);
  const needle = `/node_modules/${packageName}`;
  const index = normalized.lastIndexOf(needle);
  if (index === -1) {
    return null;
  }
  const rootPosix = normalized.slice(0, index + needle.length);
  return rootPosix.split("/").join(path.sep);
}

/**
 * @param {string} packageRoot
 */
function readLicenseText(packageRoot) {
  for (const basename of LICENSE_BASENAMES) {
    const candidate = path.join(packageRoot, basename);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return fs.readFileSync(candidate, "utf8").trimEnd();
    }
  }
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (typeof manifest.license === "string" && manifest.license) {
      return `SPDX-License-Identifier: ${manifest.license}\n(no LICENSE file in the published package)`;
    }
  }
  return "License text not found in the published package.";
}

/**
 * @param {string} packageRoot
 */
function readPackageVersion(packageRoot) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    return "unknown";
  }
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}

/**
 * @param {import("esbuild").Metafile[]} metafiles
 */
function collectLicenses(metafiles) {
  /** @type {Map<string, { name: string, version: string, text: string }>} */
  const packages = new Map();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const abs = canonicalizeInput(input);
      const name = packageNameFromInput(abs);
      if (!name || packages.has(name)) {
        continue;
      }
      const root = packageRootFromInput(abs, name);
      if (!root) {
        continue;
      }
      packages.set(name, {
        name,
        version: readPackageVersion(root),
        text: readLicenseText(root),
      });
    }
  }
  const names = [...packages.keys()].sort();
  const blocks = [
    "Third-party licenses for code bundled into plugins/cross-model-advisor/dist.",
    "Generated by tooling/cross-model-advisor/build.mjs. Packages are sorted by name.",
    "",
  ];
  for (const name of names) {
    const entry = packages.get(name);
    if (!entry) {
      continue;
    }
    blocks.push("=".repeat(80));
    blocks.push(`${entry.name}@${entry.version}`);
    blocks.push("-".repeat(80));
    blocks.push(entry.text);
    blocks.push("");
  }
  return `${blocks.join("\n").trimEnd()}\n`;
}

/**
 * @param {{
 *   entryPoints: string[],
 *   outfile: string,
 *   plugins: import("esbuild").Plugin[],
 * }} options
 */
async function bundle(options) {
  const result = await esbuild.build({
    absWorkingDir: toolingRoot,
    entryPoints: options.entryPoints,
    outfile: options.outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    // Bundled CommonJS SDK internals still require Node builtins (Google auth
    // imports child_process). npm dependencies remain bundled in the ESM output.
    banner: { js: 'import { createRequire as __cmaCreateRequire } from "node:module"; const require = __cmaCreateRequire(import.meta.url);' },
    target: "node22",
    packages: "bundle",
    nodePaths: [nodeModules],
    plugins: [selectedOAuthImports, ...options.plugins],
    metafile: true,
    write: true,
    logLevel: "warning",
    legalComments: "none",
    sourcemap: false,
    sourcesContent: false,
    treeShaking: true,
    splitting: false,
    charset: "utf8",
    resolveExtensions: [".mjs", ".js", ".json"],
    mainFields: ["module", "main"],
    conditions: ["node", "import"],
    loader: { ".json": "json" },
  });
  if (!result.metafile) {
    throw new Error(`esbuild produced no metafile for ${options.outfile}`);
  }
  assertSelectedAdapters(result.metafile);
  return result.metafile;
}

async function main() {
  const { outdir } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(srcRoot)) {
    throw new Error(`Missing plugin source directory: ${srcRoot}`);
  }
  const sources = listSourceFiles(srcRoot);
  if (sources.length === 0) {
    throw new Error(`No source modules under ${srcRoot}`);
  }
  for (const entry of ENTRY_FILES) {
    if (!sources.includes(entry)) {
      throw new Error(`Missing executable source ${path.join(srcRoot, entry)}`);
    }
  }
  if (!fs.existsSync(nodeModules)) {
    throw new Error(`Missing ${nodeModules}; run npm ci in ${toolingRoot}`);
  }

  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outdir, "modules"), { recursive: true });

  /** @type {import("esbuild").Metafile[]} */
  const metafiles = [];
  const localPlugin = externalLocalSrcPlugin();

  for (const rel of sources) {
    const outfile = path.join(outdir, "modules", rel);
    fs.mkdirSync(path.dirname(outfile), { recursive: true });
    metafiles.push(
      await bundle({
        entryPoints: [path.join(srcRoot, rel)],
        outfile,
        plugins: [localPlugin],
      }),
    );
  }

  for (const entry of ENTRY_FILES) {
    const outfile = path.join(outdir, entry);
    metafiles.push(
      await bundle({
        entryPoints: [path.join(srcRoot, entry)],
        outfile,
        plugins: [],
      }),
    );
    fs.chmodSync(outfile, 0o755);
  }

  fs.writeFileSync(path.join(outdir, "THIRD_PARTY_LICENSES.txt"), collectLicenses(metafiles));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
