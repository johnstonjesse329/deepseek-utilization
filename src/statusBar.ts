import * as vscode from 'vscode';

export interface StatusBarState {
  readonly text: string;
  /** Markdown source for the hover; only reassigned when it actually changes. */
  readonly tooltip: string;
  readonly isPeak: boolean;
}

export class ClockStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem | undefined;
  private lastText: string | undefined;
  private lastTooltip: string | undefined;
  private lastIsPeak: boolean | undefined;

  constructor(private alignment: 'left' | 'right') {
    this.item = this.create();
  }

  private create(): vscode.StatusBarItem {
    const item = vscode.window.createStatusBarItem(
      this.alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right,
      1000,
    );
    item.name = 'DeepSeek Utilization';
    item.command = 'peakRateClock.showSchedule';
    return item;
  }

  setAlignment(alignment: 'left' | 'right'): void {
    if (alignment === this.alignment) {
      return;
    }
    this.alignment = alignment;
    this.item?.dispose();
    this.item = this.create();
    this.lastText = undefined;
    this.lastTooltip = undefined;
    this.lastIsPeak = undefined;
  }

  /**
   * Applies only the fields that changed. Reassigning `tooltip` on every tick
   * re-renders the hover preview, which reads as flickering, so this compares
   * before writing.
   */
  update(state: StatusBarState): void {
    const item = this.item;
    if (!item) {
      return;
    }

    if (state.text !== this.lastText) {
      item.text = state.text;
      this.lastText = state.text;
    }

    if (state.tooltip !== this.lastTooltip) {
      const tooltip = new vscode.MarkdownString(state.tooltip);
      tooltip.supportThemeIcons = true;
      tooltip.isTrusted = true;
      item.tooltip = tooltip;
      this.lastTooltip = state.tooltip;
    }

    if (state.isPeak !== this.lastIsPeak) {
      item.color = new vscode.ThemeColor(state.isPeak ? 'charts.red' : 'charts.green');
      this.lastIsPeak = state.isPeak;
    }

    item.show();
  }

  dispose(): void {
    this.item?.dispose();
    this.item = undefined;
  }
}
