export class LensHttpError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`);
    this.name = 'LensHttpError';
    this.status = status;
    this.detail = detail;
  }
}
