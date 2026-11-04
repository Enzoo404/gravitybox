import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const assetsDir = join(root, 'assets');
const iconsDir = join(assetsDir, 'icons');
mkdirSync(iconsDir, { recursive: true });

// 官方标准波形路径 (提取自官方 mark.svg 贝塞尔曲线定义)
const WAVE_PATH = "M2.3 16.8C4.1 16.2 4.6 7 7.4 6C10.1 5.1 10.6 14.5 13.4 16.6C14.1 17.1 13.5 17.7 12.8 17.3C10.1 16.3 10 11.1 7.4 11.2C5.1 11.2 4.4 16.6 2.7 17.2C2 17.4 1.7 17.1 2.3 16.8Z";

// 官方标准光谱渐变
const SPECTRUM_GRADIENT = `
  <linearGradient id="spectrum" x1="0" y1="1" x2=".35" y2="0">
    <stop offset="0%" stop-color="#3588fd"/>
    <stop offset="45%" stop-color="#3588fd"/>
    <stop offset="72%" stop-color="#73bb79"/>
    <stop offset="86%" stop-color="#fbbc05"/>
    <stop offset="100%" stop-color="#ff5252"/>
  </linearGradient>
`;

// 1. 生成 1024x1024 Master App 图标 (方案一：陶瓷白 · 纯粹反重力颠倒飞谷)
function buildMasterSvg() {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    ${SPECTRUM_GRADIENT}
    <!-- 苹果纯净陶瓷白底板渐变 (与 Antigravity 官方 macOS 风格一致) -->
    <linearGradient id="whiteBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="85%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#F2F4F7"/>
    </linearGradient>
    
    <filter id="squircle-shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="28" stdDeviation="35" flood-color="rgba(0,0,0,0.22)"/>
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="rgba(0,0,0,0.12)"/>
    </filter>
  </defs>

  <!-- macOS 标准 Squircle 824x824 圆角 185px -->
  <g filter="url(#squircle-shadow)">
    <rect x="100" y="100" width="824" height="824" rx="185" ry="185" 
          fill="url(#whiteBg)" 
          stroke="rgba(0, 0, 0, 0.08)" 
          stroke-width="1.5" />
    <!-- 顶面极细微高光反射线 (macOS HIG 工艺细节) -->
    <rect x="101" y="101" width="822" height="822" rx="184" ry="184" 
          fill="none" 
          stroke="rgba(255, 255, 255, 0.85)" 
          stroke-width="1.2" />
  </g>

  <!-- 艺术图形主体：官方高斯拱弧 180° 上下垂直反重力翻转 -->
  <g transform="translate(512, 518) scale(46)">
    <g transform="translate(-7.9, 11.25) scale(1, -1)">
      <path d="${WAVE_PATH}" fill="url(#spectrum)" filter="drop-shadow(0 -0.8px 2.2px rgba(53,136,253,0.45))"/>
    </g>
  </g>
</svg>
  `.trim();
}

function buildTraySvg(statusKey) {
  let opacity = '1.0';
  if (statusKey === 'paused') opacity = '0.55';
  if (statusKey === 'waiting') opacity = '0.35';

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 22 22">
  <!-- 纯黑矢量作为 macOS Template 蒙版标准，系统将在深色菜单栏自动高亮为纯白，浅色菜单栏自动为深黑 -->
  <g transform="translate(11, 11) scale(1.28) scale(1, -1) translate(-7.85, -11.65)" opacity="${opacity}">
    <path d="${WAVE_PATH}" fill="#000000"/>
  </g>
</svg>
  `.trim();
}

console.log('1. 生成 master-1024.png...');
const masterSvgPath = join(assetsDir, 'master-1024.svg');
const masterPngPath = join(assetsDir, 'master-1024.png');
writeFileSync(masterSvgPath, buildMasterSvg());
execSync(`/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --headless --disable-gpu --screenshot=${masterPngPath} --window-size=1024,1024 --default-background-color=00000000 file://${masterSvgPath}`);
console.log(`✓ Master 图标生成完毕: ${masterPngPath}`);

console.log('2. 编译生成 AppIcon.icns...');
const iconsetDir = join(assetsDir, 'AppIcon.iconset');
rmSync(iconsetDir, { recursive: true, force: true });
mkdirSync(iconsetDir, { recursive: true });

const SIZES = [
  { size: 16, scale: 1, name: 'icon_16x16.png' },
  { size: 16, scale: 2, name: 'icon_16x16@2x.png' },
  { size: 32, scale: 1, name: 'icon_32x32.png' },
  { size: 32, scale: 2, name: 'icon_32x32@2x.png' },
  { size: 128, scale: 1, name: 'icon_128x128.png' },
  { size: 128, scale: 2, name: 'icon_128x128@2x.png' },
  { size: 256, scale: 1, name: 'icon_256x256.png' },
  { size: 256, scale: 2, name: 'icon_256x256@2x.png' },
  { size: 512, scale: 1, name: 'icon_512x512.png' },
  { size: 512, scale: 2, name: 'icon_512x512@2x.png' }
];

for (const s of SIZES) {
  const px = s.size * s.scale;
  const out = join(iconsetDir, s.name);
  execSync(`/usr/bin/sips -z ${px} ${px} ${masterPngPath} --out ${out} > /dev/null 2>&1`);
}

const icnsPath = join(assetsDir, 'AppIcon.icns');
execSync(`/usr/bin/iconutil -c icns ${iconsetDir} -o ${icnsPath}`);
rmSync(iconsetDir, { recursive: true, force: true });
console.log(`✓ AppIcon.icns 编译生成完毕: ${icnsPath}`);

console.log('3. 生成菜单栏状态图标...');
for (const statusKey of ['connected', 'adaptive', 'paused', 'waiting']) {
  const traySvg = buildTraySvg(statusKey);
  const traySvgPath = join(iconsDir, `menu-${statusKey}.svg`);
  const trayPngPath = join(iconsDir, `menu-${statusKey}.png`);
  writeFileSync(traySvgPath, traySvg);
  execSync(`/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --headless --disable-gpu --screenshot=${trayPngPath} --window-size=44,44 --default-background-color=00000000 file://${traySvgPath}`);
  console.log(`✓ 状态图标已更新: menu-${statusKey}.png`);
}

console.log('全套图标构建完成！');
