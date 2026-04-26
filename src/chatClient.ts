import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

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
 * Node 標準モジュールのみで実装し、追加依存を減らす。
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
    const connectTimeoutMs = 5000; // HTTP レスポンスヘッダー到着までのタイムアウト
    let activeReq: http.ClientRequest | null = null;

    const cleanup = () => {
      if (activeReq) {
        activeReq.destroy();
        activeReq = null;
      }
    };

    const cancel = () => {
      cancelled = true;
      cleanup();
    };

    const connect = () => {
      if (cancelled) return;
      attempt += 1;

      const url = new URL('/chat/stream', this.serverUrl);
      url.searchParams.set('session', session);
      url.searchParams.set('timeout', String(timeoutSec));
      const lib = url.protocol === 'https:' ? https : http;

      const req = lib.request(
        {
          method: 'GET',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          // レスポンスヘッダーが届いたので接続タイムアウトを解除
          req.setTimeout(0);

          if (res.statusCode && res.statusCode >= 400) {
            onError(`SSE HTTP ${res.statusCode}`);
            cancel();
            return;
          }

          let buffer = '';

          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            buffer += chunk;
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
          });
          res.on('end', () => {
            cleanup();
            if (!cancelled) tryReconnect();
          });
          res.on('error', (e) => {
            if (retrying || cancelled) return; // 二重 tryReconnect を防ぐ
            onError(`SSE response error: ${e.message}`);
            tryReconnect();
          });
        }
      );

      req.on('error', (e) => {
        if (retrying || cancelled) return; // 二重 tryReconnect を防ぐ
        onError(`SSE request error: ${e.message}`);
        tryReconnect();
      });

      req.setTimeout(connectTimeoutMs, () => {
        // HTTP レスポンスヘッダーが届かない場合のみ発火
        if (retrying || cancelled) return;
        onError('SSE connect timeout');
        tryReconnect();
      });

      req.end();
      activeReq = req;
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

  private requestJson<T>(method: 'GET' | 'POST', pathStr: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(pathStr, this.serverUrl);
      const lib = url.protocol === 'https:' ? https : http;
      const payload = body !== undefined ? JSON.stringify(body) : undefined;
      const req = lib.request(
        {
          method,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          headers: {
            Accept: 'application/json',
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          let data = '';
          res.setEncoding('utf-8');
          res.on('data', (c: string) => (data += c));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data}`));
              return;
            }
            try {
              resolve((data ? JSON.parse(data) : undefined) as T);
            } catch (e) {
              reject(e instanceof Error ? e : new Error(String(e)));
            }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy(new Error('HTTP request timeout (5s)'));
      });
      if (payload) req.write(payload);
      req.end();
    });
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
