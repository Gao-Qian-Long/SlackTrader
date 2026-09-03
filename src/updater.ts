export type UpdateEvent = { event: "Started"; data: { contentLength?: number } } | { event: "Progress"; data: { chunkLength: number } } | { event: "Finished" };
export interface ReleaseUpdate {
  version: string;
  body?: string;
  download(listener: (event: UpdateEvent) => void, options: { timeout: number }): Promise<void>;
  install(): Promise<void>;
  close(): Promise<void>;
}
export type UpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "verifying" | "installing" | "error";
export interface UpdateState { phase: UpdatePhase; version?: string; notes?: string; received: number; total?: number; message: string }
export type CheckUpdate = (options: { timeout: number; allowDowngrades: boolean }) => Promise<ReleaseUpdate | null>;

export function updateErrorMessage(error: unknown): string {
  const code = typeof error === "object" && error ? String((error as { code?: string }).code ?? "") : "";
  const messages: Record<string, string> = {
    NETWORK_TIMEOUT: "更新检查超时，请重试或切换更新网络连接方式",
    NETWORK_FAILED: "更新服务器连接失败，请检查网络或切换直连／系统代理",
    MANIFEST_UNAVAILABLE: "服务器尚未返回更新清单，请稍后重试",
    MANIFEST_INVALID: "更新清单格式异常，请稍后重试",
    PLATFORM_MISSING: "该版本尚未提供当前系统的安装包",
  };
  return messages[code] ?? "更新检查未完成，请重试或切换更新网络连接方式";
}

/** Native updater verifies the signature before download() resolves. No automatic install. */
export class UpdateController {
  state: UpdateState = { phase: "idle", received: 0, message: "启动后自动检查，也可手动检查" };
  private release: ReleaseUpdate | null = null;
  private disposed = false;
  private busy = false;
  constructor(private checkUpdate: CheckUpdate, private render: (state: UpdateState) => void) {}
  private publish(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.render(this.state);
  }
  async check(manual = false) {
    if (this.disposed || this.busy || (!manual && this.release)) return false;
    this.busy = true;
    const previous = this.state;
    this.publish({ phase: "checking", message: "正在检查 GitHub 正式版本…" });
    try {
      const release = await this.checkUpdate({ timeout: 20_000, allowDowngrades: false });
      if (this.disposed) { await release?.close(); return false; }
      await this.release?.close().catch(() => {});
      this.release = release;
      this.publish({ phase: release ? "available" : "current", version: release?.version, notes: release?.body,
        received: 0, total: undefined, message: release ? `发现新版本 v${release.version}` : "已是最新正式版本" });
      return true;
    } catch (error) {
      // A missing manifest / network error is not proof that the app is current.
      this.publish({ ...previous, phase: this.release ? "available" : "error", message: updateErrorMessage(error) });
      return false;
    } finally { this.busy = false; }
  }
  async downloadAndInstall() {
    if (this.disposed || this.busy || !this.release) return;
    this.busy = true;
    this.publish({ phase: "downloading", received: 0, total: undefined, message: "正在下载，完成校验后打开安装向导…" });
    let installing = false;
    try {
      await this.release.download(event => {
        if (event.event === "Started") this.publish({ total: event.data.contentLength });
        if (event.event === "Progress") this.publish({ received: this.state.received + event.data.chunkLength });
        if (event.event === "Finished") this.publish({ phase: "verifying", message: "正在校验安装包签名…" });
      }, { timeout: 300_000 });
      if (this.disposed) return;
      installing = true;
      this.publish({ phase: "installing", message: "正在打开安装向导，软件将退出；完成后请重新打开" });
      await this.release.install();
      // On Windows a successful launch exits the native app. Keep buttons locked.
    } catch {
      this.publish({ phase: "available", message: installing ? "安装向导启动失败，请重试；当前数据已保留" : "下载或签名校验失败，请重试；未启动安装" });
    } finally { if (this.state.phase !== "installing") this.busy = false; }
  }
  dispose() { this.disposed = true; void this.release?.close().catch(() => {}); }
}
