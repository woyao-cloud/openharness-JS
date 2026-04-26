/**
 * Tiny async queue. Producer calls `push`/`end`; consumer awaits `next` and
 * sees `EOF` when the queue has been ended. Backed by an array, no cap.
 */

export const EOF = Symbol("EOF");

export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(v: T | typeof EOF) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(item);
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.(EOF);
    }
  }

  next(): Promise<T | typeof EOF> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.ended) return Promise.resolve(EOF);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
