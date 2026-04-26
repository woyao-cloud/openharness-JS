/**
 * Promise-chain mutex. `acquire()` resolves once any prior holders have
 * called their release function, guaranteeing FIFO ordering — same shape
 * as Python's `asyncio.Lock`.
 */

export class Mutex {
  private chain: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.chain;
    this.chain = next;
    await previous;
    return release;
  }
}
