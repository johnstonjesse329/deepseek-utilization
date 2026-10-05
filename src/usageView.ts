import * as vscode from 'vscode';
import { UsagePanelData, renderUsageHtml } from './usageHtml';

export class UsagePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private lastHtml: string | undefined;

  get visible(): boolean {
    return this.panel !== undefined;
  }

  show(data: UsagePanelData): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'peakRateClock.usage',
        'DeepSeek Usage',
        vscode.ViewColumn.Active,
        { enableScripts: false, localResourceRoots: [] },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.lastHtml = undefined;
      });
    }
    this.render(data);
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
  }

  update(data: UsagePanelData): void {
    this.render(data);
  }

  /**
   * Re-assigning `webview.html` reloads the document, which throws away scroll
   * position, so skip it when the rendered markup is unchanged.
   */
  private render(data: UsagePanelData): void {
    const panel = this.panel;
    if (!panel) {
      return;
    }
    const html = renderUsageHtml(data, Date.now());
    if (html === this.lastHtml) {
      return;
    }
    this.lastHtml = html;
    panel.webview.html = html;
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    this.lastHtml = undefined;
  }
}
