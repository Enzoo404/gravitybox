import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import '../dist/hud.js';

const { DatabaseSync } = await import('node:sqlite');

test('SQLite 并发读写压力与无锁事务验证', async () => {
  const tmpDir = path.join(os.tmpdir(), `gravitybox-sqlite-stress-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbFile = path.join(tmpDir, 'stress_test.db');

  try {
    // 1. 初始化数据库并开启 WAL 模式
    const initDb = new DatabaseSync(dbFile);
    initDb.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE steps (
        idx INTEGER PRIMARY KEY,
        step_type INTEGER NOT NULL,
        status INTEGER NOT NULL,
        metadata BLOB
      );
      CREATE TABLE gen_metadata (
        idx INTEGER PRIMARY KEY,
        data BLOB,
        size INTEGER
      );
    `);
    initDb.close();

    let writerRunning = true;
    let writerWrites = 0;
    let writerErrors = [];
    let readerQueries = 0;
    let readerErrors = [];

    // 2. 模拟 Antigravity 宿主进程后台高频写事务
    const writerPromise = (async () => {
      const writerDb = new DatabaseSync(dbFile);
      writerDb.exec('PRAGMA busy_timeout = 2000;');
      let idx = 0;
      while (writerRunning) {
        try {
          writerDb.exec('BEGIN IMMEDIATE;');
          const buf = Buffer.alloc(1024, (idx % 255));
          writerDb.prepare('INSERT INTO steps (idx, step_type, status, metadata) VALUES (?, ?, ?, ?)').run(
            idx,
            idx % 2 === 0 ? 15 : 132,
            1,
            buf
          );
          writerDb.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(
            idx,
            buf,
            buf.length
          );
          writerDb.exec('COMMIT;');
          writerWrites++;
          idx++;
        } catch (err) {
          writerErrors.push(err.message);
          try { writerDb.exec('ROLLBACK;'); } catch (_) {}
        }
        await new Promise(r => setImmediate(r));
      }
      writerDb.close();
    })();

    // 3. 模拟 GravityBox 5 个并发读取客户端高频只读轮询
    const readerClients = 5;
    const readerPromises = Array.from({ length: readerClients }, async (_, clientId) => {
      let readCount = 0;
      while (writerRunning && readCount < 100) {
        try {
          // 采用文档规范参数
          const readDb = new DatabaseSync(dbFile, { readOnly: true });
          readDb.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000; PRAGMA read_uncommitted = ON;');
          
          const maxStep = readDb.prepare('SELECT MAX(idx) as maxIdx, COUNT(*) as cnt FROM steps').get();
          const maxGen = readDb.prepare('SELECT MAX(idx) as maxIdx, COUNT(*) as cnt FROM gen_metadata').get();
          
          assert.ok(maxStep.cnt >= 0);
          assert.ok(maxGen.cnt >= 0);

          readDb.close();
          readerQueries++;
          readCount++;
        } catch (err) {
          readerErrors.push(`Client ${clientId}: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 2));
      }
    });

    // 运行 1.5 秒压力测试
    await Promise.race([
      Promise.all(readerPromises),
      new Promise(r => setTimeout(r, 1500))
    ]);

    writerRunning = false;
    await writerPromise;

    console.log(`压力测试统计: Writer 写入 ${writerWrites} 次 (错误: ${writerErrors.length}), Readers 查询 ${readerQueries} 次 (错误: ${readerErrors.length})`);
    if (readerErrors.length > 0) {
      console.log('Reader 错误样本:', readerErrors.slice(0, 3));
    }
    if (writerErrors.length > 0) {
      console.log('Writer 错误样本:', writerErrors.slice(0, 3));
    }

    assert.equal(writerErrors.length, 0, 'Writer 不应遭遇死锁或 SQLITE_BUSY');
    assert.equal(readerErrors.length, 0, '只读 Readers 不应遭遇 SQLITE_BUSY 或读取崩溃');
    assert.ok(writerWrites > 10, 'Writer 应该成功完成了多次写入');
    assert.ok(readerQueries > 20, 'Readers 应该成功完成了多次并发读取');

  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {}
  }
});
