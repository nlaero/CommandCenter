import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  MODEL_SHA256,
  RUNTIME_SHA256,
  copyRuntimeDir,
  nsisQuote,
  renderBundleNsh,
  renderInstallJson,
} from "./fetch-base-en.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("pinned checksums match Settings → Local AI", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src-tauri", "src", "local_ai.rs"), "utf8");
  const rustHash = (name) =>
    source.match(new RegExp(`${name}:\\s*&str\\s*=\\s*"([0-9a-f]{64})"`))?.[1];
  assert.equal(rustHash("MODEL_SHA256"), MODEL_SHA256);
  assert.equal(rustHash("WINDOWS_RUNTIME_SHA256"), RUNTIME_SHA256);
  const config = fs.readFileSync(path.join(repoRoot, "src-tauri", "src", "config.rs"), "utf8");
  assert.match(config, /APP_DIR_NAME: &str = "command-center"/);
});

test("install marker is the Base English layout Settings already reads", () => {
  const marker = JSON.parse(renderInstallJson(147_964_211));
  assert.deepEqual(marker, {
    modelId: "base.en",
    modelLabel: "Base English",
    modelBytes: 147_964_211,
    modelPath: "ai/models/ggml-base.en.bin",
    runtimePath: "ai/runtime/whisper-cli.exe",
  });
  assert.throws(() => renderInstallJson(0));
});

test("installer fragment copies Base English into the config dir once", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-base-nsh-"));
  const model = path.join(dir, "ggml-base.en.bin");
  const runtimeDir = path.join(dir, "runtime");
  const nested = path.join(runtimeDir, "extra");
  fs.mkdirSync(nested, { recursive: true });
  const dll = path.join(runtimeDir, "ggml.dll");
  const extra = path.join(nested, "helper.dll");
  const marker = path.join(dir, "install.json");
  fs.writeFileSync(model, "model");
  fs.writeFileSync(dll, "dll");
  fs.writeFileSync(extra, "extra");
  fs.writeFileSync(marker, "{}");
  const script = renderBundleNsh({
    modelFile: model,
    runtimeDir,
    runtimeFiles: [dll, extra],
    installJson: marker,
  });
  assert.match(script, /SetShellVarContext current/);
  assert.match(script, /IfFileExists "\$APPDATA\\command-center\\ai\\models\\ggml-base\.en\.bin"/);
  assert.match(script, /IfFileExists "\$APPDATA\\command-center\\ai\\install\.json" cc_base_en_done/);
  assert.match(script, /DetailPrint "Installing Base English"/);
  assert.match(script, /Delete "\$APPDATA\\command-center\\ai\\models\\ggml-tiny\.en\.bin"/);
  assert.match(script, /SetOutPath "\$APPDATA\\command-center\\ai\\models"/);
  assert.match(script, /SetOutPath "\$INSTDIR"/);
  assert.match(script, /SetCompress off/);
  assert.match(script, /SetCompress auto/);
  assert.doesNotMatch(script, /https?:/);
  assert.ok(script.includes(model));
  assert.ok(script.includes(dll));
  assert.match(script, /command-center\\ai\\runtime\\extra/);
  assert.equal(nsisQuote("C:\\pay\\ggml-base.en.bin"), '"C:\\pay\\ggml-base.en.bin"');
  assert.equal(nsisQuote("C:\\pay\\$notavar.bin"), '"C:\\pay\\$$notavar.bin"');
  assert.match(script, /SetOutPath "\$APPDATA\\command-center\\ai\\runtime"/);
  assert.doesNotMatch(script, /\$\$APPDATA/);
  assert.throws(() => nsisQuote('C:\\has"quote.bin'));
});

test("runtime copy keeps whisper-cli.exe and the libraries beside it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-base-rt-"));
  const extracted = path.join(root, "extracted");
  fs.mkdirSync(path.join(extracted, "whisper-bin-x64"), { recursive: true });
  fs.writeFileSync(path.join(extracted, "README.md"), "skip me");
  fs.writeFileSync(path.join(extracted, "whisper-bin-x64", "whisper-cli.exe"), "MZ");
  fs.writeFileSync(path.join(extracted, "whisper-bin-x64", "ggml.dll"), "dll");
  fs.writeFileSync(path.join(extracted, "whisper-bin-x64", "wchess.exe"), "nope");
  fs.writeFileSync(path.join(extracted, "whisper-bin-x64", "whisper-server.exe"), "nope");
  const dest = path.join(root, "runtime");
  copyRuntimeDir(extracted, dest);
  assert.equal(fs.readFileSync(path.join(dest, "whisper-cli.exe"), "utf8"), "MZ");
  assert.equal(fs.readFileSync(path.join(dest, "ggml.dll"), "utf8"), "dll");
  assert.equal(fs.existsSync(path.join(dest, "README.md")), false);
  assert.equal(fs.existsSync(path.join(dest, "wchess.exe")), false);
  assert.equal(fs.existsSync(path.join(dest, "whisper-server.exe")), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("the Windows installer refuses to build without the staged model", () => {
  const hooks = fs.readFileSync(path.join(repoRoot, "src-tauri", "windows", "hooks.nsh"), "utf8");
  assert.match(hooks, /base-en\/bundle\.nsh/);
  assert.match(hooks, /base-en\\bundle\.nsh/);
  assert.match(hooks, /NSIS_WIN32_MAKENSIS/);
  assert.match(hooks, /fetch-base-en\.mjs/);
  assert.match(hooks, /!error/);
});
