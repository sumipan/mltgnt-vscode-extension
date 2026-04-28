"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode2 = __toESM(require("vscode"));

// src/chatPanel.ts
var vscode = __toESM(require("vscode"));

// src/chatClient.ts
var ChatClient = class {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
  }
  async sendMessage(session, text) {
    if (!text.trim()) {
      throw new Error("empty message");
    }
    await this.requestJson("POST", "/chat", { session, text });
  }
  async listSessions() {
    const res = await this.requestJson("GET", "/sessions");
    return res;
  }
  async createSession(topic, persona) {
    return this.requestJson("POST", "/sessions", { topic, persona });
  }
  /**
   * SSE で /chat/stream を購読する。
   * 戻り値はキャンセル関数。サーバー無応答 5 秒でエラー、SSE 切断後 3 秒で最大 3 回再接続。
   */
  streamResponse(session, onChunk, onDone, onError, timeoutSec = 120) {
    let cancelled = false;
    let attempt = 0;
    const maxAttempts = 3;
    const reconnectDelayMs = 3e3;
    const idleTimeoutMs = 5e3;
    let activeController = null;
    let idleTimer = null;
    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
    };
    const cancel = () => {
      cancelled = true;
      cleanup();
    };
    const connect = async () => {
      if (cancelled) return;
      attempt += 1;
      const controller = new AbortController();
      activeController = controller;
      const url = new URL("/chat/stream", this.serverUrl);
      url.searchParams.set("session", session);
      url.searchParams.set("timeout", String(timeoutSec));
      const armIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          onError("SSE idle timeout");
          cleanup();
          tryReconnect();
        }, idleTimeoutMs);
      };
      const connectTimer = setTimeout(() => {
        onError("SSE connect timeout");
        cleanup();
        tryReconnect();
      }, idleTimeoutMs);
      try {
        const response = await fetch(url.toString(), {
          method: "GET",
          headers: { Accept: "text/event-stream" },
          signal: controller.signal
        });
        clearTimeout(connectTimer);
        if (response.status >= 400) {
          onError(`SSE HTTP ${response.status}`);
          cancel();
          return;
        }
        if (!response.body) {
          onError("SSE no response body");
          cancel();
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        armIdle();
        while (true) {
          let result;
          try {
            result = await reader.read();
          } catch (e) {
            if (cancelled) return;
            onError(`SSE response error: ${e instanceof Error ? e.message : String(e)}`);
            cleanup();
            tryReconnect();
            return;
          }
          if (result.done) {
            cleanup();
            if (!cancelled) tryReconnect();
            return;
          }
          armIdle();
          buffer += decoder.decode(result.value, { stream: true });
          let sepIdx;
          while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            const frame = parseSSEFrame(raw);
            if (!frame) continue;
            if (frame.event === "chunk") {
              onChunk(frame.data);
            } else if (frame.event === "done") {
              cleanup();
              onDone();
              cancelled = true;
              return;
            } else if (frame.event === "error") {
              onError(frame.data || "SSE error");
              cleanup();
              cancelled = true;
              return;
            }
          }
        }
      } catch (e) {
        clearTimeout(connectTimer);
        if (cancelled) return;
        onError(`SSE request error: ${e instanceof Error ? e.message : String(e)}`);
        cleanup();
        tryReconnect();
      }
    };
    const tryReconnect = () => {
      cleanup();
      if (cancelled) return;
      if (attempt >= maxAttempts) {
        onError("SSE max retries exhausted");
        return;
      }
      setTimeout(connect, reconnectDelayMs);
    };
    connect();
    return cancel;
  }
  async requestJson(method, pathStr, body) {
    const url = new URL(pathStr, this.serverUrl);
    const payload = body !== void 0 ? JSON.stringify(body) : void 0;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 5e3);
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          Accept: "application/json",
          ...payload ? {
            "Content-Type": "application/json",
            "Content-Length": String(new TextEncoder().encode(payload).byteLength)
          } : {}
        },
        body: payload,
        signal: controller.signal
      });
      const text = await response.text();
      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
      return text ? JSON.parse(text) : void 0;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error("HTTP request timeout (5s)");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
};
function parseSSEFrame(raw) {
  let event = "message";
  const dataLines = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0 && event === "message") return null;
  return { event, data: dataLines.join("\n") };
}

// src/chatPanel.ts
var ChatPanel = class _ChatPanel {
  static current;
  static viewType = "diary.chatPanel";
  panel;
  extensionUri;
  client;
  disposables = [];
  cancelStream = null;
  static createOrShow(extensionUri) {
    if (_ChatPanel.current) {
      _ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      _ChatPanel.viewType,
      "diary chat",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "src", "webview")]
      }
    );
    _ChatPanel.current = new _ChatPanel(panel, extensionUri);
  }
  static disposeCurrent() {
    _ChatPanel.current?.dispose();
  }
  constructor(panel, extensionUri) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    const cfg = vscode.workspace.getConfiguration("diary");
    this.client = new ChatClient(cfg.get("serverUrl", "http://127.0.0.1:8765"));
    this.initHtml();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleIncoming(msg),
      null,
      this.disposables
    );
    vscode.window.onDidChangeActiveTextEditor(
      () => this.pushActiveFile(),
      null,
      this.disposables
    );
  }
  async initHtml() {
    this.panel.webview.html = await this.renderHtml();
  }
  async handleIncoming(msg) {
    try {
      switch (msg.type) {
        case "ready":
          this.pushActiveFile();
          await this.refreshSessions();
          return;
        case "reloadSessions":
          await this.refreshSessions();
          return;
        case "newSession": {
          const persona = msg.persona ?? vscode.workspace.getConfiguration("diary").get("persona", "");
          await this.client.createSession(msg.topic, persona || void 0);
          await this.refreshSessions();
          return;
        }
        case "send": {
          if (!msg.text.trim()) return;
          this.post({ type: "userEcho", text: msg.text });
          await this.client.sendMessage(msg.session, msg.text);
          this.startStream(msg.session);
          return;
        }
      }
    } catch (e) {
      this.post({ type: "error", message: errMessage(e) });
    }
  }
  startStream(session) {
    if (this.cancelStream) this.cancelStream();
    const timeout = vscode.workspace.getConfiguration("diary").get("streamTimeoutSec", 120);
    this.cancelStream = this.client.streamResponse(
      session,
      (chunk) => this.post({ type: "chunk", text: chunk }),
      () => this.post({ type: "done" }),
      (err) => this.post({ type: "error", message: err }),
      timeout
    );
  }
  async refreshSessions() {
    const items = await this.client.listSessions();
    this.post({ type: "sessions", items });
  }
  pushActiveFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.post({ type: "activeFile", relpath: null, content: null });
      return;
    }
    const uri = editor.document.uri;
    const rel = vscode.workspace.asRelativePath(uri);
    const content = editor.document.getText();
    this.post({ type: "activeFile", relpath: rel, content });
  }
  post(msg) {
    this.panel.webview.postMessage(msg);
  }
  async renderHtml() {
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, "src", "webview", "index.html");
    const jsUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "src", "webview", "main.js")
    );
    const cspSource = this.panel.webview.cspSource;
    const html = new TextDecoder().decode(await vscode.workspace.fs.readFile(htmlPath));
    return html.replaceAll("{{cspSource}}", cspSource).replaceAll("{{mainJs}}", jsUri.toString());
  }
  dispose() {
    if (this.cancelStream) this.cancelStream();
    _ChatPanel.current = void 0;
    this.panel.dispose();
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
  }
};
function errMessage(e) {
  if (e instanceof Error) return e.message;
  return String(e);
}

// src/extension.ts
function activate(context) {
  const open = vscode2.commands.registerCommand("diary.openChatPanel", () => {
    ChatPanel.createOrShow(context.extensionUri);
  });
  context.subscriptions.push(open);
}
function deactivate() {
  ChatPanel.disposeCurrent();
}
//# sourceMappingURL=extension.js.map
