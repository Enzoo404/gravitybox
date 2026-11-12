import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, basename} from 'node:path';
import {BundleCache} from '../dist/bundle-cache.js';
import {safeRoute,scopedKey,decodeScopedKey} from '../dist/candidates.js';
import {CacheMaintenance} from '../dist/maintenance.js';
import {Controller} from '../dist/controller.js';
import {dictionaryFromEntries,loadDictionaryLayers} from '../dist/dictionary.js';

test('场景键保留占位符、隔离角色和页面，并隐藏私有路径',()=>{
  assert.notEqual(scopedKey('Open {name}','button','/settings'),scopedKey('Open {name}','heading','/'));
  assert.deepEqual(decodeScopedKey(scopedKey('Open {name}','button','/settings')),{key:'Open {name}',kind:'button',route:'/settings'});
  assert.equal(safeRoute('/c/private-id?token=secret'),'/other');assert.equal(decodeScopedKey('@ui:/c/private|button|Open'),undefined);
});
test('连接缓存不保留源字符串，同实例复用；文件、进程、版本或来源变化重新计算',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gravity-cache-'));try{
    await mkdir(join(dir,'Contents/Resources'),{recursive:true});await writeFile(join(dir,'Contents/Resources/app.asar'),'first');
    let reads=0;const fetcher=async()=>{await new Promise(r=>setTimeout(r,10));return {hash:`hash-${++reads}`,source:'example',bytes:7};};const cache=new BundleCache();
    const first=await Promise.all([cache.read(dir,1,'2.23.1','http://127.0.0.1:1',fetcher),cache.read(dir,1,'2.23.1','http://127.0.0.1:1',fetcher)]);assert.equal(first.filter(r=>!r.cacheHit).length,1);assert.equal(reads,1);
    const hit=await cache.read(dir,1,'2.23.1','http://127.0.0.1:1',fetcher);assert.equal(hit.source,undefined);assert.equal(reads,1);
    await cache.read(dir,2,'2.23.1','http://127.0.0.1:1',fetcher);assert.equal(reads,2);
    await cache.read(dir,2,'2.24.0','http://127.0.0.1:1',fetcher);assert.equal(reads,3);
    await cache.read(dir,2,'2.24.0','http://127.0.0.1:2',fetcher);assert.equal(reads,4);
    await writeFile(join(dir,'Contents/Resources/app.asar'),'changed size');await cache.read(dir,2,'2.24.0','http://127.0.0.1:2',fetcher);assert.equal(reads,5);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('未知指纹仅使用保守页面策略，受验证版本保留完整规则',()=>{
  const c=new Controller({appPath:'/Applications/Antigravity.app',profile:'/tmp/unused',dictionary:dictionaryFromEntries({Settings:'设置'}),onStatus:()=>{}});
  c.status.appVersion='2.23.2';c.status.bundleSha256='new';assert.equal(JSON.parse(c.boot('http://127.0.0.1:1234/').split('\n')[0].split('=')[1].slice(0,-1)).conservative,true);
  c.status.appVersion='2.23.1';c.status.bundleSha256='ad12ecf66061edab6a3835d1360e1bad50787bc7b2f2c9d86568281360864696';assert.match(c.boot('http://127.0.0.1:1234/'),/"conservative":false/);
});
test('缓存清理只操作三个白名单目录，应用运行时拒绝，登录和会话原样保留',async()=>{
 const temp=await realpath(await mkdtemp(join(tmpdir(),'gravity-maint-')));const profile=join(temp,'profile'),trash=join(temp,'trash');await mkdir(profile);await mkdir(trash);
 try{
  for(const n of ['Cache','Code Cache','GPUCache','Local Storage','User']){await mkdir(join(profile,n));await writeFile(join(profile,n,'data'),'preserve-'+n);}
  await writeFile(join(profile,'Cookies'),'session');let running=true;const m=new CacheMaintenance(profile,trash,async()=>running);
  const first=await m.scan();await assert.rejects(m.clear(first.token),/退出/);running=false;
  const second=await m.scan();await writeFile(join(profile,'Cache','extra'),'changed');await assert.rejects(m.clear(second.token),/变化/);
  const third=await m.scan();const result=await m.clear(third.token);assert.equal(result.moved,3);assert.equal(await readFile(join(profile,'Cookies'),'utf8'),'session');assert.equal(await readFile(join(profile,'Local Storage/data'),'utf8'),'preserve-Local Storage');assert.equal(await readFile(join(profile,'User/data'),'utf8'),'preserve-User');assert.match(await readFile(join(result.restorePath,'恢复清单.json'),'utf8'),/GPUCache/);
 }finally{await rm(temp,{recursive:true,force:true});}
});
test('缓存目录符号链接不会被跟随或清理',async()=>{
 const temp=await realpath(await mkdtemp(join(tmpdir(),'gravity-maint-link-')));try{
  const profile=join(temp,'profile'),outside=join(temp,'outside');await mkdir(profile);await mkdir(outside);await writeFile(join(outside,'important'),'keep');await symlink(outside,join(profile,'Cache'));
  const m=new CacheMaintenance(profile,join(temp,'trash'),async()=>false);const scan=await m.scan();assert.equal(scan.entries[0].clearable,false);await assert.rejects(m.clear(scan.token));assert.equal(await readFile(join(outside,'important'),'utf8'),'keep');
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('版本词典选择最近可用层，不将未来版本覆盖带回旧版；个人覆盖仍最高',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gravity-dict-version-'));const base=join(dir,'base'),user=join(dir,'user');try{await mkdir(base);await mkdir(user);await writeFile(join(base,'base.json'),'{"Version label":"基础"}');await writeFile(join(base,'2.23.0.json'),'{"Version label":"旧版"}');await writeFile(join(base,'2.24.0.json'),'{"Version label":"未来"}');assert.equal((await loadDictionaryLayers(base,user,'2.23.1')).dictionary.entries['Version label'],'旧版');assert.equal((await loadDictionaryLayers(base,user,'2.25.0')).dictionary.entries['Version label'],'未来');await writeFile(join(user,'个人覆盖.json'),'{"Version label":"个人"}');assert.equal((await loadDictionaryLayers(base,user,'2.23.1')).dictionary.entries['Version label'],'个人');}finally{await rm(dir,{recursive:true,force:true});}
});

test('个人全局覆盖高于 AI 场景补全；移除后恢复已有场景译文',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'gravity-context-personal-'));const base=join(dir,'base'),user=join(dir,'user');try{await mkdir(base);await mkdir(user);await writeFile(join(base,'base.json'),'{}');const context=scopedKey('Open','button','/settings');await writeFile(join(user,'增量补全-2.23.1.json'),JSON.stringify({[context]:'打开资源'}));await writeFile(join(user,'个人覆盖.json'),'{"Open":"我的译文"}');let layers=await loadDictionaryLayers(base,user);assert.equal(layers.dictionary.entries[context],undefined);assert.equal(layers.dictionary.entries.Open,'我的译文');await writeFile(join(user,'个人覆盖.json'),'{}');layers=await loadDictionaryLayers(base,user);assert.equal(layers.dictionary.entries[context],'打开资源');}finally{await rm(dir,{recursive:true,force:true});}
});

test('清理中重开应用保留恢复计划，退出后才撤回移动', async () => {
 const temp=await realpath(await mkdtemp(join(tmpdir(),'gravity-maint-race-')));
 const profile=join(temp,'profile'),trash=join(temp,'trash');await mkdir(profile);await mkdir(trash);
 try {
  for(const name of ['Cache','Code Cache','GPUCache']) {await mkdir(join(profile,name));await writeFile(join(profile,name,'data'),name);}
  const m=new CacheMaintenance(profile,trash,async()=>!existsSync(join(profile,'Cache')));
  const scan=await m.scan();await assert.rejects(m.clear(scan.token),/恢复待处理/);
  const stopped=new CacheMaintenance(profile,trash,async()=>false);await stopped.history();
  for(const name of ['Cache','Code Cache','GPUCache']) assert.equal(await readFile(join(profile,name,'data'),'utf8'),name);
 } finally {await rm(temp,{recursive:true,force:true});}
});

test('缓存支持分项勾选清理、状态型缓存按需选择、受保护数据只读统计及废纸篓快照一键原位恢复',async()=>{
 const temp=await realpath(await mkdtemp(join(tmpdir(),'gravity-maint-selective-')));const profile=join(temp,'profile'),trash=join(temp,'trash'),stateDir=join(temp,'state');await mkdir(profile);await mkdir(trash);await mkdir(stateDir);
 try{
  for(const n of ['Cache','Code Cache','GPUCache','User']){await mkdir(join(profile,n));await writeFile(join(profile,n,'file.bin'),'content-'+n);}
  await writeFile(join(stateDir,'config.json'),'{"schema":2}');
  const m=new CacheMaintenance(profile,trash,async()=>false,{stateDir});
  const scan=await m.scan();
  assert.equal(scan.entries.length,3);
  assert.ok(scan.entries.every(e=>e.category==='safe'&&e.defaultSelected===true));
  assert.ok(scan.protectedBytes>0);
  assert.ok(scan.protectedEntries.some(e=>e.id==='workspace'&&e.bytes>0));
  const cleared=await m.clear(scan.token,['Cache','GPUCache']);
  assert.equal(cleared.moved,2);
  assert.equal(await readFile(join(profile,'Code Cache/file.bin'),'utf8'),'content-Code Cache');
  const history=await m.history();
  assert.equal(history.length,1);
  assert.equal(history[0].restorable,true);
  const restored=await m.restore(history[0].id);
  assert.equal(restored.restored,2);
  assert.equal(await readFile(join(profile,'Cache/file.bin'),'utf8'),'content-Cache');
  assert.equal(await readFile(join(profile,'GPUCache/file.bin'),'utf8'),'content-GPUCache');
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('Phase 1 安全性: 状态型存储（Cookies / Local Storage）严格受保护拒绝清理，无状态缓存伴随 WAL/journal 整体移动绝无硬删除', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'gravity-maint-safe-')));
  const profile = join(temp, 'profile'), trash = join(temp, 'trash');
  await mkdir(profile); await mkdir(trash);
  try {
    await writeFile(join(profile, 'Cookies'), 'main-cookie');
    await writeFile(join(profile, 'Cookies-wal'), 'wal-log');
    await writeFile(join(profile, 'CachedData'), 'main-cache-db');
    await writeFile(join(profile, 'CachedData-wal'), 'cache-wal-log');
    await writeFile(join(profile, 'CachedData-shm'), 'cache-shm-log');
    const m = new CacheMaintenance(profile, trash, async () => false);
    const scan = await m.scan();
    assert.ok(!scan.entries.some(e => e.name === 'Cookies'));
    assert.ok(scan.protectedBytes >= 11);
    await assert.rejects(m.clear(scan.token, ['Cookies']), /所选缓存项无效/);
    const scan2 = await m.scan();
    const result = await m.clear(scan2.token, ['CachedData']);
    assert.equal(result.moved, 1);
    assert.equal(await readFile(join(profile, 'Cookies'), 'utf8'), 'main-cookie');
    assert.equal(await readFile(join(result.restorePath, 'CachedData'), 'utf8'), 'main-cache-db');
    assert.equal(await readFile(join(result.restorePath, 'CachedData-wal'), 'utf8'), 'cache-wal-log');
    assert.equal(await readFile(join(result.restorePath, 'CachedData-shm'), 'utf8'), 'cache-shm-log');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('Phase 1 安全性: restore 四阶段原子恢复引擎、冲突移位至 displaced 绝不硬删除、清单标记', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'gravity-maint-atomic-restore-')));
  const profile = join(temp, 'profile'), trash = join(temp, 'trash');
  await mkdir(profile); await mkdir(trash);
  try {
    for (const n of ['Cache', 'GPUCache']) {
      await mkdir(join(profile, n));
      await writeFile(join(profile, n, 'old.bin'), 'old-' + n);
    }
    const m = new CacheMaintenance(profile, trash, async () => false);
    const scan = await m.scan();
    const cleared = await m.clear(scan.token, ['Cache', 'GPUCache']);
    assert.equal(cleared.moved, 2);

    // 模拟清理后原路径重新生成了新状态文件
    await mkdir(join(profile, 'Cache'));
    await writeFile(join(profile, 'Cache', 'new-generated.bin'), 'brand-new-state');

    // 执行四阶段原子恢复
    const history = await m.history();
    const restored = await m.restore(history[0].id);
    assert.equal(restored.restored, 2);
    assert.equal(restored.displacedCount, 1);

    // 原旧缓存成功还原
    assert.equal(await readFile(join(profile, 'Cache/old.bin'), 'utf8'), 'old-Cache');
    assert.equal(await readFile(join(profile, 'GPUCache/old.bin'), 'utf8'), 'old-GPUCache');

    // 冲突的新生成文件绝未被 rm 物理硬删除，而是安全保存在 displaced/ 目录中
    const displacedDir = join(cleared.restorePath, 'displaced');
    const displacedFiles = await (await import('node:fs/promises')).readdir(displacedDir);
    assert.ok(displacedFiles.some(f => f.startsWith('Cache.displaced-')));
    const displacedCachePath = join(displacedDir, displacedFiles.find(f => f.startsWith('Cache.displaced-')));
    assert.equal(await readFile(join(displacedCachePath, 'new-generated.bin'), 'utf8'), 'brand-new-state');

    // 恢复清单记录了 restoredAt 和 displacedCount
    const manifest = JSON.parse(await readFile(join(cleared.restorePath, '恢复清单.json'), 'utf8'));
    assert.ok(manifest.restoredAt);
    assert.equal(manifest.displacedCount, 1);
    assert.equal(manifest.displaced.length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('Phase 1 安全性: clear 清理过程中断时，主缓存文件与 WAL/journal 事务文件完整双向回滚，绝无 WAL 孤儿遗留', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'gravity-maint-cookies-rollback-')));
  const profile = join(temp, 'profile'), trash = join(temp, 'trash');
  await mkdir(profile); await mkdir(trash);
  try {
    await writeFile(join(profile, 'CachedData'), 'main-cache-content');
    await writeFile(join(profile, 'CachedData-wal'), 'wal-journal-content');
    await writeFile(join(profile, 'CachedData-shm'), 'shm-index-content');
    await mkdir(join(profile, 'GPUCache'));
    await writeFile(join(profile, 'GPUCache', 'data.bin'), 'gpu-data');

    for (const trigger of ['GPUCache', 'CachedData-wal']) {
      const maintenance = new CacheMaintenance(profile, trash, async () => !existsSync(join(profile, trigger)));
      const scan = await maintenance.scan();
      await assert.rejects(maintenance.clear(scan.token, ['GPUCache', 'CachedData']), /恢复待处理/);
      const stopped = new CacheMaintenance(profile, trash, async () => false);
      await stopped.history();
    }

    // 验证 CachedData 及其附属 WAL/SHM 文件均已原子移回 profile，绝无遗留在废纸篓中的 WAL 孤儿
    assert.equal(await readFile(join(profile, 'CachedData'), 'utf8'), 'main-cache-content');
    assert.equal(await readFile(join(profile, 'CachedData-wal'), 'utf8'), 'wal-journal-content');
    assert.equal(await readFile(join(profile, 'CachedData-shm'), 'utf8'), 'shm-index-content');

    // 废纸篓中的中断快照记录中无残留的孤儿 WAL
    const trashDirs = await (await import('node:fs/promises')).readdir(trash);
    assert.equal(trashDirs.length, 2);
    const trashFiles = await (await import('node:fs/promises')).readdir(join(trash, trashDirs[0]));
    assert.ok(!trashFiles.includes('CachedData-wal'));
    assert.ok(!trashFiles.includes('CachedData-shm'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('Phase 1 安全性: restore 预检阶段拦截目标路径符号链接及清单重复项', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'gravity-maint-restore-precheck-')));
  const profile = join(temp, 'profile'), trash = join(temp, 'trash');
  await mkdir(profile); await mkdir(trash);
  try {
    await writeFile(join(profile, 'CachedData'), 'cache-original');
    await writeFile(join(profile, 'CachedData-wal'), 'wal-original');
    const m = new CacheMaintenance(profile, trash, async () => false);
    const scan = await m.scan();
    const cleared = await m.clear(scan.token, ['CachedData']);

    // 场景 A: 目标路径下 CachedData-wal 被植入了符号链接
    const outsideTarget = join(temp, 'outside');
    await writeFile(outsideTarget, 'malicious-file');
    await (await import('node:fs/promises')).symlink(outsideTarget, join(profile, 'CachedData-wal'));

    await assert.rejects(m.restore(basename(cleared.restorePath)), /CachedData-wal 存在符号链接/);

    // 移除符号链接后，测试场景 B: 快照清单包含重复条目
    await (await import('node:fs/promises')).unlink(join(profile, 'CachedData-wal'));
    const manifestPath = join(cleared.restorePath, '恢复清单.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.moved.push({ ...manifest.moved[0] });
    await writeFile(manifestPath, JSON.stringify(manifest));

    await assert.rejects(m.restore(basename(cleared.restorePath)), /包含重复的缓存项/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});


