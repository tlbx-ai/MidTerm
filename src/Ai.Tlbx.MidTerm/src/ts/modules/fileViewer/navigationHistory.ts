export interface FileVisit {
  path: string;
  scrollTop: number;
  selectedPath: string | null;
}

/** Browser-style visit history; Up is supplied independently by the server. */
export class FileNavigationHistory {
  private visits: FileVisit[] = [];
  private index = -1;
  public get current(): FileVisit | undefined {
    return this.visits[this.index];
  }
  public get canBack(): boolean {
    return this.index > 0;
  }
  public get canForward(): boolean {
    return this.index + 1 < this.visits.length;
  }
  public get backPath(): string | undefined {
    return this.visits[this.index - 1]?.path;
  }
  public get forwardPath(): string | undefined {
    return this.visits[this.index + 1]?.path;
  }

  public push(path: string): void {
    if (path === this.current?.path) return;
    this.visits.splice(this.index + 1);
    this.visits.push({ path, scrollTop: 0, selectedPath: null });
    this.index = this.visits.length - 1;
  }
  public back(): void {
    if (this.canBack) this.index--;
  }
  public forward(): void {
    if (this.canForward) this.index++;
  }
  public clear(): void {
    this.visits = [];
    this.index = -1;
  }
}
