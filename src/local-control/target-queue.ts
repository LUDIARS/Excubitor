export class TargetOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(target: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(target) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.tails.set(target, tail);
    void tail.finally(() => {
      if (this.tails.get(target) === tail) this.tails.delete(target);
    });
    return result;
  }

  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all(Array.from(this.tails.values()));
      await Promise.resolve();
    }
  }
}
