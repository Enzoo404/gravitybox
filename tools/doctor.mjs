import {existsSync, chmodSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),setup=process.argv.includes('--setup'),install=setup||process.argv.includes('--install'),skipNative=process.argv.includes('--skip-native');
const version=JSON.parse(await readFile(join(root,'package.json'))).version;
if(!process.versions.node.startsWith('22.')){process.stderr.write('开发需要 Node 22。当前应用已自带运行环境，日常使用不受影响。\n');process.exit(1);}
function run(args){execFileSync('npm',args,{cwd:root,stdio:'inherit'});}
if(install&&!existsSync(join(root,'node_modules/typescript/bin/tsc')))run(['ci','--ignore-scripts','--no-audit','--no-fund']);
let ready=true;
for(const file of ['package-lock.json','node_modules/typescript/bin/tsc','native/Assistant.swift','runtime/engine.js'])if(!existsSync(join(root,file))){ready=false;process.stderr.write('缺少：'+file+'\n');}
const bundleSource=await readFile(join(root,'src/bundle.ts'),'utf8');
const bundleBlock=bundleSource.match(/export const SUPPORTED_BUNDLES\s*=\s*new Map\(\[([\s\S]*?)\]\);/)?.[1]??'';
for(const [,supportedVersion] of bundleBlock.matchAll(/\['(\d+\.\d+\.\d+)'\s*,/g)){
  const dictFile=`ui-strings/${supportedVersion}.json`;
  if(!existsSync(join(root,dictFile))){ready=false;process.stderr.write(`缺少已收录版本词典：${dictFile}\n`);}
}
if(!skipNative){
  try{execFileSync('/usr/bin/xcrun',['--find','swiftc'],{stdio:'pipe'});}catch{ready=false;process.stderr.write('缺少 Apple 命令行开发工具。\n');}
}
if(!ready){process.stderr.write('先运行 npm run setup:dev 准备依赖；缺少系统开发工具时按 macOS 提示安装。\n');process.exit(1);}

// Git pre-push hook 门禁配置
let hooksConfigured = false;
const hookPath = join(root, '.githooks/pre-push');
if (existsSync(hookPath)) {
  try { chmodSync(hookPath, 0o755); } catch {}
}
if (existsSync(join(root, '.git'))) {
  try {
    const currentHooks = execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, stdio: 'pipe' }).toString().trim();
    hooksConfigured = currentHooks === '.githooks';
  } catch {
    hooksConfigured = false;
  }
  if (!hooksConfigured && setup) {
    try {
      execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'pipe' });
      hooksConfigured = true;
      process.stdout.write('已配置 Git 门禁钩子：core.hooksPath = .githooks\n');
    } catch {
      process.stderr.write('配置 Git hooksPath 失败。\n');
    }
  }
}

if(setup)run(['run','build']);
process.stdout.write(`GravityBox ${version} 开发环境已就绪${existsSync(join(root,'dist/main.js'))?'，编译输出存在':'；运行 npm run build 生成编译输出'}${hooksConfigured ? '；Git 门禁钩子已就绪' : '；提示：运行 npm run setup:dev 可自动启用 Git pre-push 门禁钩子'}。\n`);

