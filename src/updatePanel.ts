import { Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { UpdateController, type UpdateState } from "./updater";
import { UpdatePrompt } from "./updatePrompt";

export function mountUpdatePanel(shell: HTMLElement, currentVersion: string, native: boolean, revealProgress: () => Promise<void> = async () => {}) {
  const panel = shell.querySelector<HTMLElement>(".update-panel")!;
  const status = panel.querySelector<HTMLElement>(".update-status")!;
  const notes = panel.querySelector<HTMLElement>(".update-notes")!;
  const progress = panel.querySelector<HTMLProgressElement>("progress")!;
  const checkButton = panel.querySelector<HTMLButtonElement>(".update-check")!;
  const installButton = panel.querySelector<HTMLButtonElement>(".update-install")!;
  const notice = shell.querySelector<HTMLElement>(".update-notice")!;
  const network = panel.querySelector<HTMLSelectElement>(".update-network")!;
  const route = panel.querySelector<HTMLElement>(".update-route")!;
  const savedNetwork = localStorage.getItem("updateNetwork") ?? "auto";
  network.value = ["auto", "direct", "system"].includes(savedNetwork) ? savedNetwork : "auto";
  network.addEventListener("change", () => localStorage.setItem("updateNetwork", network.value));
  let dismissed = "";
  panel.querySelector(".update-version")!.textContent = `软件更新 · v${currentVersion}`;
  const render = (state: UpdateState) => {
    status.textContent = state.message;
    notes.textContent = (state.notes ?? "").slice(0, 4000);
    notes.hidden = !state.notes;
    const busy = ["checking", "downloading", "verifying", "installing"].includes(state.phase);
    checkButton.disabled = busy;
    network.disabled = busy;
    installButton.hidden = !state.version;
    installButton.disabled = busy;
    installButton.textContent = state.phase === "downloading" ? "下载中…" : "下载并安装";
    progress.hidden = !["downloading", "verifying"].includes(state.phase);
    if (state.total && state.total > 0) { progress.max = state.total; progress.value = Math.min(state.received, state.total); }
    else progress.removeAttribute("value");
    notice.hidden = state.phase !== "available" || state.version === dismissed;
    notice.querySelector("span")!.textContent = state.version ? `新版本 v${state.version}` : "";
    shell.querySelector(".settings-button")!.classList.toggle("has-update", Boolean(state.version));
  };
  const controller = new UpdateController(async () => {
    type Metadata = ConstructorParameters<typeof Update>[0];
    const result = await invoke<{ update: Metadata | null; route: string }>("check_app_update", { mode: network.value });
    route.textContent = `最近成功连接：${result.route === "direct" ? "直连" : "系统代理"}`;
    return result.update ? new Update(result.update) : null;
  }, render);
  const prompt = new UpdatePrompt({
    ask: version => ask(`发现新版本 v${version}，当前为 v${currentVersion}。\n是否下载并更新？\n\n签名校验通过后会退出软件并打开安装向导，覆盖安装保留持仓和设置。`, {
      title: "SlackTrader 软件更新", kind: "info", okLabel: "下载并更新", cancelLabel: "稍后",
    }),
    install: async () => { await revealProgress(); await controller.downloadAndInstall(); },
    readDismissed: () => localStorage.getItem("updateDismissedVersion"),
    saveDismissed: version => localStorage.setItem("updateDismissedVersion", version),
  });
  let checking = false;
  const checkAndPrompt = async (manual = false) => {
    if (checking) return;
    checking = true;
    try { if (await controller.check(manual)) await prompt.offer(controller.state, manual); }
    finally { checking = false; }
  };
  render(controller.state);
  checkButton.addEventListener("click", () => void checkAndPrompt(true));
  installButton.addEventListener("click", () => void controller.downloadAndInstall());
  notice.querySelector(".update-view")!.addEventListener("click", () => {
    shell.querySelector(".settings")!.classList.add("open");
    panel.scrollIntoView({ block: "start" });
  });
  notice.querySelector(".update-later")!.addEventListener("click", () => { dismissed = controller.state.version ?? ""; notice.hidden = true; });
  if (!native) { status.textContent = "桌面版本支持检查更新"; checkButton.disabled = true; return () => { prompt.dispose(); controller.dispose(); }; }
  const first = window.setTimeout(() => void checkAndPrompt(), 5000);
  const interval = window.setInterval(() => void checkAndPrompt(), 6 * 60 * 60 * 1000);
  return () => { clearTimeout(first); clearInterval(interval); prompt.dispose(); controller.dispose(); };
}
