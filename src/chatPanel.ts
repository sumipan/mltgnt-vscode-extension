import * as vscode from 'vscode';
import { ChatClient, SessionInfo } from './chatClient';

type WebviewIncoming =
  | { type: 'ready' }
  | { type: 'send'; session: string; text: string }
  | { type: 'newSession'; topic: string; persona?: string }
  | { type: 'reloadSessions' };

type WebviewOutgoing =
  | { type: 'sessions'; items: SessionInfo[] }
  | { type: 'activeFile'; relpath: string | null; content: string | null }
  | { type: 'chunk'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'userEcho'; text: string };

export class ChatPanel {
  private static current: ChatPanel | undefined;
  public static readonly viewType = 'diary.chatPanel';

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly client: ChatClient;
  private disposables: vscode.Disposable[] = [];
  private cancelStream: (() => void) | null = null;

  public static createOrShow(extensionUri: vscode.Uri): void {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ChatPanel.viewType,
      'diary chat',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'webview')],
      }
    );
    ChatPanel.current = new ChatPanel(panel, extensionUri);
  }

  public static disposeCurrent(): void {
    ChatPanel.current?.dispose();
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    const cfg = vscode.workspace.getConfiguration('diary');
    this.client = new ChatClient(cfg.get<string>('serverUrl', 'http://127.0.0.1:8765'));

    this.initHtml();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: WebviewIncoming) => this.handleIncoming(msg),
      null,
      this.disposables
    );
    vscode.window.onDidChangeActiveTextEditor(
      () => this.pushActiveFile(),
      null,
      this.disposables
    );
  }

  private async initHtml(): Promise<void> {
    this.panel.webview.html = await this.renderHtml();
  }

  private async handleIncoming(msg: WebviewIncoming): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          this.pushActiveFile();
          await this.refreshSessions();
          return;
        case 'reloadSessions':
          await this.refreshSessions();
          return;
        case 'newSession': {
          const persona = msg.persona ?? vscode.workspace.getConfiguration('diary').get<string>('persona', '');
          await this.client.createSession(msg.topic, persona || undefined);
          await this.refreshSessions();
          return;
        }
        case 'send': {
          if (!msg.text.trim()) return;
          this.post({ type: 'userEcho', text: msg.text });
          await this.client.sendMessage(msg.session, msg.text);
          this.startStream(msg.session);
          return;
        }
      }
    } catch (e) {
      this.post({ type: 'error', message: errMessage(e) });
    }
  }

  private startStream(session: string): void {
    if (this.cancelStream) this.cancelStream();
    const timeout = vscode.workspace.getConfiguration('diary').get<number>('streamTimeoutSec', 120);
    this.cancelStream = this.client.streamResponse(
      session,
      (chunk) => this.post({ type: 'chunk', text: chunk }),
      () => this.post({ type: 'done' }),
      (err) => this.post({ type: 'error', message: err }),
      timeout
    );
  }

  private async refreshSessions(): Promise<void> {
    const items = await this.client.listSessions();
    this.post({ type: 'sessions', items });
  }

  private pushActiveFile(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.post({ type: 'activeFile', relpath: null, content: null });
      return;
    }
    const uri = editor.document.uri;
    const rel = vscode.workspace.asRelativePath(uri);
    const content = editor.document.getText();
    this.post({ type: 'activeFile', relpath: rel, content });
  }

  private post(msg: WebviewOutgoing): void {
    this.panel.webview.postMessage(msg);
  }

  private async renderHtml(): Promise<string> {
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'index.html');
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'main.js')
    );
    const cspSource = this.panel.webview.cspSource;
    const html = new TextDecoder().decode(await vscode.workspace.fs.readFile(htmlPath));
    return html
      .replaceAll('{{cspSource}}', cspSource)
      .replaceAll('{{mainJs}}', jsUri.toString());
  }

  public dispose(): void {
    if (this.cancelStream) this.cancelStream();
    ChatPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
