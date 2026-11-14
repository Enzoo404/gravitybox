import test from "node:test";
import { describe as describeContractGroup } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceDigest, collectReleaseArtifacts, assertReleaseArtifacts } from "../tools/release-integrity.mjs";
import { checkDocs } from "../tools/check-docs.mjs";

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("发行完整性 · optimization-20261022", { concurrency: false }, async () => {

const fixture=async fn=>{const dir=await mkdtemp(join(tmpdir(),'gb-opt-'));try{return await fn(dir);}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50});}};

test('文档检查重算源码摘要，旧stamp不能掩盖当前修改',()=>fixture(async dir=>{
 for(const name of ['src','runtime','native','tools','test','dict','ui-strings','assets','licenses','.cache'])await mkdir(join(dir,name));
 for(const name of ['package-lock.json','tsconfig.json','README.md','THIRD_PARTY_NOTICES.md'])await writeFile(join(dir,name),'fixture');await writeFile(join(dir,'package.json'),'{"version":"0.9.0"}');const digest=await sourceDigest(dir);await writeFile(join(dir,'.cache','verified-release.json'),JSON.stringify({digest}));await writeFile(join(dir,'src','change.ts'),'changed');const result=await checkDocs({root:dir,installedApp:join(dir,'missing'),accountsPath:join(dir,'missing.json')});assert.ok(result.issues.some(i=>i.code==='SOURCE_NOT_VERIFIED'));
}));
});

// Fixture state and hooks are scoped to this group; child cases run serially.
describeContractGroup("发行完整性 · repair-20261023", { concurrency: false }, async () => {
async function fixture(t){const d=await mkdtemp(join(tmpdir(),'gb-repair-'));t.after(async()=>{try{await rm(d,{recursive:true,force:true,maxRetries:10,retryDelay:50});}catch{}});return d;}
test('已验证脚本清单拒绝仅改dist，源码未变化也不能打包',async t=>{const d=await fixture(t);await mkdir(join(d,'src'));await mkdir(join(d,'dist'));await writeFile(join(d,'src/a.ts'),'source');await writeFile(join(d,'dist/a.js'),'A');await writeFile(join(d,'dist/engine.js'),'runtime');const manifest=await collectReleaseArtifacts(d);await assertReleaseArtifacts(d,manifest);await writeFile(join(d,'dist/a.js'),'B');await assert.rejects(assertReleaseArtifacts(d,manifest),/已变化/);});
});
