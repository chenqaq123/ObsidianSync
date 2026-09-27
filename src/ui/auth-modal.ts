import type { App } from "obsidian";
import { Modal, Setting } from "obsidian";

export class AuthCodeModal extends Modal {
  private value = "";

  constructor(
    app: App,
    private readonly authorizeUrl: string,
    private readonly onSubmit: (codeOrUrl: string) => Promise<void>,
    private readonly onCancel: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "手动完成飞书授权" });
    contentEl.createEl("p", {
      text: "如果本地回调服务不可用，可以手动完成授权：在浏览器里打开下面的链接并同意授权，页面可能显示无法访问，但地址栏里带有 code 参数，把整条地址或 code 粘贴到下面即可。",
    });

    const link = contentEl.createEl("div", { cls: "feishu-sync-path" });
    link.createEl("a", { text: this.authorizeUrl, href: this.authorizeUrl });

    new Setting(contentEl)
      .setName("授权码或回调地址")
      .setDesc("粘贴 code 参数，或直接粘贴浏览器地址栏里的完整回调地址")
      .addText((text) =>
        text.onChange((value) => {
          this.value = value;
        }),
      );

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => {
          this.onCancel();
          this.close();
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("提交授权码")
          .setCta()
          .onClick(async () => {
            const raw = this.value.trim();
            if (!raw) return;
            const code = extractCode(raw);
            await this.onSubmit(code);
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function extractCode(input: string): string {
  const value = input.trim();
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.searchParams.get("code") ?? value;
  } catch {
    return value;
  }
}
