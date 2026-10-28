/** Tracks keepalive pings in flight so the HTTP hooks can tell a ping from a real `generate` call. */
export class PingTracker {
  /** Pending `send()` calls per session. */
  private readonly inFlight = new Map<string, number>();
  /**
   * Resolves once the ping's response has been reported to the engine; the
   * engine counts a ping as failed if `send()` settles before that.
   */
  private readonly responses = new Map<string, Promise<void>>();

  isPing(kind: string, sessionID: string): boolean {
    return kind === 'generate' && (this.inFlight.get(sessionID) ?? 0) > 0;
  }

  /** Runs `generate` as a ping and settles once its response has been reported. */
  async send(sessionID: string, generate: () => Promise<unknown>): Promise<void> {
    this.inFlight.set(sessionID, (this.inFlight.get(sessionID) ?? 0) + 1);
    try {
      await generate();
      await this.responses.get(sessionID);
    } finally {
      const left = (this.inFlight.get(sessionID) ?? 1) - 1;
      if (left > 0) {
        this.inFlight.set(sessionID, left);
      } else {
        this.inFlight.delete(sessionID);
        this.responses.delete(sessionID);
      }
    }
  }

  /** Records the promise that settles once a ping's response has been reported. */
  responded(sessionID: string, reported: Promise<void>): void {
    this.responses.set(sessionID, reported);
  }
}
