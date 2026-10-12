/** Selection is presentation state; opening and filesystem actions are separate. */
export class FileSelection {
  public readonly paths = new Set<string>();
  private anchor: string | null = null;
  public get anchorPath(): string | null {
    return this.anchor;
  }

  public select(path: string, order: string[], toggle = false, range = false): void {
    if (range && this.anchor && order.includes(this.anchor)) {
      const start = order.indexOf(this.anchor),
        end = order.indexOf(path);
      if (end < 0) return;
      if (!toggle) this.paths.clear();
      order
        .slice(Math.min(start, end), Math.max(start, end) + 1)
        .forEach((item) => this.paths.add(item));
      return;
    }
    if (toggle) {
      if (this.paths.has(path)) this.paths.delete(path);
      else this.paths.add(path);
    } else {
      this.paths.clear();
      this.paths.add(path);
    }
    this.anchor = path;
  }

  public retain(order: string[]): void {
    const available = new Set(order);
    for (const path of this.paths) if (!available.has(path)) this.paths.delete(path);
    if (this.anchor && !available.has(this.anchor)) this.anchor = null;
  }

  public restore(paths: string[], anchor = paths[0] ?? null): void {
    this.paths.clear();
    paths.forEach((path) => this.paths.add(path));
    this.anchor = anchor;
  }
}
