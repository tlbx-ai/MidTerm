export class SessionSubscriptionSet {
  private readonly current = new Set<string>();

  sync(
    sessionIds: string[],
    subscribe: (sessionId: string) => void,
    unsubscribe: (sessionId: string) => void,
  ): void {
    const next = new Set(sessionIds.filter(Boolean));
    for (const sessionId of this.current) {
      if (!next.has(sessionId)) {
        unsubscribe(sessionId);
      }
    }
    for (const sessionId of next) {
      if (!this.current.has(sessionId)) {
        subscribe(sessionId);
      }
    }
    this.current.clear();
    for (const sessionId of next) {
      this.current.add(sessionId);
    }
  }

  remove(sessionId: string, unsubscribe: (sessionId: string) => void): void {
    if (this.current.delete(sessionId)) {
      unsubscribe(sessionId);
    }
  }
}
