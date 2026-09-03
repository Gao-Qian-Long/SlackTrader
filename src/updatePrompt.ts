import type { UpdateState } from "./updater";

/** One automatic question per version, with manual checks always allowing a new question. */
export class UpdatePrompt {
  private busy = false;
  private disposed = false;
  private shown = "";
  constructor(private options: {
    ask: (version: string) => Promise<boolean>;
    install: () => Promise<void>;
    readDismissed: () => string | null;
    saveDismissed: (version: string) => void;
  }) {}
  async offer(state: UpdateState, manual = false) {
    if (this.disposed || this.busy || state.phase !== "available" || !state.version) return;
    const version = state.version;
    if (!manual && (this.shown === version || this.options.readDismissed() === version)) return;
    this.busy = true;
    try {
      const accepted = await this.options.ask(version);
      if (this.disposed) return;
      this.shown = version;
      if (accepted) await this.options.install();
      else this.options.saveDismissed(version);
    } catch {
      // Keep the visible download action available if the OS dialog was interrupted.
    } finally { this.busy = false; }
  }
  dispose() { this.disposed = true; }
}
