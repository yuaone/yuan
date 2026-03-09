/**
 * @yuan/cli — DesignRenderer
 * Terminal UI for Design Mode.
 */

import type { DevServerState, DesignEvent, DOMSnapshot } from "@yuan/core";

let chalk: any;
async function getChalk() {
  if (!chalk) chalk = (await import("chalk")).default;
  return chalk;
}

export class DesignRenderer {
  async showBanner(server: DevServerState): Promise<void> {
    const c = await getChalk();
    const banner = [
      "",
      c.cyan("╭─ 🎨 YUAN Design Mode ─────────────────────────────╮"),
      c.cyan("│") + ` 서버: ${c.green(server.url)}` + " ".repeat(Math.max(0, 37 - server.url.length)) + c.cyan("│"),
      c.cyan("│") + ` 프레임워크: ${c.yellow(server.framework)}` + " ".repeat(Math.max(0, 33 - server.framework.length)) + c.cyan("│"),
      c.cyan("│") + ` 상태: ${c.green("연결됨 ●")}` + " ".repeat(27) + c.cyan("│"),
      c.cyan("╰────────────────────────────────────────────────────╯"),
      "",
      c.dim("  브라우저에서 위 링크를 열고 작업하세요."),
      c.dim("  채팅으로 디자인 지시를 내리면 실시간 반영됩니다."),
      c.dim("  Ctrl+C로 종료합니다."),
      "",
    ];
    console.log(banner.join("\n"));
  }

  async showDOMStatus(snapshot: DOMSnapshot): Promise<void> {
    const c = await getChalk();
    console.log(c.dim(`[DOM] ${snapshot.url} — ${snapshot.accessibilityTree.split("\n").length} lines`));
  }

  async showEvent(event: DesignEvent): Promise<void> {
    const c = await getChalk();
    switch (event.type) {
      case "design:file_changed":
        console.log(c.green(`  📝 수정: ${event.data.file}`));
        break;
      case "design:hmr_detected":
        console.log(c.green("  ✅ HMR 반영 완료. 확인해보세요."));
        break;
      case "design:security_warning":
        for (const w of (event.data.warnings as string[])) {
          console.log(c.red(`  ${w}`));
        }
        break;
      case "design:browser_connected":
        console.log(c.green("  🌐 브라우저 연결됨"));
        break;
      default:
        console.log(c.dim(`  [${event.type}]`));
    }
  }

  async showDiff(filePath: string, oldLine: string, newLine: string): Promise<void> {
    const c = await getChalk();
    console.log(c.dim(`\n  diff: ${filePath}`));
    console.log(c.red(`  - ${oldLine}`));
    console.log(c.green(`  + ${newLine}`));
    console.log();
  }

  async showPrompt(): Promise<void> {
    const c = await getChalk();
    process.stdout.write(c.cyan("\nYou: "));
  }

  async showAgentPrefix(): Promise<void> {
    const c = await getChalk();
    process.stdout.write(c.magenta("\nYUAN: "));
  }

  async showError(message: string): Promise<void> {
    const c = await getChalk();
    console.log(c.red(`  ❌ ${message}`));
  }

  async showInfo(message: string): Promise<void> {
    const c = await getChalk();
    console.log(c.dim(`  ${message}`));
  }
}
