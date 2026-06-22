import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { defaultBridgeHome } from "./config.mjs";

const STATE_FILE = "desktop-patch-state.json";
const PATCH_SCHEMA_VERSION = 1;
const PATCH_VERSION = 1;
const DEFAULT_CODEX_APP = "/Applications/Codex.app";
const ASAR_RELATIVE_PATH = path.join("Contents", "Resources", "app.asar");
const WIN_ASAR_RELATIVE_PATH = path.join("resources", "app.asar");
const INFO_PLIST_RELATIVE_PATH = path.join("Contents", "Info.plist");
const CODE_SIGNATURE_RELATIVE_PATH = path.join("Contents", "_CodeSignature");
const ROOT_EXECUTABLE_RELATIVE_PATH = path.join("Contents", "MacOS", "Codex");
const WINDOWS_LAUNCHER_NAME = "Codex-DeepSeek.cmd";

const EXACT_PATCHES = [
  {
    before: ",s=i&&e!==`amazonBedrock`;",
    after: ",s=0&&e!==`amazonBedrock`;",
  },
  {
    before: ',s=i&&e!=="amazonBedrock";',
    after: ',s=0&&e!=="amazonBedrock";',
  },
];

const PATCH_NEEDLES = [
  /([,;][A-Za-z_$][\w$]*=)([A-Za-z_$])(&&[A-Za-z_$][\w$]*!==`amazonBedrock`;)/g,
  /([,;][A-Za-z_$][\w$]*=)([A-Za-z_$])(&&[A-Za-z_$][\w$]*!=="amazonBedrock";)/g,
];

const APPLIED_NEEDLES = [
  /[,;][A-Za-z_$][\w$]*=0&&[A-Za-z_$][\w$]*!==`amazonBedrock`;/,
  /[,;][A-Za-z_$][\w$]*=0&&[A-Za-z_$][\w$]*!=="amazonBedrock";/,
];

const HISTORY_PROVIDER_FILTER_BEFORE = "modelProviders:null";
const HISTORY_PROVIDER_FILTER_AFTER = "modelProviders:[]  ";
const PATCH_MODEL_PICKER = "model-picker";
const PATCH_HISTORY_PROVIDER_FILTER = "history-provider-filter";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function patchStatePath(bridgeHome) {
  return path.join(bridgeHome, STATE_FILE);
}

function patchWorkDir(bridgeHome) {
  return path.join(bridgeHome, "desktop-patch");
}

function defaultRunCommand(command, args) {
  execFileSync(command, args, { stdio: "pipe" });
}

function defaultWindowsLocalAppData(env = process.env) {
  return env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Local");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function windowsStoreCodexCandidates(packageRoot) {
  return [path.join(packageRoot, "app"), packageRoot];
}

function latestWindowsSquirrelAppDir(root) {
  try {
    const entries = fs
      .readdirSync(root)
      .filter((entry) => /^app-/i.test(entry))
      .map((entry) => path.join(root, entry))
      .filter((entryPath) => fs.statSync(entryPath).isDirectory());
    entries.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return entries.at(-1) || "";
  } catch {
    return "";
  }
}

function isWindowsCodexRoot(appRoot) {
  return Boolean(appRoot && fs.existsSync(path.join(appRoot, WIN_ASAR_RELATIVE_PATH)));
}

function windowsCodexCandidates(root) {
  if (!root || !fs.existsSync(root)) {
    return [];
  }
  const candidates = [];
  try {
    for (const entry of fs.readdirSync(root)) {
      if (!/\bcodex\b/i.test(entry)) {
        continue;
      }
      const dir = path.join(root, entry);
      try {
        if (!fs.statSync(dir).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
      candidates.push(dir);
      candidates.push(...windowsStoreCodexCandidates(dir));
      const latest = latestWindowsSquirrelAppDir(dir);
      if (latest) {
        candidates.push(latest);
      }
    }
  } catch {
    // Some protected folders, especially WindowsApps, refuse enumeration.
  }
  return candidates;
}

function findWindowsStoreCodexInstalls({ platform = process.platform } = {}) {
  if (platform !== "win32") {
    return [];
  }
  try {
    const stdout = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        [
          "$pkgs = Get-AppxPackage | Where-Object {",
          "$_.Name -match 'Codex' -or $_.PackageFullName -match 'Codex' -or $_.InstallLocation -match 'Codex'",
          "} | Select-Object Name, InstallLocation;",
          "if ($pkgs) { $pkgs | ConvertTo-Json -Compress }",
        ].join(" "),
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (!stdout) {
      return [];
    }
    const parsed = JSON.parse(stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .map((row) => ({
        name: String(row?.Name || ""),
        installLocation: row?.InstallLocation ? String(row.InstallLocation) : "",
      }))
      .filter((row) => row.name || row.installLocation);
  } catch {
    return [];
  }
}

function resolveWindowsCodexApp({ env = process.env, appBundlePath = "", platform = process.platform } = {}) {
  if (env.DSCB_CODEX_APP || appBundlePath) {
    return path.resolve(env.DSCB_CODEX_APP || appBundlePath);
  }

  const local = defaultWindowsLocalAppData(env);
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [];

  if (local) {
    candidates.push(
      path.join(local, "Programs", "Codex"),
      path.join(local, "Programs", "Codex Beta"),
      path.join(local, "Programs", "Codex (Beta)"),
      path.join(local, "Codex"),
      path.join(local, "codex"),
      ...windowsCodexCandidates(local),
      ...windowsCodexCandidates(path.join(local, "Programs")),
    );
  }
  for (const root of [programFiles, programFilesX86]) {
    candidates.push(
      path.join(root, "Codex"),
      path.join(root, "Codex Beta"),
      path.join(root, "Codex (Beta)"),
      ...windowsCodexCandidates(root),
      ...windowsCodexCandidates(path.join(root, "WindowsApps")),
    );
  }
  for (const storeInstall of findWindowsStoreCodexInstalls({ platform })) {
    if (storeInstall.installLocation) {
      candidates.push(...windowsStoreCodexCandidates(storeInstall.installLocation));
    }
  }

  return unique(candidates).find(isWindowsCodexRoot) || "";
}

function resolveCodexApp({ env = process.env, appBundlePath = "", platform = process.platform } = {}) {
  if (platform === "win32") {
    return resolveWindowsCodexApp({ env, appBundlePath, platform });
  }
  return path.resolve(env.DSCB_CODEX_APP || appBundlePath || DEFAULT_CODEX_APP);
}

function resolveAppAsar({ env = process.env, appAsarPath = "", appBundlePath = "", platform = process.platform, state = null } = {}) {
  if (env.DSCB_CODEX_APP_ASAR || appAsarPath) {
    return path.resolve(env.DSCB_CODEX_APP_ASAR || appAsarPath);
  }
  if (state?.active && state.appAsarPath && fs.existsSync(state.appAsarPath)) {
    return path.resolve(state.appAsarPath);
  }
  if (platform === "win32") {
    const appRoot = resolveCodexApp({ env, appBundlePath, platform });
    return appRoot ? path.join(appRoot, WIN_ASAR_RELATIVE_PATH) : "";
  }
  return path.join(resolveCodexApp({ env, appBundlePath, platform }), ASAR_RELATIVE_PATH);
}

function appBundleFromAsar(appAsarPath) {
  const resolved = path.resolve(appAsarPath);
  const resourcesDir = path.dirname(resolved);
  const contentsDir = path.dirname(resourcesDir);
  if (
    path.basename(resolved).toLowerCase() === "app.asar" &&
    path.basename(resourcesDir).toLowerCase() === "resources" &&
    path.basename(contentsDir) !== "Contents"
  ) {
    return path.dirname(resourcesDir);
  }
  if (path.basename(resolved) !== "app.asar" || path.basename(resourcesDir) !== "Resources") {
    return "";
  }
  if (path.basename(contentsDir) !== "Contents") {
    return "";
  }
  return path.dirname(contentsDir);
}

function inspectMacCodeSignature(appBundlePath, platform) {
  if (platform !== "darwin" || !appBundlePath || !fs.existsSync(appBundlePath)) {
    return null;
  }
  try {
    const result = spawnSync("codesign", ["-dv", appBundlePath], { encoding: "utf8" });
    const text = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (!text.trim()) {
      return null;
    }
    const signature = text.match(/^Signature=(.+)$/m)?.[1]?.trim() || "";
    const teamIdentifier = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || "";
    return {
      signature,
      teamIdentifier,
      adhoc: signature === "adhoc" || /flags=.*\badhoc\b/.test(text),
    };
  } catch {
    return null;
  }
}

function readAsarHeader(appAsarPath) {
  const fd = fs.openSync(appAsarPath, "r");
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, prefix.length, 0);
    const headerJsonSize = prefix.readUInt32LE(12);
    if (!Number.isFinite(headerJsonSize) || headerJsonSize <= 0) {
      throw new Error("Invalid ASAR header size.");
    }
    const headerBytes = Buffer.alloc(headerJsonSize);
    fs.readSync(fd, headerBytes, 0, headerJsonSize, 16);
    const headerText = headerBytes.toString("utf8");
    return {
      headerJsonSize,
      headerBytes,
      headerText,
      header: JSON.parse(headerText),
      filesOffset: 16 + headerJsonSize,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function listAsarFiles(header) {
  const out = [];
  function walk(node, parts) {
    if (!node || typeof node !== "object") return;
    if (node.files && typeof node.files === "object") {
      for (const [name, child] of Object.entries(node.files)) {
        walk(child, [...parts, name]);
      }
      return;
    }
    if (typeof node.offset === "string" && typeof node.size === "number") {
      out.push({ path: parts.join("/"), entry: node });
    }
  }
  walk(header, []);
  return out;
}

function readAsarEntry(appAsarPath, filesOffset, entry) {
  const fd = fs.openSync(appAsarPath, "r");
  try {
    const offset = filesOffset + Number(entry.offset);
    const bytes = Buffer.alloc(entry.size);
    fs.readSync(fd, bytes, 0, bytes.length, offset);
    return { offset, bytes };
  } finally {
    fs.closeSync(fd);
  }
}

function replaceOnce(text) {
  for (const exact of EXACT_PATCHES) {
    if (text.includes(exact.after)) {
      return { state: "patched", text };
    }
    const count = text.split(exact.before).length - 1;
    if (count === 1) {
      return { state: "patchable", text: text.replace(exact.before, exact.after) };
    }
    if (count > 1) {
      return { state: "ambiguous" };
    }
  }

  if (APPLIED_NEEDLES.some((needle) => needle.test(text))) {
    return { state: "patched", text };
  }

  for (const needle of PATCH_NEEDLES) {
    const matches = [...text.matchAll(needle)];
    if (matches.length === 1) {
      const patched = text.replace(needle, (_match, prefix, _gateVariable, suffix) => `${prefix}0${suffix}`);
      return { state: "patchable", text: patched };
    }
    if (matches.length > 1) {
      return { state: "ambiguous" };
    }
  }

  return { state: "missing" };
}

function patchModelPickerContent(bytes) {
  const text = bytes.toString("utf8");
  if (!text.includes("availableModels") || !text.includes("useHiddenModels") || !text.includes("amazonBedrock")) {
    return { state: "missing" };
  }
  const result = replaceOnce(text);
  if (result.state !== "patchable") {
    return result;
  }
  const patched = Buffer.from(result.text, "utf8");
  if (patched.length !== bytes.length) {
    return { state: "unsafe-size-change" };
  }
  return { state: "patchable", bytes: patched };
}

function patchHistoryProviderFilterContent(bytes) {
  const text = bytes.toString("utf8");
  if (text.includes(HISTORY_PROVIDER_FILTER_AFTER)) {
    return { state: "patched" };
  }
  const count = text.split(HISTORY_PROVIDER_FILTER_BEFORE).length - 1;
  if (count === 0) {
    return { state: "missing" };
  }
  const patched = Buffer.from(text.replaceAll(HISTORY_PROVIDER_FILTER_BEFORE, HISTORY_PROVIDER_FILTER_AFTER), "utf8");
  if (patched.length !== bytes.length) {
    return { state: "unsafe-size-change" };
  }
  return { state: "patchable", bytes: patched, count };
}

function patchFileContent(bytes) {
  let current = bytes;
  const patchNames = [];
  const alreadyPatchNames = [];

  const modelPicker = patchModelPickerContent(current);
  if (modelPicker.state === "patchable") {
    current = modelPicker.bytes;
    patchNames.push(PATCH_MODEL_PICKER);
  } else if (modelPicker.state === "patched") {
    alreadyPatchNames.push(PATCH_MODEL_PICKER);
  } else if (modelPicker.state === "ambiguous" || modelPicker.state === "unsafe-size-change") {
    return modelPicker;
  }

  const historyProviderFilter = patchHistoryProviderFilterContent(current);
  if (historyProviderFilter.state === "patchable") {
    current = historyProviderFilter.bytes;
    patchNames.push(PATCH_HISTORY_PROVIDER_FILTER);
  } else if (historyProviderFilter.state === "patched") {
    alreadyPatchNames.push(PATCH_HISTORY_PROVIDER_FILTER);
  } else if (historyProviderFilter.state === "unsafe-size-change") {
    return historyProviderFilter;
  }

  if (patchNames.length) {
    return { state: "patchable", bytes: current, patchNames, alreadyPatchNames };
  }
  if (alreadyPatchNames.length) {
    return { state: "patched", patchNames: alreadyPatchNames, alreadyPatchNames };
  }
  return { state: "missing" };
}

function updateEntryIntegrity(entry, bytes) {
  if (!entry.integrity || typeof entry.integrity !== "object") {
    return;
  }
  const blockSize = Number(entry.integrity.blockSize || 4194304);
  const blocks = [];
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    blocks.push(sha256(bytes.subarray(offset, offset + blockSize)));
  }
  if (!blocks.length) {
    blocks.push(sha256(Buffer.alloc(0)));
  }
  entry.integrity.algorithm = entry.integrity.algorithm || "SHA256";
  entry.integrity.hash = sha256(bytes);
  entry.integrity.blocks = blocks;
}

function candidateAsarFiles(files) {
  const preferred = files.filter((file) => /^webview\/assets\/model-list-filter-.*\.js$/.test(file.path));
  if (preferred.length) {
    return preferred;
  }
  return files.filter((file) => file.path.startsWith("webview/assets/") && file.path.endsWith(".js") && file.entry.size <= 20000);
}

function patchCandidateAsarFiles(files) {
  const preferred = candidateAsarFiles(files);
  const seen = new Set(preferred.map((file) => file.path));
  const jsFiles = files.filter((file) => file.path.endsWith(".js") && !seen.has(file.path));
  return [...preferred, ...jsFiles];
}

function findPatchTarget(appAsarPath, asar) {
  let ambiguous = false;
  let modelPickerSeen = false;
  let filePath = "";
  const patchNames = new Set();
  const targets = [];
  const files = patchCandidateAsarFiles(listAsarFiles(asar.header));

  for (const file of files) {
    const { offset, bytes } = readAsarEntry(appAsarPath, asar.filesOffset, file.entry);
    const result = patchFileContent(bytes);
    const names = [...(result.patchNames || []), ...(result.alreadyPatchNames || [])];
    if (names.includes(PATCH_MODEL_PICKER)) {
      modelPickerSeen = true;
      filePath ||= file.path;
    }
    for (const name of names) {
      patchNames.add(name);
    }
    if (result.state === "patched") {
      continue;
    }
    if (result.state === "patchable") {
      targets.push({
        filePath: file.path,
        entry: file.entry,
        offset,
        patchedBytes: result.bytes,
        patchNames: result.patchNames || [],
      });
      filePath ||= file.path;
      continue;
    }
    if (result.state === "ambiguous" || result.state === "unsafe-size-change") {
      ambiguous = true;
    }
  }

  if (ambiguous && !modelPickerSeen) {
    return { status: "ambiguous" };
  }
  if (!modelPickerSeen) {
    return { status: "target-not-found" };
  }
  if (targets.length) {
    return {
      status: "patchable",
      filePath,
      filePaths: targets.map((target) => target.filePath),
      targets,
      patchNames: [...patchNames],
    };
  }
  return { status: "patched", filePath, patchNames: [...patchNames] };
}

function writePatchedAsar(appAsarPath, asar, target) {
  const targets = target.targets || [target];
  for (const patchTarget of targets) {
    updateEntryIntegrity(patchTarget.entry, patchTarget.patchedBytes);
  }
  const newHeaderText = JSON.stringify(asar.header);
  const newHeaderBytes = Buffer.from(newHeaderText, "utf8");
  if (newHeaderBytes.length !== asar.headerBytes.length) {
    throw new Error("ASAR header length changed; refusing to patch in place.");
  }

  const fd = fs.openSync(appAsarPath, "r+");
  try {
    fs.writeSync(fd, newHeaderBytes, 0, newHeaderBytes.length, 16);
    for (const patchTarget of targets) {
      fs.writeSync(fd, patchTarget.patchedBytes, 0, patchTarget.patchedBytes.length, patchTarget.offset);
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    headerHash: sha256(newHeaderBytes),
    fileHash: sha256(targets[0].patchedBytes),
    fileHashes: Object.fromEntries(targets.map((patchTarget) => [patchTarget.filePath, sha256(patchTarget.patchedBytes)])),
  };
}

function updateInfoPlistIntegrity({ infoPlistPath, headerHash, runCommand = defaultRunCommand }) {
  runCommand("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}`,
    infoPlistPath,
  ]);
}

function signCodexApp({ appBundlePath, runCommand = defaultRunCommand }) {
  runCommand("codesign", ["--force", "--sign", "-", appBundlePath]);
}

function verifyCodexApp({ appBundlePath, runCommand = defaultRunCommand }) {
  try {
    runCommand("codesign", ["--verify", "--deep", "--strict", "--verbose=1", appBundlePath]);
    return true;
  } catch {
    return false;
  }
}

function copyFileBackup(source, backup) {
  ensureDir(path.dirname(backup));
  fs.copyFileSync(source, backup);
}

function copyDirBackup(source, backup) {
  ensureDir(path.dirname(backup));
  fs.rmSync(backup, { recursive: true, force: true });
  fs.cpSync(source, backup, { recursive: true });
}

function backupPaths(bridgeHome, originalHash) {
  const dir = patchWorkDir(bridgeHome);
  const stamp = timestamp();
  const shortHash = String(originalHash || "unknown").slice(0, 12);
  return {
    appAsarBackupPath: path.join(dir, `app.asar.${shortHash}.${stamp}.bak`),
    infoPlistBackupPath: path.join(dir, `Info.plist.${shortHash}.${stamp}.bak`),
    codeSignatureBackupPath: path.join(dir, `_CodeSignature.${shortHash}.${stamp}.bak`),
    rootExecutableBackupPath: path.join(dir, `Codex.${shortHash}.${stamp}.bak`),
  };
}

function normalizedWindowsPath(value) {
  return `${String(value || "").replace(/\//g, "\\")}\\`;
}

function isWindowsAppsPath(value) {
  return /\\WindowsApps\\/i.test(normalizedWindowsPath(value));
}

function mirrorDirectory(source, target) {
  ensureDir(path.dirname(target));
  if (process.platform === "win32") {
    try {
      const result = execFileSync("robocopy.exe", [source, target, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"], {
        stdio: "ignore",
      });
      if (typeof result?.status !== "number" || result.status <= 7) {
        return;
      }
    } catch (error) {
      if (typeof error?.status === "number" && error.status <= 7) {
        return;
      }
    }
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}

function findWindowsExecutable(appRoot) {
  try {
    const exe = fs.readdirSync(appRoot).find((name) => /\.exe$/i.test(name) && /\bcodex\b/i.test(name));
    if (exe) {
      return path.join(appRoot, exe);
    }
  } catch {
    // Fall through to the conventional name.
  }
  return path.join(appRoot, "Codex.exe");
}

function createWindowsLauncher({ appRoot, bridgeHome }) {
  const executable = findWindowsExecutable(appRoot);
  const launcherDir = path.join(patchWorkDir(bridgeHome), "launchers");
  ensureDir(launcherDir);
  const launcherPath = path.join(launcherDir, WINDOWS_LAUNCHER_NAME);
  fs.writeFileSync(launcherPath, `@echo off\r\nstart "" "${executable}" %*\r\n`, "utf8");
  return launcherPath;
}

function ensureWindowsManagedCopy({ appBundlePath, bridgeHome }) {
  if (!isWindowsAppsPath(appBundlePath)) {
    return null;
  }
  const sourceRoot =
    path.basename(appBundlePath).toLowerCase() === "app" ? appBundlePath : path.join(appBundlePath, "app");
  const sourceAppRoot = isWindowsCodexRoot(sourceRoot) ? sourceRoot : appBundlePath;
  if (!isWindowsCodexRoot(sourceAppRoot)) {
    return null;
  }

  const packageRoot = path.dirname(sourceAppRoot);
  const packageName = path.basename(packageRoot).replace(/[^A-Za-z0-9_.-]/g, "_") || "Codex";
  const managedAppRoot = path.join(patchWorkDir(bridgeHome), "windows-store-apps", packageName, "app");
  mirrorDirectory(sourceAppRoot, managedAppRoot);
  return {
    appBundlePath: managedAppRoot,
    appAsarPath: path.join(managedAppRoot, WIN_ASAR_RELATIVE_PATH),
    sourceAppBundlePath: sourceAppRoot,
    managedCopy: true,
    launcherPath: createWindowsLauncher({ appRoot: managedAppRoot, bridgeHome }),
  };
}

function restoreBackups({ appAsarPath, infoPlistPath, codeSignaturePath, rootExecutablePath, state }) {
  if (state?.appAsarBackupPath && fs.existsSync(state.appAsarBackupPath)) {
    fs.copyFileSync(state.appAsarBackupPath, appAsarPath);
  }
  if (state?.infoPlistBackupPath && fs.existsSync(state.infoPlistBackupPath)) {
    fs.copyFileSync(state.infoPlistBackupPath, infoPlistPath);
  }
  if (state?.codeSignatureBackupPath && fs.existsSync(state.codeSignatureBackupPath)) {
    fs.rmSync(codeSignaturePath, { recursive: true, force: true });
    fs.cpSync(state.codeSignatureBackupPath, codeSignaturePath, { recursive: true });
  }
  if (rootExecutablePath && state?.rootExecutableBackupPath && fs.existsSync(state.rootExecutableBackupPath)) {
    fs.copyFileSync(state.rootExecutableBackupPath, rootExecutablePath);
  }
}

function tryRestoreBackups(args) {
  try {
    restoreBackups(args);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function patchFailure(error, restoreReason = "") {
  return {
    status: "error",
    reason: error instanceof Error ? error.message : String(error),
    errorCode: error?.code || "",
    restoreReason,
  };
}

export function inspectCodexDesktopPatch({
  env = process.env,
  bridgeHome = defaultBridgeHome(env),
  appAsarPath = "",
  appBundlePath = "",
  platform = process.platform,
} = {}) {
  if (env.DSCB_DESKTOP_PATCH === "off") {
    return { status: "disabled" };
  }
  const state = readJson(patchStatePath(bridgeHome));
  const resolvedAsar = resolveAppAsar({ env, appAsarPath, appBundlePath, platform, state });
  const resolvedBundle = appBundleFromAsar(resolvedAsar) || resolveCodexApp({ env, appBundlePath, platform }) || state?.appBundlePath || "";
  const macCodeSignature = inspectMacCodeSignature(resolvedBundle, platform);

  if (platform !== "darwin" && platform !== "win32" && !appAsarPath && !env.DSCB_CODEX_APP_ASAR) {
    return { status: "unsupported", appAsarPath: resolvedAsar, appBundlePath: resolvedBundle, state };
  }
  if (!resolvedAsar || !fs.existsSync(resolvedAsar)) {
    return { status: "missing", appAsarPath: resolvedAsar, appBundlePath: resolvedBundle, state };
  }

  try {
    const asar = readAsarHeader(resolvedAsar);
    const target = findPatchTarget(resolvedAsar, asar);
    return {
      status: target.status,
      appAsarPath: resolvedAsar,
      appBundlePath: resolvedBundle,
      filePath: target.filePath || "",
      managedBackup: Boolean(state?.active && state?.appAsarBackupPath && fs.existsSync(state.appAsarBackupPath)),
      managedCopy: Boolean(state?.managedCopy),
      launcherPath: state?.launcherPath || "",
      macCodeSignature,
      state,
    };
  } catch (error) {
    return {
      status: "error",
      appAsarPath: resolvedAsar,
      appBundlePath: resolvedBundle,
      reason: error instanceof Error ? error.message : String(error),
      macCodeSignature,
      state,
    };
  }
}

export function patchAsarModelPicker(appAsarPath) {
  const asar = readAsarHeader(appAsarPath);
  const target = findPatchTarget(appAsarPath, asar);
  if (target.status !== "patchable") {
    return { status: target.status, filePath: target.filePath || "" };
  }
  const beforeHeaderHash = sha256(asar.headerBytes);
  const hashes = writePatchedAsar(appAsarPath, asar, target);
  return {
    status: "patched",
    filePath: target.filePath,
    filePaths: target.filePaths || [target.filePath].filter(Boolean),
    patchNames: target.patchNames || [],
    beforeHeaderHash,
    headerHash: hashes.headerHash,
    fileHash: hashes.fileHash,
    fileHashes: hashes.fileHashes,
  };
}

export function patchCodexDesktop({
  env = process.env,
  bridgeHome = defaultBridgeHome(env),
  appAsarPath = "",
  appBundlePath = "",
  runCommand = defaultRunCommand,
  platform = process.platform,
} = {}) {
  if (env.DSCB_DESKTOP_PATCH === "off") {
    return { status: "disabled" };
  }
  const priorState = readJson(patchStatePath(bridgeHome));
  let resolvedAsar = resolveAppAsar({ env, appAsarPath, appBundlePath, platform, state: priorState });
  let resolvedBundle =
    appBundleFromAsar(resolvedAsar) || resolveCodexApp({ env, appBundlePath, platform }) || priorState?.appBundlePath || "";
  let sourceAppBundlePath = "";
  let managedCopy = false;
  let launcherPath = "";

  if (platform === "win32" && resolvedBundle && isWindowsAppsPath(resolvedBundle)) {
    try {
      const managed = ensureWindowsManagedCopy({ appBundlePath: resolvedBundle, bridgeHome });
      if (managed) {
        sourceAppBundlePath = managed.sourceAppBundlePath;
        resolvedBundle = managed.appBundlePath;
        resolvedAsar = managed.appAsarPath;
        managedCopy = true;
        launcherPath = managed.launcherPath;
      }
    } catch (error) {
      return {
        status: "error",
        appAsarPath: resolvedAsar,
        appBundlePath: resolvedBundle,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const infoPlistPath = path.join(resolvedBundle, INFO_PLIST_RELATIVE_PATH);
  const codeSignaturePath = path.join(resolvedBundle, CODE_SIGNATURE_RELATIVE_PATH);
  const rootExecutablePath = path.join(resolvedBundle, ROOT_EXECUTABLE_RELATIVE_PATH);

  if (platform !== "darwin" && platform !== "win32" && !appAsarPath && !env.DSCB_CODEX_APP_ASAR) {
    return { status: "unsupported", appAsarPath: resolvedAsar, appBundlePath: resolvedBundle };
  }
  if (!resolvedAsar || !fs.existsSync(resolvedAsar)) {
    return { status: "missing", appAsarPath: resolvedAsar, appBundlePath: resolvedBundle };
  }

  let asar;
  let target;
  try {
    asar = readAsarHeader(resolvedAsar);
    target = findPatchTarget(resolvedAsar, asar);
  } catch (error) {
    return { status: "error", appAsarPath: resolvedAsar, reason: error instanceof Error ? error.message : String(error) };
  }

  if (target.status === "patched") {
    return {
      status: "already-patched",
      appAsarPath: resolvedAsar,
      appBundlePath: resolvedBundle,
      filePath: target.filePath,
      filePaths: target.filePaths || [target.filePath].filter(Boolean),
      patchNames: target.patchNames || [],
      managedCopy: Boolean(priorState?.managedCopy || managedCopy),
      launcherPath: priorState?.launcherPath || launcherPath,
    };
  }
  if (target.status !== "patchable") {
    return { status: target.status, appAsarPath: resolvedAsar, appBundlePath: resolvedBundle };
  }

  if (platform === "win32") {
    try {
      fs.accessSync(resolvedAsar, fs.constants.W_OK);
    } catch (error) {
      return {
        status: "not-writable",
        appAsarPath: resolvedAsar,
        appBundlePath: resolvedBundle,
        accessErrorCode: error?.code || "",
      };
    }

    const beforeHeaderHash = sha256(asar.headerBytes);
    const originalAsarSha256 = sha256File(resolvedAsar);
    const backups =
      priorState?.originalAsarSha256 === originalAsarSha256 &&
      priorState?.appAsarBackupPath &&
      fs.existsSync(priorState.appAsarBackupPath)
        ? { appAsarBackupPath: priorState.appAsarBackupPath }
        : backupPaths(bridgeHome, originalAsarSha256);

    try {
      if (!fs.existsSync(backups.appAsarBackupPath)) {
        copyFileBackup(resolvedAsar, backups.appAsarBackupPath);
      }
      const hashes = writePatchedAsar(resolvedAsar, asar, target);
      const state = {
        stateSchemaVersion: PATCH_SCHEMA_VERSION,
        patchVersion: PATCH_VERSION,
        platform: "win32",
        active: true,
        appBundlePath: resolvedBundle,
        sourceAppBundlePath,
        appAsarPath: resolvedAsar,
        appAsarBackupPath: backups.appAsarBackupPath,
        managedCopy,
        launcherPath,
        patchedFilePath: target.filePath,
        patchedFilePaths: target.filePaths || [target.filePath].filter(Boolean),
        patchNames: target.patchNames || [],
        originalAsarSha256,
        patchedAsarSha256: sha256File(resolvedAsar),
        originalHeaderHash: beforeHeaderHash,
        patchedHeaderHash: hashes.headerHash,
        codesignVerified: null,
        patchedAt: new Date().toISOString(),
      };
      writeJson(patchStatePath(bridgeHome), state);
      return { status: "patched", ...state };
    } catch (error) {
      const restoreReason = tryRestoreBackups({
        appAsarPath: resolvedAsar,
        state: { appAsarBackupPath: backups.appAsarBackupPath },
      });
      return {
        ...patchFailure(error, restoreReason),
        appAsarPath: resolvedAsar,
        appBundlePath: resolvedBundle,
      };
    }
  }

  if (!fs.existsSync(infoPlistPath)) {
    return { status: "missing-info-plist", appAsarPath: resolvedAsar, infoPlistPath };
  }
  if (!fs.existsSync(codeSignaturePath)) {
    return { status: "missing-code-signature", appAsarPath: resolvedAsar, codeSignaturePath };
  }
  if (!fs.existsSync(rootExecutablePath)) {
    return { status: "missing-root-executable", appAsarPath: resolvedAsar, rootExecutablePath };
  }

  try {
    fs.accessSync(resolvedAsar, fs.constants.W_OK);
    fs.accessSync(infoPlistPath, fs.constants.W_OK);
    fs.accessSync(rootExecutablePath, fs.constants.W_OK);
  } catch (error) {
    return {
      status: "not-writable",
      appAsarPath: resolvedAsar,
      appBundlePath: resolvedBundle,
      accessErrorCode: error?.code || "",
    };
  }

  const beforeHeaderHash = sha256(asar.headerBytes);
  const originalAsarSha256 = sha256File(resolvedAsar);
  const backups =
    priorState?.originalAsarSha256 === originalAsarSha256 &&
    priorState?.appAsarBackupPath &&
    fs.existsSync(priorState.appAsarBackupPath)
      ? {
        appAsarBackupPath: priorState.appAsarBackupPath,
        infoPlistBackupPath: priorState.infoPlistBackupPath,
        codeSignatureBackupPath: priorState.codeSignatureBackupPath,
        rootExecutableBackupPath: priorState.rootExecutableBackupPath,
      }
      : backupPaths(bridgeHome, originalAsarSha256);
  if (!backups.infoPlistBackupPath || !backups.codeSignatureBackupPath || !backups.rootExecutableBackupPath) {
    const fresh = backupPaths(bridgeHome, originalAsarSha256);
    backups.infoPlistBackupPath ||= fresh.infoPlistBackupPath;
    backups.codeSignatureBackupPath ||= fresh.codeSignatureBackupPath;
    backups.rootExecutableBackupPath ||= fresh.rootExecutableBackupPath;
  }

  try {
    if (!fs.existsSync(backups.appAsarBackupPath)) {
      copyFileBackup(resolvedAsar, backups.appAsarBackupPath);
    }
    if (!backups.infoPlistBackupPath || !fs.existsSync(backups.infoPlistBackupPath)) {
      copyFileBackup(infoPlistPath, backups.infoPlistBackupPath);
    }
    if (!backups.codeSignatureBackupPath || !fs.existsSync(backups.codeSignatureBackupPath)) {
      copyDirBackup(codeSignaturePath, backups.codeSignatureBackupPath);
    }
    if (!backups.rootExecutableBackupPath || !fs.existsSync(backups.rootExecutableBackupPath)) {
      copyFileBackup(rootExecutablePath, backups.rootExecutableBackupPath);
    }

    const hashes = writePatchedAsar(resolvedAsar, asar, target);
    updateInfoPlistIntegrity({ infoPlistPath, headerHash: hashes.headerHash, runCommand });
    signCodexApp({ appBundlePath: resolvedBundle, runCommand });

    const state = {
      stateSchemaVersion: PATCH_SCHEMA_VERSION,
      patchVersion: PATCH_VERSION,
      active: true,
      appBundlePath: resolvedBundle,
      appAsarPath: resolvedAsar,
      infoPlistPath,
      codeSignaturePath,
      rootExecutablePath,
      appAsarBackupPath: backups.appAsarBackupPath,
      infoPlistBackupPath: backups.infoPlistBackupPath,
      codeSignatureBackupPath: backups.codeSignatureBackupPath,
      rootExecutableBackupPath: backups.rootExecutableBackupPath,
      patchedFilePath: target.filePath,
      patchedFilePaths: target.filePaths || [target.filePath].filter(Boolean),
      patchNames: target.patchNames || [],
      originalAsarSha256,
      patchedAsarSha256: sha256File(resolvedAsar),
      originalHeaderHash: beforeHeaderHash,
      patchedHeaderHash: hashes.headerHash,
      codesignVerified: verifyCodexApp({ appBundlePath: resolvedBundle, runCommand }),
      patchedAt: new Date().toISOString(),
    };
    writeJson(patchStatePath(bridgeHome), state);
    return { status: "patched", ...state };
  } catch (error) {
    const restoreReason = tryRestoreBackups({
      appAsarPath: resolvedAsar,
      infoPlistPath,
      codeSignaturePath,
      rootExecutablePath,
      state: {
        appAsarBackupPath: backups.appAsarBackupPath,
        infoPlistBackupPath: backups.infoPlistBackupPath,
        codeSignatureBackupPath: backups.codeSignatureBackupPath,
        rootExecutableBackupPath: backups.rootExecutableBackupPath,
      },
    });
    return {
      ...patchFailure(error, restoreReason),
      appAsarPath: resolvedAsar,
      appBundlePath: resolvedBundle,
    };
  }
}

export function restoreCodexDesktopPatch({
  env = process.env,
  bridgeHome = defaultBridgeHome(env),
  appAsarPath = "",
  runCommand = defaultRunCommand,
  platform = process.platform,
} = {}) {
  const statePath = patchStatePath(bridgeHome);
  const state = readJson(statePath);
  if (!state) {
    return { changed: false, status: "not-managed" };
  }

  const statePlatform = state.platform || (state.infoPlistPath ? "darwin" : platform);
  const resolvedAsar = path.resolve(appAsarPath || state.appAsarPath || resolveAppAsar({ env, platform: statePlatform, state }));
  const resolvedBundle = appBundleFromAsar(resolvedAsar) || state.appBundlePath || resolveCodexApp({ env, platform: statePlatform });
  const infoPlistPath = state.infoPlistPath || path.join(resolvedBundle, INFO_PLIST_RELATIVE_PATH);
  const codeSignaturePath = state.codeSignaturePath || path.join(resolvedBundle, CODE_SIGNATURE_RELATIVE_PATH);
  const rootExecutablePath = state.rootExecutablePath || path.join(resolvedBundle, ROOT_EXECUTABLE_RELATIVE_PATH);

  if (statePlatform === "win32") {
    if (!state.active) {
      return { changed: false, status: "not-managed" };
    }
    if (state.managedCopy) {
      const preRestoreBackupPath = fs.existsSync(resolvedAsar)
        ? path.join(patchWorkDir(bridgeHome), `app.asar.pre-restore.${timestamp()}.bak`)
        : "";
      if (preRestoreBackupPath) {
        ensureDir(path.dirname(preRestoreBackupPath));
        fs.copyFileSync(resolvedAsar, preRestoreBackupPath);
      }
      if (state.appBundlePath) {
        fs.rmSync(state.appBundlePath, { recursive: true, force: true });
      }
      if (state.launcherPath) {
        fs.rmSync(state.launcherPath, { force: true });
      }
      writeJson(statePath, {
        ...state,
        active: false,
        restoredAt: new Date().toISOString(),
        preRestoreBackupPath,
      });
      return {
        changed: true,
        status: "restored",
        appAsarPath: resolvedAsar,
        appBundlePath: resolvedBundle,
        preRestoreBackupPath,
      };
    }
    if (!state.appAsarBackupPath || !fs.existsSync(state.appAsarBackupPath)) {
      return { changed: false, status: "missing-backup", appAsarPath: resolvedAsar };
    }
    if (fs.existsSync(resolvedAsar) && state.patchedAsarSha256 && sha256File(resolvedAsar) !== state.patchedAsarSha256) {
      return {
        changed: false,
        status: "app-changed",
        appAsarPath: resolvedAsar,
        appBundlePath: resolvedBundle,
      };
    }
    const preRestoreBackupPath = path.join(patchWorkDir(bridgeHome), `app.asar.pre-restore.${timestamp()}.bak`);
    ensureDir(path.dirname(preRestoreBackupPath));
    if (fs.existsSync(resolvedAsar)) {
      fs.copyFileSync(resolvedAsar, preRestoreBackupPath);
    }
    fs.copyFileSync(state.appAsarBackupPath, resolvedAsar);
    if (state.launcherPath) {
      fs.rmSync(state.launcherPath, { force: true });
    }
    writeJson(statePath, {
      ...state,
      active: false,
      restoredAt: new Date().toISOString(),
      preRestoreBackupPath,
    });
    return {
      changed: true,
      status: "restored",
      appAsarPath: resolvedAsar,
      appBundlePath: resolvedBundle,
      preRestoreBackupPath,
    };
  }

  if (!state.active) {
    if (state.restoreCodesignVerified !== false) {
      return { changed: false, status: "not-managed" };
    }
    try {
      const verifiedBeforeRepair = verifyCodexApp({ appBundlePath: resolvedBundle, runCommand });
      let restoreCodesignVerified = verifiedBeforeRepair;
      if (!restoreCodesignVerified) {
        signCodexApp({ appBundlePath: resolvedBundle, runCommand });
        restoreCodesignVerified = verifyCodexApp({ appBundlePath: resolvedBundle, runCommand });
      }
      writeJson(statePath, {
        ...state,
        restoreCodesignVerified,
        signatureRepairedAt: restoreCodesignVerified ? new Date().toISOString() : state.signatureRepairedAt,
      });
      return {
        changed: !verifiedBeforeRepair && restoreCodesignVerified,
        status: verifiedBeforeRepair ? "not-managed" : restoreCodesignVerified ? "signature-repaired" : "signature-repair-failed",
        appAsarPath: resolvedAsar,
        appBundlePath: resolvedBundle,
      };
    } catch (error) {
      return {
        changed: false,
        status: "signature-repair-failed",
        appAsarPath: resolvedAsar,
        appBundlePath: resolvedBundle,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (!state.appAsarBackupPath || !fs.existsSync(state.appAsarBackupPath)) {
    return { changed: false, status: "missing-backup", appAsarPath: resolvedAsar };
  }
  if (fs.existsSync(resolvedAsar) && state.patchedAsarSha256 && sha256File(resolvedAsar) !== state.patchedAsarSha256) {
    return {
      changed: false,
      status: "app-changed",
      appAsarPath: resolvedAsar,
      appBundlePath: resolvedBundle,
    };
  }

  const preRestoreBackupPath = path.join(patchWorkDir(bridgeHome), `app.asar.pre-restore.${timestamp()}.bak`);
  ensureDir(path.dirname(preRestoreBackupPath));
  if (fs.existsSync(resolvedAsar)) {
    fs.copyFileSync(resolvedAsar, preRestoreBackupPath);
  }

  fs.copyFileSync(state.appAsarBackupPath, resolvedAsar);
  if (state.infoPlistBackupPath && fs.existsSync(state.infoPlistBackupPath)) {
    fs.copyFileSync(state.infoPlistBackupPath, infoPlistPath);
  } else if (fs.existsSync(infoPlistPath)) {
    const headerHash = sha256(readAsarHeader(resolvedAsar).headerBytes);
    updateInfoPlistIntegrity({ infoPlistPath, headerHash, runCommand });
  }
  if (state.codeSignatureBackupPath && fs.existsSync(state.codeSignatureBackupPath)) {
    fs.rmSync(codeSignaturePath, { recursive: true, force: true });
    fs.cpSync(state.codeSignatureBackupPath, codeSignaturePath, { recursive: true });
  } else {
    signCodexApp({ appBundlePath: resolvedBundle, runCommand });
  }
  if (state.rootExecutableBackupPath && fs.existsSync(state.rootExecutableBackupPath)) {
    fs.copyFileSync(state.rootExecutableBackupPath, rootExecutablePath);
  }

  let restoreCodesignVerified = verifyCodexApp({ appBundlePath: resolvedBundle, runCommand });
  if (!restoreCodesignVerified) {
    signCodexApp({ appBundlePath: resolvedBundle, runCommand });
    restoreCodesignVerified = verifyCodexApp({ appBundlePath: resolvedBundle, runCommand });
  }

  const restoredState = {
    ...state,
    active: false,
    restoredAt: new Date().toISOString(),
    preRestoreBackupPath,
    restoreCodesignVerified,
  };
  writeJson(statePath, restoredState);
  return {
    changed: true,
    status: "restored",
    appAsarPath: resolvedAsar,
    appBundlePath: resolvedBundle,
    preRestoreBackupPath,
  };
}
