import * as vscode from 'vscode';
import { ChatPanel } from './chatPanel';

export function activate(context: vscode.ExtensionContext): void {
  const open = vscode.commands.registerCommand('diary.openChatPanel', () => {
    ChatPanel.createOrShow(context.extensionUri);
  });
  context.subscriptions.push(open);
}

export function deactivate(): void {
  ChatPanel.disposeCurrent();
}
