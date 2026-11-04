import test from 'node:test';
import assert from 'node:assert/strict';
import 'node:fs/promises';
import 'node:os';import 'node:path';import 'node:http';
import { extractUiStrings, extractedKind } from '../dist/bundle.js';
import '../dist/controller.js';import '../dist/dictionary.js';
test('静态提取保留首个有效组件语义，不把通用文字全部硬编码成 ui',()=>{
 const entries=extractUiStrings('({placeholder:"Find hidden settings",tooltip:"Inspect public status",confirmLabel:"Apply changes",heading:"Connection status"});React.createElement("button",{},"Review changes");');
 for(const [key,kind]of[['Find hidden settings','placeholder'],['Inspect public status','tooltip'],['Apply changes','button'],['Connection status','heading'],['Review changes','button']])assert.equal(extractedKind(entries.find(e=>e.text===key)?.kinds),kind,key);
 assert.equal(extractedKind(['template','prop']),undefined);
});
