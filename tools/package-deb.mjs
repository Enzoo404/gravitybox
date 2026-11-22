import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';
import {
  assertReleaseArtifacts,
  includeDictionaryPath,
  listCompiledScripts,
  sourceDigest,
  verifySha256Sidecar,
  writeSha256Sidecar,
} from './release-integrity.mjs';
import { includePackagedAssetPath } from './package-mac.mjs';
import { scanDirectoryForPrivacy } from './check-privacy.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

/** Map Node `process.arch` to Debian architecture string. */
export function resolveDebianArch(nodeArch = process.arch) {
  switch (nodeArch) {
    case 'x64': return 'amd64';
    case 'arm64': return 'arm64';
    default: throw new Error(`暂不支持的 Debian 打包架构：${nodeArch}`);
  }
}

/** Generate `DEBIAN/control` content for the GravityBox Ubuntu `.deb` package. */
export function buildDebianControl({ version, arch, installedSizeKb }) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.+~]+)?$/.test(String(version))) {
    throw new Error(`无效的 Debian 版本号：${version}`);
  }
  return [
    'Package: gravitybox',
    `Version: ${version}`,
    'Section: utils',
    'Priority: optional',
    `Architecture: ${arch}`,
    `Installed-Size: ${Math.max(1, Math.ceil(installedSizeKb))}`,
    'Maintainer: Enzoo404 <enzoo404@users.noreply.github.com>',
    'Homepage: https://github.com/Enzoo404/gravitybox',
    'Depends: python3 (>= 3.10), python3-pyqt5, python3-pyqt5.qtsvg, python3-gi, gir1.2-secret-1, lsof',
    'Recommends: gnome-keyring | kwalletmanager, libsecret-tools, xdg-utils',
    'Description: Native Ubuntu/Linux Companion for Google Antigravity',
    ' GravityBox is a local-first, privacy-focused companion toolbox for Google',
    ' Antigravity IDE featuring zero-intrusion bilingual localization, real-time',
    ' in-IDE telemetry HUD, dual-window quota monitoring, 4-phase atomic multi-account',
    ' switching, read-only SQLite usage analytics, and non-destructive cache maintenance.',
    '',
  ].join('\n');
}

/** Generate `/usr/share/applications/gravitybox.desktop` content. */
export function buildDesktopEntry() {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=GravityBox',
    'GenericName=Antigravity Companion',
    'Comment=Companion toolbox for Google Antigravity IDE',
    'Comment[zh_CN]=Google Antigravity 全功能增强伴侣',
    'Exec=/usr/bin/gravitybox %U',
    'Icon=gravitybox',
    'Terminal=false',
    'StartupNotify=true',
    'StartupWMClass=GravityBox',
    'Categories=Development;Utility;',
    'Keywords=Antigravity;AI;Quota;Telemetry;Localization;',
    '',
  ].join('\n');
}

/** Generate `/usr/bin/gravitybox` wrapper script. */
export function buildLauncherScript() {
  return `#!/bin/sh
set -eu
APP_ROOT="/usr/lib/gravitybox"
export GRAVITYBOX_RESOURCE_ROOT="$APP_ROOT"
export GRAVITYBOX_NODE_BIN="$APP_ROOT/runtime/node"

case "\${1:-}" in
  --backend-only)
    shift
    exec "$APP_ROOT/runtime/node" --max-old-space-size=256 "$APP_ROOT/core/dist/main.js" "$@"
    ;;
  --diagnose|--command)
    exec "$APP_ROOT/runtime/node" --max-old-space-size=256 "$APP_ROOT/core/dist/main.js" "$@"
    ;;
  *)
    export PYTHONPATH="$APP_ROOT/linux\${PYTHONPATH:+:$PYTHONPATH}"
    exec /usr/bin/python3 -m gravitybox "$@"
    ;;
esac
`;
}

async function walkFiles(dir, baseDir = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkFiles(full, baseDir));
    } else if (entry.isFile()) {
      out.push({ full, rel: relative(baseDir, full).replaceAll('\\', '/') });
    }
  }
  return out;
}

async function generateHicolorIcons(masterPng, stageDir) {
  const sizes = [48, 128, 256, 512];
  const pyScript = `
import sys
from pathlib import Path
from PyQt5.QtGui import QImage
from PyQt5.QtCore import Qt

src = QImage(sys.argv[1])
if src.isNull():
    raise RuntimeError("Failed to load master icon")
stage = Path(sys.argv[2])
for s in [48, 128, 256, 512]:
    out_dir = stage / "usr" / "share" / "icons" / "hicolor" / f"{s}x{s}" / "apps"
    out_dir.mkdir(parents=True, exist_ok=True)
    scaled = src.scaled(s, s, Qt.KeepAspectRatio, Qt.SmoothTransformation)
    if not scaled.save(str(out_dir / "gravitybox.png"), "PNG"):
        raise RuntimeError(f"Failed to save {s}x{s} icon")
`;
  await run('/usr/bin/python3', ['-c', pyScript, masterPng, stageDir], { timeout: 15000 });
  return sizes;
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('package-deb 仅可在 Linux 环境下运行');
  }
  if (!process.versions.node.startsWith('22.')) {
    throw new Error(`请使用 Node 22 构建自包含 .deb 安装包（当前 ${process.versions.node}）`);
  }
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const debArch = resolveDebianArch(process.arch);

  const verificationPath = join(root, '.cache', 'verified-linux-release.json');
  if (!existsSync(verificationPath)) {
    throw new Error('未找到 .cache/verified-linux-release.json，请先运行 npm run verify:linux');
  }
  const verification = JSON.parse(await readFile(verificationPath, 'utf8'));
  const currentDigest = await sourceDigest(root);
  if (verification.digest !== currentDigest || verification.version !== version) {
    throw new Error('源码已变化或未通过检查，请先重新运行 npm run verify:linux');
  }
  await assertReleaseArtifacts(root, verification.artifacts);

  const outputDir = join(root, '成品');
  const stageDir = join(root, 'build', 'deb-stage');
  const libDir = join(stageDir, 'usr', 'lib', 'gravitybox');
  const binDir = join(stageDir, 'usr', 'bin');
  const appDir = join(stageDir, 'usr', 'share', 'applications');
  const docDir = join(stageDir, 'usr', 'share', 'doc', 'gravitybox');
  const debianDir = join(stageDir, 'DEBIAN');

  await rm(stageDir, { recursive: true, force: true });
  await Promise.all([
    mkdir(join(libDir, 'runtime'), { recursive: true }),
    mkdir(join(libDir, 'core', 'dist'), { recursive: true }),
    mkdir(join(libDir, 'icons'), { recursive: true }),
    mkdir(binDir, { recursive: true }),
    mkdir(appDir, { recursive: true }),
    mkdir(docDir, { recursive: true }),
    mkdir(debianDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);

  // 1. Bundle Node 22 runtime (stripped if strip is available)
  const bundledNode = join(libDir, 'runtime', 'node');
  await copyFile(process.execPath, bundledNode);
  await chmod(bundledNode, 0o755);
  if (existsSync('/usr/bin/strip')) {
    await run('/usr/bin/strip', ['--strip-unneeded', bundledNode]).catch(() => {});
  }
  await copyFile(join(root, 'licenses', 'NODE-LICENSE'), join(libDir, 'runtime', 'LICENSE'));

  // 2. Copy compiled backend scripts (only from current source list)
  for (const name of await listCompiledScripts(root)) {
    const dest = join(libDir, 'core', 'dist', name);
    await mkdir(join(dest, '..'), { recursive: true });
    await copyFile(join(root, 'dist', name), dest);
  }
  await cp(join(root, 'dict'), join(libDir, 'core', 'dict'), {
    recursive: true,
    filter: src => includeDictionaryPath(join('dict', relative(join(root, 'dict'), src))),
  });
  await writeFile(join(libDir, 'core', 'package.json'), JSON.stringify({ type: 'module', version }) + '\n', 'utf8');

  // 3. Copy assets (i18n, icons, model-icons, model-catalog)
  const filterAsset = src => includePackagedAssetPath(relative(join(root, 'assets'), src));
  await copyFile(join(root, 'assets', 'model-catalog.json'), join(libDir, 'model-catalog.json'));
  await copyFile(join(root, 'assets', 'icons', 'menu-connected.png'), join(libDir, 'icons', 'menu-connected.png'));
  await copyFile(join(root, 'assets', 'master-1024.png'), join(libDir, 'icons', 'gravitybox.png'));
  await cp(join(root, 'assets', 'i18n'), join(libDir, 'i18n'), { recursive: true, filter: filterAsset });
  await cp(join(root, 'assets', 'model-icons'), join(libDir, 'model-icons'), { recursive: true, filter: filterAsset });

  // 4. Copy Linux PyQt5 desktop frontend (exclude __pycache__ / .pyc)
  await cp(join(root, 'linux'), join(libDir, 'linux'), {
    recursive: true,
    filter: src => !src.includes('__pycache__') && !src.endsWith('.pyc'),
  });

  // 5. Legal & build metadata
  await copyFile(join(root, 'LICENSE'), join(libDir, 'LICENSE'));
  await copyFile(join(root, 'THIRD_PARTY_NOTICES.md'), join(libDir, 'THIRD_PARTY_NOTICES.md'));
  await copyFile(join(root, 'LICENSE'), join(docDir, 'copyright'));

  const buildInfo = {
    version,
    platform: 'linux',
    arch: debArch,
    revision: currentDigest.slice(0, 8),
    sourceDigest: currentDigest,
    node: process.versions.node,
    builtAt: new Date().toISOString(),
  };
  await writeFile(join(libDir, 'build-info.json'), JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');

  // 6. Launcher, .desktop, hicolor icons
  const launcherPath = join(binDir, 'gravitybox');
  await writeFile(launcherPath, buildLauncherScript(), 'utf8');
  await chmod(launcherPath, 0o755);

  const desktopPath = join(appDir, 'gravitybox.desktop');
  await writeFile(desktopPath, buildDesktopEntry(), 'utf8');
  if (existsSync('/usr/bin/desktop-file-validate')) {
    await run('/usr/bin/desktop-file-validate', [desktopPath]);
  }
  await generateHicolorIcons(join(root, 'assets', 'master-1024.png'), stageDir);

  // 7. Privacy gate scan on staged package contents
  const privacy = await scanDirectoryForPrivacy(stageDir, {
    excludePrefixes: ['usr/lib/gravitybox/runtime/'],
  });
  if (privacy.issues.length > 0) {
    const summary = privacy.issues.map(i => `${i.file}:${i.line} [${i.code}] ${i.detail}`).join('\n');
    throw new Error(`Debian 安装包隐私检查未通过，已中止打包:\n${summary}`);
  }

  // 8. Compute Installed-Size and DEBIAN/md5sums + maintainer scripts
  const installedFiles = await walkFiles(join(stageDir, 'usr'), stageDir);
  let totalBytes = 0;
  const md5Lines = [];
  for (const item of installedFiles.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const st = await stat(item.full);
    totalBytes += st.size;
    const md5 = createHash('md5').update(await readFile(item.full)).digest('hex');
    md5Lines.push(`${md5}  ${item.rel}`);
  }
  await writeFile(join(debianDir, 'md5sums'), md5Lines.join('\n') + '\n', 'utf8');
  await writeFile(
    join(debianDir, 'control'),
    buildDebianControl({ version, arch: debArch, installedSizeKb: totalBytes / 1024 }),
    'utf8',
  );

  const postinst = `#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
`;
  const postrm = `#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
`;
  await writeFile(join(debianDir, 'postinst'), postinst, 'utf8');
  await writeFile(join(debianDir, 'postrm'), postrm, 'utf8');
  await chmod(join(debianDir, 'postinst'), 0o755);
  await chmod(join(debianDir, 'postrm'), 0o755);

  // 9. Build .deb package & verify metadata + SHA-256 sidecar
  const debPath = join(outputDir, `gravitybox_${version}_${debArch}.deb`);
  await rm(debPath, { force: true });
  await run('/usr/bin/dpkg-deb', ['--build', '--root-owner-group', '-Zxz', stageDir, debPath], { maxBuffer: 10 * 1024 * 1024 });
  await run('/usr/bin/dpkg-deb', ['--info', debPath], { maxBuffer: 4 * 1024 * 1024 });
  await run('/usr/bin/dpkg-deb', ['--contents', debPath], { maxBuffer: 10 * 1024 * 1024 });

  const sidecar = await writeSha256Sidecar(debPath);
  const verified = await verifySha256Sidecar(debPath);
  if (verified.hash !== sidecar.hash) {
    throw new Error('DEB sha256 校验文件写入后复核不一致，已中止发布');
  }
  const debStat = await stat(debPath);
  console.log(JSON.stringify({
    deb: debPath,
    arch: debArch,
    sizeBytes: debStat.size,
    sha256: verified.hash,
    sha256File: sidecar.sidecarPath,
    sourceDigest: currentDigest,
  }, null, 2));
}

const invokedDirectly = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(error => {
    console.error(`[package-deb] ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
