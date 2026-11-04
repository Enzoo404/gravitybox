import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * ReentrantMutex:
 * 1. 严格支持同上下文内的安全重入（基于活动 lockId 校验，避免未 await 异步任务脱逸逃逸锁）；
 * 2. 排队超时机制（默认 15s），防止因文件系统异常或外部 I/O 挂起造成整个写入链永久死锁；
 * 3. 排队超时放弃时链式传递 release，确保后续排队者不被阻塞；
 * 4. 实时暴露 queueLength 与 isLocked 状态，供可观测性与排错。
 */
export class ReentrantMutex {
  private tail: Promise<void> = Promise.resolve();
  private storage = new AsyncLocalStorage<number>();
  private activeLockId = 0;
  private nextLockId = 0;
  private queued = 0;

  get queueLength(): number {
    return this.queued;
  }

  get isLocked(): boolean {
    return this.activeLockId !== 0;
  }

  async run<T>(action: () => Promise<T>, opts: { timeoutMs?: number; label?: string } = {}): Promise<T> {
    const storeId = this.storage.getStore();
    // 仅当当前执行上下文处于活动状态且持有的锁 ID 与当前正在持有的锁一致时，才允许可重入直接执行
    if (storeId !== undefined && storeId === this.activeLockId) {
      return await action();
    }

    const { timeoutMs = 15000, label = 'mutex' } = opts;
    const current = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(res => { release = res; });
    this.queued++;

    let timer: NodeJS.Timeout | undefined;
    let acquired = false;
    try {
      if (timeoutMs > 0) {
        await Promise.race([
          current.catch(() => {}),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const err = new Error(`${label} 排队超时`);
              (err as any).code = 'ELOCKTIMEOUT';
              reject(err);
            }, timeoutMs);
          }),
        ]);
      } else {
        await current.catch(() => {});
      }
      acquired = true;
      const lockId = ++this.nextLockId;
      this.activeLockId = lockId;
      try {
        return await this.storage.run(lockId, action);
      } finally {
        this.activeLockId = 0;
      }
    } finally {
      if (timer) clearTimeout(timer);
      this.queued--;
      if (acquired) {
        release();
      } else {
        // 等待前置锁完成并放行下一个排队者，避免队列断裂
        current.finally(() => release());
      }
    }
  }
}
