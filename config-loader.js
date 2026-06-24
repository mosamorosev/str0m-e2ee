// =============================================================================
//  Shared config loader for the Node.js apps (client + key-distributor).
//
//  Resolution order (see config.json header for the full contract):
//    1. --config <path>  CLI flag (repeatable; later files override earlier).
//    2. E2EE_CONFIG env var (one path, or os.pathsep-separated list).
//    3. ./config.json, then the repo-root config.json.
//
//  Each file may be SECTIONED (contains a `sfu` / `keyDistributor` / `client`
//  key) or FLAT (the whole file is that app's config). Shared sections
//  (`logging`, `stats`, `diagnostics`) are merged in underneath the app section.
//
//  JSONC is supported: //-line comments, block comments, and trailing commas.
// =============================================================================
"use strict";

const fs = require("fs");
const path = require("path");

const APP_SECTIONS = ["sfu", "keyDistributor", "client"];
const SHARED_SECTIONS = ["logging", "stats", "diagnostics"];

// --- JSONC -> JSON ----------------------------------------------------------
// String-aware comment stripper so that "//" inside URLs (http://...) is safe.
function stripJsonc(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let inStr = false;
  let strCh = "";
  while (i < n) {
    const c = text[i];
    const c2 = i + 1 < n ? text[i + 1] : "";
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += c2;
        i += 2;
        continue;
      }
      if (c === strCh) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      strCh = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && c2 === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseJsonc(text, file) {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new Error(`Failed to parse config "${file}": ${e.message}`);
  }
}

// --- deep merge -------------------------------------------------------------
function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isObject(base)) return override;
  if (!isObject(override)) return override;
  const out = { ...base };
  for (const k of Object.keys(override)) {
    out[k] = isObject(out[k]) && isObject(override[k])
      ? deepMerge(out[k], override[k])
      : override[k];
  }
  return out;
}

// --- path resolution --------------------------------------------------------
function collectConfigFlags(argv) {
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" && i + 1 < argv.length) {
      paths.push(argv[++i]);
    } else if (a.startsWith("--config=")) {
      paths.push(a.slice("--config=".length));
    }
  }
  return paths;
}

function resolveConfigPaths(argv) {
  const flagPaths = collectConfigFlags(argv);
  if (flagPaths.length) return flagPaths;

  if (process.env.E2EE_CONFIG) {
    return process.env.E2EE_CONFIG.split(path.delimiter).filter(Boolean);
  }

  const candidates = [
    path.resolve(process.cwd(), "config.json"),
    path.resolve(__dirname, "config.json"), // repo root (this file's dir)
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  return found ? [found] : [];
}

// --- section extraction -----------------------------------------------------
// If the file declares a known app section, the app's effective config is the
// shared sections merged with that app's section. Otherwise the file is flat
// and used as-is.
function extractForApp(fileCfg, appKey) {
  const hasAppSection = APP_SECTIONS.some((k) => k in fileCfg);
  if (!hasAppSection) {
    return fileCfg; // flat file
  }
  let merged = {};
  for (const s of SHARED_SECTIONS) {
    if (s in fileCfg) merged[s] = fileCfg[s];
  }
  if (isObject(fileCfg[appKey])) {
    merged = deepMerge(merged, fileCfg[appKey]);
  }
  return merged;
}

/**
 * Load the effective configuration for one app.
 * @param {string} appKey  one of "sfu" | "keyDistributor" | "client"
 * @param {object} defaults  built-in defaults (lowest precedence)
 * @param {string[]} argv  defaults to process.argv.slice(2)
 * @returns {{config: object, sources: string[]}}
 */
function loadConfig(appKey, defaults = {}, argv = process.argv.slice(2)) {
  const paths = resolveConfigPaths(argv);
  let config = defaults || {};
  const sources = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (!fs.existsSync(abs)) {
      console.error(`[config] warning: file not found: ${abs}`);
      continue;
    }
    const fileCfg = parseJsonc(fs.readFileSync(abs, "utf8"), abs);
    config = deepMerge(config, extractForApp(fileCfg, appKey));
    sources.push(abs);
  }
  return { config, sources };
}

// Convenience getter: get(cfg, "media.video.width", 640)
function get(obj, dottedPath, fallback) {
  const parts = dottedPath.split(".");
  let cur = obj;
  for (const part of parts) {
    if (!isObject(cur) || !(part in cur)) return fallback;
    cur = cur[part];
  }
  return cur === undefined ? fallback : cur;
}

module.exports = { loadConfig, get, deepMerge, stripJsonc };
