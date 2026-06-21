import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defaultBridgeHome } from "./config.mjs";

const STATE_FILE = "desktop-patch-state.json";
const PATCH_SCHEMA_VERSION = 1;
const PATCH_VERSION = 1;
const DEFAULT_CODEX_APP = "/Applications/Codex.app";
const ASAR_RELATIVE_PATH = path.join("Contents", "Resources", "app.asar");
const INFO_PLIST_RELATIVE_PATH = path.join("Contents", "Info.plist");
const CODE_SIGNATURE_RELATIVE_PATH = path.join("Contents", "_CodeSignature");
const ROOT_EXECUTABLE_RELATIVE_PATH = path.join("Contents", "MacOS", "Codex");

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

function resolveCodexApp({ env = process.env, appBundlePath = "" } = {}) {
  return path.resolve(env.DSCB_CODEX_APP || appBundlePath || DEFAULT_CODEX_APP);
}

function resolveAppAsar({ env = process.env, appAsarPath = "", appBundlePath = "" } = {}) {
  if (env.DSCB_CODEX_APP_ASAR || appAsarPath) {
    return path.resolve(env.DSCB_CODEX_APP_ASAR || appAsarPath);
  }
  return path.join(resolveCodexApp({ env, appBundlePath }), ASAR_RELATIVE_PATH);
}

function appBundleFromAsar(appAsarPath) {
  const resolved = path.resolve(appAsarPath);
  const resourcesDir = path.dirname(resolved);
  const contentsDir = path.dirname(resourcesDir);
  if (path.basename(resolved) !== "app.asar" || path.basename(resourcesDir) !== "Resources") {
    return "";
  }
  if (path.basename(contentsDir) !== "Contents") {
    return "";
  }
  return path.dirname(contentsDir);
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

function patchFileContent(bytes) {
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

function findPatchTarget(appAsarPath, asar) {
  let ambiguous = false;
  for (const file of candidateAsarFiles(listAsarFiles(asar.header))) {
    const { offset, bytes } = readAsarEntry(appAsarPath, asar.filesOffset, file.entry);
    const result = patchFileContent(bytes);
    if (result.state === "patched") {
      return { status: "patched", filePath: file.path, entry: file.entry, offset };
    }
    if (result.state === "patchable") {
      return { status: "patchable", filePath: file.path, entry: file.entry, offset, patchedBytes: result.bytes };
    }
    if (result.state === "ambiguous" || result.state === "unsafe-size-change") {
      ambiguous = true;
    }
  }
  return { status: ambiguous ? "ambiguous" : "target-not-found" };
}

function writePatchedAsar(appAsarPath, asar, target) {
  updateEntryIntegrity(target.entry, target.patchedBytes);
  const newHeaderText = JSON.stringify(asar.header);
  const newHeaderBytes = Buffer.from(newHeaderText, "utf8");
  if (newHeaderBytes.length !== asar.headerBytes.length) {
    throw new Error("ASAR header length changed; refusing to patch in place.");
  }

  const fd = fs.openSync(appAsarPath, "r+");
  try {
    fs.writeSync(fd, newHeaderBytes, 0, newHeaderBytes.length, 16);
    fs.writeSync(fd, target.patchedBytes, 0, target.patchedBytes.length, target.offset);
  } finally {
    fs.closeSync(fd);
  }
  return {
    headerHash: sha256(newHeaderBytes),
    fileHash: sha256(target.patchedBytes),
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

export function inspectCodexDesktopPatch({
  env = process.env,
  bridgeHome = defaultBridgeHome(env),
  appAsarPath = "",
  appBundlePath = "",
} = {}) {
  if (env.DSCB_DESKTOP_PATCH === "off") {
    return { status: "disabled" };
  }
  const resolvedAsar = resolveAppAsar({ env, appAsarPath, appBundlePath });
  const resolvedBundle = appBundleFromAsar(resolvedAsar) || resolveCodexApp({ env, appBundlePath });
  const state = readJson(patchStatePath(bridgeHome));

  if (process.platform !== "darwin" && !appAsarPath && !env.DSCB_CODEX_APP_ASAR) {
    return { status: "unsupported", appAsarPath: resolvedAsar, appBundlePath: resolvedBundle, state };
  }
  if (!fs.existsSync(resolvedAsar)) {
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
      state,
    };
  } catch (error) {
    return {
      status: "error",
      appAsarPath: resolvedAsar,
      appBundlePath: resolvedBundle,
      reason: error instanceof Error ? error.message : String(error),
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
    beforeHeaderHash,
    headerHash: hashes.headerHash,
    fileHash: hashes.fileHash,
  };
}

export function patchCodexDesktop({
  env = process.env,
  bridgeHome = defaultBridgeHome(env),
  appAsarPath = "",
  appBundlePath = "",
  runCommand = defaultRunCommand,
} = {}) {
  if (env.DSCB_DESKTOP_PATCH === "off") {
    return { status: "disabled" };
  }
  const resolvedAsar = resolveAppAsar({ env, appAsarPath, appBundlePath });
  const resolvedBundle = appBundleFromAsar(resolvedAsar) || resolveCodexApp({ env, appBundlePath });
  const infoPlistPath = path.join(resolvedBundle, INFO_PLIST_RELATIVE_PATH);
  const codeSignaturePath = path.join(resolvedBundle, CODE_SIGNATURE_RELATIVE_PATH);
  const rootExecutablePath = path.join(resolvedBundle, ROOT_EXECUTABLE_RELATIVE_PATH);

  if (process.platform !== "darwin" && !appAsarPath && !env.DSCB_CODEX_APP_ASAR) {
    return { status: "unsupported", appAsarPath: resolvedAsar, appBundlePath: resolvedBundle };
  }
  if (!fs.existsSync(resolvedAsar)) {
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
    return { status: "already-patched", appAsarPath: resolvedAsar, appBundlePath: resolvedBundle, filePath: target.filePath };
  }
  if (target.status !== "patchable") {
    return { status: target.status, appAsarPath: resolvedAsar, appBundlePath: resolvedBundle };
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
  } catch {
    return { status: "not-writable", appAsarPath: resolvedAsar, appBundlePath: resolvedBundle };
  }

  const beforeHeaderHash = sha256(asar.headerBytes);
  const originalAsarSha256 = sha256File(resolvedAsar);
  const priorState = readJson(patchStatePath(bridgeHome));
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
    restoreBackups({
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
      status: "error",
      appAsarPath: resolvedAsar,
      appBundlePath: resolvedBundle,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function restoreCodexDesktopPatch({
  env = process.env,
  bridgeHome = defaultBridgeHome(env),
  appAsarPath = "",
  runCommand = defaultRunCommand,
} = {}) {
  const statePath = patchStatePath(bridgeHome);
  const state = readJson(statePath);
  if (!state) {
    return { changed: false, status: "not-managed" };
  }

  const resolvedAsar = path.resolve(appAsarPath || state.appAsarPath || resolveAppAsar({ env }));
  const resolvedBundle = appBundleFromAsar(resolvedAsar) || state.appBundlePath || resolveCodexApp({ env });
  const infoPlistPath = state.infoPlistPath || path.join(resolvedBundle, INFO_PLIST_RELATIVE_PATH);
  const codeSignaturePath = state.codeSignaturePath || path.join(resolvedBundle, CODE_SIGNATURE_RELATIVE_PATH);
  const rootExecutablePath = state.rootExecutablePath || path.join(resolvedBundle, ROOT_EXECUTABLE_RELATIVE_PATH);

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
