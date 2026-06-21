import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  inspectCodexDesktopPatch,
  patchAsarModelPicker,
  patchCodexDesktop,
  restoreCodexDesktopPatch,
} from "../src/desktop-patch.mjs";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dscb-desktop-patch-test-"));
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function entryFor(content) {
  const hash = sha256(content);
  return {
    size: content.length,
    offset: "0",
    integrity: {
      algorithm: "SHA256",
      hash,
      blockSize: 4194304,
      blocks: [hash],
    },
  };
}

function writeFakeAsar(file, source) {
  writeFakeAsarFiles(file, { "webview/assets/model-list-filter-test.js": source });
}

function setHeaderEntry(header, entryPath, entry) {
  let node = header;
  const parts = entryPath.split("/");
  for (const part of parts.slice(0, -1)) {
    node.files ||= {};
    node.files[part] ||= { files: {} };
    node = node.files[part];
  }
  node.files ||= {};
  node.files[parts.at(-1)] = entry;
}

function writeFakeAsarFiles(file, sources) {
  const header = {
    files: {},
  };
  const contents = [];
  let offset = 0;
  for (const [entryPath, source] of Object.entries(sources)) {
    const content = Buffer.from(source, "utf8");
    setHeaderEntry(header, entryPath, { ...entryFor(content), offset: String(offset) });
    contents.push(content);
    offset += content.length;
  }
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(16);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(headerBytes.length + 8, 4);
  prefix.writeUInt32LE(headerBytes.length + 4, 8);
  prefix.writeUInt32LE(headerBytes.length, 12);
  fs.writeFileSync(file, Buffer.concat([prefix, headerBytes, ...contents]));
}

function writeFakeBundle(root, source) {
  const app = path.join(root, "Codex.app");
  const resources = path.join(app, "Contents", "Resources");
  const macos = path.join(app, "Contents", "MacOS");
  const signature = path.join(app, "Contents", "_CodeSignature");
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(signature, { recursive: true });
  const appAsar = path.join(resources, "app.asar");
  const infoPlist = path.join(app, "Contents", "Info.plist");
  const rootExecutable = path.join(macos, "Codex");
  writeFakeAsar(appAsar, source);
  fs.writeFileSync(infoPlist, "plist-original");
  fs.writeFileSync(path.join(signature, "CodeResources"), "signature-original");
  fs.writeFileSync(rootExecutable, "executable-original", { mode: 0o755 });
  return { app, appAsar, infoPlist, rootExecutable };
}

function writeFakeWindowsBundleAt(app, source) {
  const resources = path.join(app, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const appAsar = path.join(resources, "app.asar");
  const executable = path.join(app, "Codex.exe");
  writeFakeAsar(appAsar, source);
  fs.writeFileSync(executable, "exe-original");
  return { app, appAsar, executable };
}

function writeFakeWindowsBundle(root, source) {
  return writeFakeWindowsBundleAt(path.join(root, "Codex"), source);
}

function readFakeAsar(file) {
  const bytes = fs.readFileSync(file);
  const headerLength = bytes.readUInt32LE(12);
  const headerBytes = bytes.subarray(16, 16 + headerLength);
  const header = JSON.parse(headerBytes.toString("utf8"));
  const entry = header.files.webview.files.assets.files["model-list-filter-test.js"];
  const content = bytes.subarray(16 + headerLength, 16 + headerLength + entry.size);
  return { headerBytes, header, entry, content };
}

test("patchAsarModelPicker disables the Desktop hidden-model allowlist and updates integrity", () => {
  const root = tempRoot();
  const appAsar = path.join(root, "app.asar");
  writeFakeAsar(
    appAsar,
    "function e({authMethod:e,availableModels:t,defaultModel:n,models:r,useHiddenModels:i}){let a=[],o=null,s=i&&e!==`amazonBedrock`;return r.forEach(n=>{if(s?t.has(n.model):!n.hidden){a.push(n)}})}",
  );

  const before = readFakeAsar(appAsar);
  const result = patchAsarModelPicker(appAsar);
  const after = readFakeAsar(appAsar);

  assert.equal(result.status, "patched");
  assert.equal(result.filePath, "webview/assets/model-list-filter-test.js");
  assert.notEqual(sha256(before.headerBytes), sha256(after.headerBytes));
  assert.match(after.content.toString("utf8"), /,s=0&&e!==`amazonBedrock`;/);
  assert.equal(after.entry.integrity.hash, sha256(after.content));
  assert.deepEqual(after.entry.integrity.blocks, [sha256(after.content)]);

  const second = patchAsarModelPicker(appAsar);
  assert.equal(second.status, "patched");
});

test("patchAsarModelPicker also unfilters recent history provider lists", () => {
  const root = tempRoot();
  const appAsar = path.join(root, "app.asar");
  writeFakeAsarFiles(appAsar, {
    "webview/assets/model-list-filter-test.js":
      "function e({authMethod:e,availableModels:t,defaultModel:n,models:r,useHiddenModels:i}){let a=[],o=null,s=i&&e!==`amazonBedrock`;return r.forEach(n=>{if(s?t.has(n.model):!n.hidden){a.push(n)}})}",
    ".vite/build/main-test.js":
      "async function recent(e){return e.listThreads({archived:!1,cursor:null,limit:200,modelProviders:null,sortKey:`updated_at`})}",
  });

  const result = patchAsarModelPicker(appAsar);
  const bytes = fs.readFileSync(appAsar).toString("utf8");

  assert.equal(result.status, "patched");
  assert.deepEqual(result.patchNames.sort(), ["history-provider-filter", "model-picker"]);
  assert.match(bytes, /,s=0&&e!==`amazonBedrock`;/);
  assert.match(bytes, /modelProviders:\[\]  /);
});

test("inspectCodexDesktopPatch reports a patchable ASAR when an explicit path is supplied", () => {
  const root = tempRoot();
  const appAsar = path.join(root, "app.asar");
  writeFakeAsar(
    appAsar,
    "function e({authMethod:e,availableModels:t,defaultModel:n,models:r,useHiddenModels:i}){let a=[],o=null,s=i&&e!==`amazonBedrock`;return r.forEach(n=>{if(s?t.has(n.model):!n.hidden){a.push(n)}})}",
  );

  const result = inspectCodexDesktopPatch({ appAsarPath: appAsar, bridgeHome: path.join(root, "bridge") });
  assert.equal(result.status, "patchable");
  assert.equal(result.filePath, "webview/assets/model-list-filter-test.js");
});

test("patchCodexDesktop backs up the root executable and signs the root bundle only", () => {
  const root = tempRoot();
  const bridgeHome = path.join(root, "bridge");
  const bundle = writeFakeBundle(
    root,
    "function e({authMethod:e,availableModels:t,defaultModel:n,models:r,useHiddenModels:i}){let a=[],o=null,s=i&&e!==`amazonBedrock`;return r.forEach(n=>{if(s?t.has(n.model):!n.hidden){a.push(n)}})}",
  );
  const commands = [];
  const runCommand = (command, args) => {
    commands.push([command, args]);
  };

  const result = patchCodexDesktop({ appAsarPath: bundle.appAsar, bridgeHome, runCommand, platform: "darwin" });

  assert.equal(result.status, "patched");
  assert.ok(result.rootExecutableBackupPath);
  assert.equal(fs.readFileSync(result.rootExecutableBackupPath, "utf8"), "executable-original");
  const sign = commands.find(([command, args]) => command === "codesign" && args.includes("--sign"));
  const verify = commands.find(([command, args]) => command === "codesign" && args.includes("--verify"));
  assert.deepEqual(sign[1], ["--force", "--sign", "-", bundle.app]);
  assert.ok(!sign[1].includes("--deep"));
  assert.ok(verify[1].includes("--deep"));
});

test("restoreCodexDesktopPatch restores the root executable and re-signs if verification fails", () => {
  const root = tempRoot();
  const bridgeHome = path.join(root, "bridge");
  const bundle = writeFakeBundle(
    root,
    "function e({authMethod:e,availableModels:t,defaultModel:n,models:r,useHiddenModels:i}){let a=[],o=null,s=i&&e!==`amazonBedrock`;return r.forEach(n=>{if(s?t.has(n.model):!n.hidden){a.push(n)}})}",
  );
  let verifyCalls = 0;
  const commands = [];
  const runCommand = (command, args) => {
    commands.push([command, args]);
    if (command === "codesign" && args.includes("--sign")) {
      fs.writeFileSync(bundle.rootExecutable, "executable-signed", { mode: 0o755 });
    }
    if (command === "codesign" && args.includes("--verify")) {
      verifyCalls += 1;
      if (verifyCalls === 2) {
        throw new Error("signature mismatch");
      }
    }
  };

  const patch = patchCodexDesktop({ appAsarPath: bundle.appAsar, bridgeHome, runCommand, platform: "darwin" });
  assert.equal(patch.status, "patched");
  assert.equal(fs.readFileSync(bundle.rootExecutable, "utf8"), "executable-signed");

  const restore = restoreCodexDesktopPatch({ appAsarPath: bundle.appAsar, bridgeHome, runCommand, platform: "darwin" });
  const signCommands = commands.filter(([command, args]) => command === "codesign" && args.includes("--sign"));
  const state = JSON.parse(fs.readFileSync(path.join(bridgeHome, "desktop-patch-state.json"), "utf8"));

  assert.equal(restore.status, "restored");
  assert.equal(signCommands.length, 2);
  assert.equal(fs.readFileSync(bundle.rootExecutable, "utf8"), "executable-signed");
  assert.equal(state.active, false);
  assert.equal(state.restoreCodesignVerified, true);
});

test("restoreCodexDesktopPatch repairs a stale inactive state with failed signature verification", () => {
  const root = tempRoot();
  const bridgeHome = path.join(root, "bridge");
  const bundle = writeFakeBundle(
    root,
    "function e({authMethod:e,availableModels:t,defaultModel:n,models:r,useHiddenModels:i}){let a=[],o=null,s=i&&e!==`amazonBedrock`;return r.forEach(n=>{if(s?t.has(n.model):!n.hidden){a.push(n)}})}",
  );
  fs.mkdirSync(bridgeHome, { recursive: true });
  fs.writeFileSync(
    path.join(bridgeHome, "desktop-patch-state.json"),
    `${JSON.stringify(
      {
        active: false,
        appAsarPath: bundle.appAsar,
        appBundlePath: bundle.app,
        restoreCodesignVerified: false,
      },
      null,
      2,
    )}\n`,
  );

  let verifyCalls = 0;
  const commands = [];
  const runCommand = (command, args) => {
    commands.push([command, args]);
    if (command === "codesign" && args.includes("--verify")) {
      verifyCalls += 1;
      if (verifyCalls === 1) {
        throw new Error("signature mismatch");
      }
    }
  };

  const restore = restoreCodexDesktopPatch({ appAsarPath: bundle.appAsar, bridgeHome, runCommand, platform: "darwin" });
  const signCommands = commands.filter(([command, args]) => command === "codesign" && args.includes("--sign"));
  const state = JSON.parse(fs.readFileSync(path.join(bridgeHome, "desktop-patch-state.json"), "utf8"));

  assert.equal(restore.status, "signature-repaired");
  assert.equal(restore.changed, true);
  assert.equal(signCommands.length, 1);
  assert.equal(state.restoreCodesignVerified, true);
  assert.ok(state.signatureRepairedAt);
});

test("patchCodexDesktop patches and restores a writable Windows Electron bundle", () => {
  const root = tempRoot();
  const bridgeHome = path.join(root, "bridge");
  const bundle = writeFakeWindowsBundle(
    root,
    "function e({authMethod:e,availableModels:t,defaultModel:n,models:r,useHiddenModels:i}){let a=[],o=null,s=i&&e!==`amazonBedrock`;return r.forEach(n=>{if(s?t.has(n.model):!n.hidden){a.push(n)}})}",
  );

  const patch = patchCodexDesktop({ appBundlePath: bundle.app, bridgeHome, platform: "win32" });
  const state = JSON.parse(fs.readFileSync(path.join(bridgeHome, "desktop-patch-state.json"), "utf8"));
  const afterPatch = readFakeAsar(bundle.appAsar);

  assert.equal(patch.status, "patched");
  assert.equal(patch.platform, "win32");
  assert.equal(patch.managedCopy, false);
  assert.match(afterPatch.content.toString("utf8"), /,s=0&&e!==`amazonBedrock`;/);
  assert.equal(state.platform, "win32");
  assert.equal(state.active, true);

  const restore = restoreCodexDesktopPatch({ bridgeHome, platform: "win32" });
  const afterRestore = readFakeAsar(bundle.appAsar);

  assert.equal(restore.status, "restored");
  assert.equal(afterRestore.content.toString("utf8").includes(",s=0&&"), false);
});

test("patchCodexDesktop mirrors Windows Store installs into a managed writable copy", () => {
  const root = tempRoot();
  const bridgeHome = path.join(root, "bridge");
  const storeApp = path.join(root, "Program Files", "WindowsApps", "OpenAI.Codex_1.0.0_x64__abc", "app");
  const source = writeFakeWindowsBundleAt(
    storeApp,
    "function e({authMethod:e,availableModels:t,defaultModel:n,models:r,useHiddenModels:i}){let a=[],o=null,s=i&&e!==`amazonBedrock`;return r.forEach(n=>{if(s?t.has(n.model):!n.hidden){a.push(n)}})}",
  );

  const patch = patchCodexDesktop({ appBundlePath: source.app, bridgeHome, platform: "win32" });
  const state = JSON.parse(fs.readFileSync(path.join(bridgeHome, "desktop-patch-state.json"), "utf8"));

  assert.equal(patch.status, "patched");
  assert.equal(patch.managedCopy, true);
  assert.ok(patch.appBundlePath.includes(path.join("desktop-patch", "windows-store-apps")));
  assert.equal(fs.existsSync(patch.launcherPath), true);
  assert.equal(readFakeAsar(source.appAsar).content.toString("utf8").includes(",s=0&&"), false);
  assert.equal(readFakeAsar(patch.appAsarPath).content.toString("utf8").includes(",s=0&&"), true);
  assert.equal(state.sourceAppBundlePath, source.app);

  const restore = restoreCodexDesktopPatch({ bridgeHome, platform: "win32" });
  assert.equal(restore.status, "restored");
  assert.equal(fs.existsSync(patch.appBundlePath), false);
  assert.equal(fs.existsSync(patch.launcherPath), false);
});
