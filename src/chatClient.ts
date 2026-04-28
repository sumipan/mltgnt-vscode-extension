export interface SessionInfo {
  session: string;
  path: string;
  mtime: number;
}

interface SSEFrame {
  event: string;
  data: string;
}

/**
 * chat-server.py との HTTP/SSE 通信レイヤー。
 * Web Extension 対応のため fetch + ReadableStream で実装。
 */
export class ChatClient {
  constructor(private serverUrl: string) {}

  async sendMessage(session: string, text: string): Promise<void> {
    if (!text.trim()) {
      throw new Error('empty message');
    }
    await this.requestJson('POST', '/chat', { session, text });
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await this.requestJson<SessionInfo[]>('GET', '/sessions');
    return res;
  }

  async createSession(topic: string, persona?: string): Promise<SessionInfo> {
    return this.requestJson<SessionInfo>('POST', '/sessions', { topic, persona });
  }

  /**
   * SSE で /chat/stream を購読する。
   * 戻り値はキャンセル関数。初期応答 5 秒でエラー、SSE 切断後 3 秒で最大 3 回再接続。
   * keepalive コメントをサーバーが送るため、レスポンス受信後のアイドルタイマーは使用しない。
   */
  streamResponse(
    session: string,
    onChunk: (chunk: string) => void,
    onDone: () => void,
    onError: (msg: string) => void,
    timeoutSec: number = 120
  ): () => void {
    let cancelled = false;
    let retrying = false;
    let attempt = 0;
    const maxAttempts = 3;
    const reconnectDelayMs = 3000;
    const connectTimeoutMs = 5000;
    let activeController: AbortController | null = null;

    const cleanup = () => {
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

      const url = new URL('/chat/stream', this.serverUrl);
      url.searchParams.set('session', session);
      url.searchParams.set('timeout', String(timeoutSec));

      const connectTimer = setTimeout(() => {
        if (retrying || cancelled) return;
        onError('SSE connect timeout');
        tryReconnect();
      }, connectTimeoutMs);

      try {
        const response = await fetch(url.toString(), {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });

        clearTimeout(connectTimer);

        if (response.status >= 400) {
          onError(`SSE HTTP ${response.status}`);
          cancel();
          return;
        }

        if (!response.body) {
          onError('SSE no response body');
          cancel();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          let result: ReadableStreamReadResult<Uint8Array>;
          try {
            result = await reader.read();
          } catch (e) {
            if (retrying || cancelled) return;
            onError(`SSE response error: ${e instanceof Error ? e.message : String(e)}`);
            tryReconnect();
            return;
          }

          if (result.done) {
            cleanup();
            if (!cancelled) tryReconnect();
            return;
          }

          buffer += decoder.decode(result.value, { stream: true });

          let sepIdx: number;
          while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, sepIdx);
            buffer = buffer.slice(sepIdx + 2);
            const frame = parseSSEFrame(raw);
            if (!frame) continue;
            if (frame.event === 'chunk') {
              onChunk(frame.data);
            } else if (frame.event === 'done') {
              cleanup();
              onDone();
              cancelled = true;
              return;
            } else if (frame.event === 'error') {
              onError(frame.data || 'SSE error');
              cancel();
              return;
            }
          }
        }
      } catch (e) {
        clearTimeout(connectTimer);
        if (retrying || cancelled) return;
        onError(`SSE request error: ${e instanceof Error ? e.message : String(e)}`);
        tryReconnect();
      }
    };

    const tryReconnect = () => {
      if (cancelled || retrying) return;
      retrying = true;
      cleanup();
      if (attempt >= maxAttempts) {
        onError('SSE max retries exhausted');
        return;
      }
      setTimeout(() => {
        retrying = false;
        connect();
      }, reconnectDelayMs);
    };

    connect();
    return cancel;
  }

  private async requestJson<T>(method: 'GET' | 'POST', pathStr: string, body?: unknown): Promise<T> {
    const url = new URL(pathStr, this.serverUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const response = await fetch(url.toString(), {
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(new TextEncoder().encode(payload).byteLength),
              }
            : {}),
        },
        body: payload,
        signal: controller.signal,
      });

      const text = await response.text();

      if (response.status >= 400) {
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return (text ? JSON.parse(text) : undefined) as T;
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        throw new Error('HTTP request timeout (5s)');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseSSEFrame(raw: string): SSEFrame | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && event === 'message') return null;
  return { event, data: dataLines.join('\n') };
}
