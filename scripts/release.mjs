// 发布脚本：备份源码 → 打 zip（暂存目录 + 结构校验）→ 跑自检。
// 用法（发布前先把 manifest.json 的 version 改好）：
//   宿主二进制路径可用环境变量 HANA 指定（Windows C:\Program Files\HanaAgent\HanaAgent.exe）。
//   Windows     : $env:ELECTRON_RUN_AS_NODE="1"; & $env:HANA scripts/release.mjs
//   macOS/Linux : ELECTRON_RUN_AS_NODE=1 "$HANA" scripts/release.mjs
//
// 打包（三平台同一套流程）：
//   1) 用 collectPkgFiles() 收集（含排除项）→ **复制到临时暂存目录，保留相对路径**；
//   2) 以暂存目录为 cwd 压缩其**顶层条目**（目录 + 顶层文件）。⚠️ Windows Compress-Archive 的坑：
//      传**单个嵌套文件路径**会被平铺到根（1.14.49 的事故就是这样），只有传**目录**才保留树；
//      另外它写出的条目名用 **反斜杠**（`routes\balance.js`）—— 这是它的历史行为，
//      历版产物（1.14.35…/1.14.48）都是这样且宿主接受，故校验时把 `\` 与 `/` 一律视为分隔符。
//   3) 打包后**读回 zip 条目做结构校验**：必须同时存在 manifest.json / routes/* / lib/*，
//      且顶层不得出现平铺的 *.js；不满足 ⇒ 删掉 zip 并报错（宁可失败，不交装不了的包）。
//
// 注意：本文件被 tests/run-all.mjs import 做语法检查（并单测下面的导出函数），
//       因此逻辑包在 main() 里，只有「直接运行」时才执行（被 import 时无副作用）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---- 打包清单（跨平台共用：Windows 与 POSIX 用同一份规则，避免两边产物不一致）----
export const PKG_EXCLUDE_DIRS = ['node_modules'];
export const PKG_EXCLUDE_NAMES = ['.DS_Store', '_selfcheck-tmp.mjs', '.git'];

/** 该名字是否应排除出包（*.tmp / *.bak* / node_modules / .DS_Store / 自检临时文件） */
export function isPkgExcluded(name) {
  if (PKG_EXCLUDE_DIRS.includes(name)) return true;
  if (PKG_EXCLUDE_NAMES.includes(name)) return true;
  if (/\.tmp$/i.test(name)) return true; // *.tmp
  if (/\.bak($|[-._\d])/i.test(name)) return true; // *.bak / *.bak2 / *.bak-20260101
  return false;
}

/** 递归收集要打包的**文件**（相对路径，统一 '/' 分隔；不含目录条目与排除项） */
export function collectPkgFiles(root, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(base ? path.join(root, base) : root, { withFileTypes: true })) {
    const name = entry.name;
    if (isPkgExcluded(name)) continue;
    const rel = base ? base + '/' + name : name;
    if (entry.isDirectory()) out.push(...collectPkgFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** 把清单复制进暂存目录（保留相对路径），返回暂存目录的顶层条目名（排序） */
export function stagePkgFiles(root, stageDir, files) {
  for (const rel of files) {
    const dst = path.join(stageDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(root, ...rel.split('/')), dst);
  }
  return fs.readdirSync(stageDir).sort();
}

/** 读回 zip 的条目名（纯 Node 解析中央目录；不依赖 unzip / python3） */
export function readZipEntryNames(zipPath) {
  const buf = fs.readFileSync(zipPath);
  // EOCD（中央目录结尾）：从尾部回扫签名 0x06054b50
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录结尾）: ' + zipPath);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏 @' + off + ': ' + zipPath);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** 条目名归一化：zip 里 `/` 与 `\` 一律当分隔符（Compress-Archive 写反斜杠） */
export function normalizeEntry(name) {
  return String(name).replace(/\\/g, '/');
}

/** 包结构校验：三类条目必须在（manifest.json + routes/ + lib/），且顶层不得有平铺的 *.js */
export function validatePackageStructure(rawNames) {
  const names = rawNames.map(normalizeEntry);
  const hasManifest = names.indexOf('manifest.json') >= 0;
  const hasRoutes = names.some((n) => /^routes\/.+/.test(n));
  const hasLib = names.some((n) => /^lib\/.+/.test(n));
  const flatJs = names.filter((n) => /^[^/]+\.js$/.test(n));
  return {
    ok: hasManifest && hasRoutes && hasLib && flatJs.length === 0,
    hasManifest, hasRoutes, hasLib, flatJs,
    nested: names.filter((n) => /^(routes|lib|tools|tests|scripts)\//.test(n)).length,
  };
}

/** 以暂存目录为 cwd 压缩其顶层条目（Windows 传目录保留树；POSIX 优先 zip，回退 python3） */
export function compressStagedPackage({ isWin, zipPath, stageDir, topEntries, relFiles }) {
  if (isWin) {
    const quoted = topEntries.map((f) => "'" + f.replace(/'/g, "''") + "'").join(',');
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      'Set-Location -LiteralPath "' + stageDir.replace(/"/g, '""') + '"; ' +
      'Compress-Archive -Path ' + quoted + ' -DestinationPath "' + zipPath + '" -Force',
    ], { cwd: stageDir, stdio: 'inherit' });
    return;
  }
  // macOS/Linux：优先 zip -r（cwd = 暂存目录，entries 干净）；无 zip 回退 python3 -m zipfile（相对文件清单）
  const attempts = [
    { tool: 'zip', argv: ['-r', '-q', zipPath].concat(topEntries) },
    { tool: 'python3', argv: ['-m', 'zipfile', '-c', zipPath].concat(relFiles) },
  ];
  const missing = [];
  for (const a of attempts) {
    try {
      execFileSync(a.tool, a.argv, { cwd: stageDir, stdio: 'inherit' });
      return;
    } catch (err) {
      // 只在「该工具不存在」时回退；工具存在但执行失败 ⇒ 如实抛出，不掩盖
      if (err && err.code === 'ENOENT') { missing.push(a.tool); continue; }
      throw err;
    }
  }
  throw new Error('未找到可用的打包工具（已尝试: ' + missing.join('、') + '）。' +
    '请先安装其一后重试：macOS/Linux 通常自带 zip；或安装 python3（提供 python3 -m zipfile）。');
}

/** 打包一根插件源码树：收集 → 暂存 → 压缩 → 结构校验（失败删包并报错） */
export function packagePlugin({ root, zipPath, platform = process.platform }) {
  const files = collectPkgFiles(root);
  if (!files.length) throw new Error('打包清单为空，拒绝产出空包: ' + root);
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-pkg-stage-'));
  try {
    const topEntries = stagePkgFiles(root, stageDir, files);
    if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
    compressStagedPackage({ isWin: platform === 'win32', zipPath, stageDir, topEntries, relFiles: files });
    // 结构校验：读回 zip 条目，三类条目必须在、顶层不得有平铺的 *.js
    const names = readZipEntryNames(zipPath);
    const check = validatePackageStructure(names);
    if (!check.ok) {
      fs.rmSync(zipPath, { force: true }); // 删掉这个装不了的包，宁可失败
      throw new Error('打包结构校验失败（需要 manifest.json + routes/ + lib/，且顶层不得有平铺 .js）: ' +
        JSON.stringify(check));
    }
    return { zipPath, entries: names, check, fileCount: files.length };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const workspace = path.resolve(root, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const { id, version } = manifest;
  console.log('发布 ' + id + ' @ ' + version);

  // 1) 备份本次发布前的源码快照（用于回滚）
  const backupDir = path.join(workspace, 'backups', id + '-' + version);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    fs.cpSync(path.join(root, entry.name), path.join(backupDir, entry.name), { recursive: true });
  }
  console.log('备份: ' + backupDir);

  // 1.5) 运行态快照：打包**之前**把 plugin-data 的 state.json/config.json 复制进 backups，
  // 让每一版都有「回滚前状态基线」（只备源码不够 —— 回滚时要确认累计值/预警状态未被波及）。
  const pluginDataDir = path.join(os.homedir(), '.hanako', 'plugin-data', id);
  if (fs.existsSync(pluginDataDir)) {
    const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // yyyyMMddHHmmss
    const snapDir = path.join(workspace, 'backups', 'plugin-data-' + id + '-' + version + '-' + ts);
    fs.mkdirSync(snapDir, { recursive: true });
    let copied = 0;
    for (const f of ['state.json', 'config.json']) {
      const src = path.join(pluginDataDir, f);
      if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(snapDir, f)); copied += 1; }
    }
    console.log('运行态快照: ' + snapDir + ' (' + copied + ' 个文件)');
  } else {
    console.log('运行态目录不存在，跳过快照: ' + pluginDataDir);
  }

  // 2) 打 zip（暂存目录 + 结构校验）
  const zipPath = path.join(workspace, id + '-' + version + '.zip');
  const res = packagePlugin({ root, zipPath });
  console.log('打包: ' + zipPath + ' (' + fs.statSync(zipPath).size + ' bytes, ' +
    res.entries.length + ' 条目, 嵌套 ' + res.check.nested + ')');
  console.log('结构校验: manifest.json ✓ / routes/ ✓ / lib/ ✓ / 顶层平铺 .js: ' + res.check.flatJs.length);

  // 3) 自检（含内联脚本语法与宿主通道检查）
  execFileSync(process.execPath, [path.join(root, 'tests', 'run-all.mjs')], { stdio: 'inherit' });
  console.log('发布完成: ' + version);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
