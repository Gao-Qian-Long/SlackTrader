import { check } from "@tauri-apps/plugin-updater";
import { UpdateController, type UpdateState } from "./updater";

export function mountUpdatePanel(shell: HTMLElement, currentVersion: string, native: boolean) {
  const panel = shell.querySelector<HTMLElement>(".update-panel")!;
  const status = panel.querySelector<HTMLElement>(".update-status")!;
  const notes = panel.querySelector<HTMLElement>(".update-notes")!;
  const progress = panel.querySelector<HTMLProgressElement>("progress")!;
  const checkButton = panel.querySelector<HTMLButtonElement>(".update-check")!;
  const installButton = panel.querySelector<HTMLButtonElement>(".update-install")!;
  const notice = shell.querySelector<HTMLElement>(".update-notice")!;
  let dismissed = "";
  panel.querySelector(".update-version")!.textContent = `软件更新 · v${currentVersion}`;
  const render = (state: UpdateState) => {
    status.textContent = state.message;
    notes.textContent = (state.notes ?? "").slice(0, 4000);
    notes.hidden = !state.notes;
    const busy = ["checking", "downloading", "verifying", "installing"].includes(state.phase);
    checkButton.disabled = busy;
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
  const controller = new UpdateController(check, render);
  render(controller.state);
  checkButton.addEventListener("click", () => void controller.check(true));
  installButton.addEventListener("click", () => void controller.downloadAndInstall());
  notice.querySelector(".update-view")!.addEventListener("click", () => {
    shell.querySelector(".settings")!.classList.add("open");
    panel.scrollIntoView({ block: "start" });
  });
  notice.querySelector(".update-later")!.addEventListener("click", () => { dismissed = controller.state.version ?? ""; notice.hidden = true; });
  if (!native) { status.textContent = "桌面版本支持检查更新"; checkButton.disabled = true; return () => controller.dispose(); }
  const first = window.setTimeout(() => void controller.check(), 5000);
  const interval = window.setInterval(() => void controller.check(), 6 * 60 * 60 * 1000);
  return () => { clearTimeout(first); clearInterval(interval); controller.dispose(); };
}
