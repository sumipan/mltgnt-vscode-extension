import * as assert from 'assert';
import { ChatClient, parseSSEFrame } from '../chatClient';

describe('parseSSEFrame', () => {
  it('parses event + single data', () => {
    const f = parseSSEFrame('event: chunk\ndata: hello');
    assert.deepStrictEqual(f, { event: 'chunk', data: 'hello' });
  });

  it('parses multi-line data joined with \\n', () => {
    const f = parseSSEFrame('event: chunk\ndata: line1\ndata: line2');
    assert.deepStrictEqual(f, { event: 'chunk', data: 'line1\nline2' });
  });

  it('returns null for blank frame', () => {
    assert.strictEqual(parseSSEFrame(''), null);
  });

  it('skips comment lines starting with :', () => {
    const f = parseSSEFrame(': keepalive\nevent: done\ndata: ');
    assert.deepStrictEqual(f, { event: 'done', data: '' });
  });
});

// Helper to create a mock fetch response
function mockFetchResponse(options: {
  status?: number;
  headers?: Record<string, string>;
  body?: string | (() => AsyncIterable<Uint8Array>);
}): Response {
  const status = options.status ?? 200;
  const headers = new Headers(options.headers ?? { 'content-type': 'application/json' });
  const bodyText = typeof options.body === 'string' ? options.body : '';

  if (typeof options.body === 'function') {
    const asyncIterable = options.body();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for await (const chunk of asyncIterable) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    return new Response(stream, { status, headers });
  }

  return new Response(bodyText, { status, headers });
}

describe('ChatClient', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('sendMessage', () => {
    it('AC: empty text → throws without HTTP call', async () => {
      const client = new ChatClient('http://127.0.0.1:1');
      await assert.rejects(() => client.sendMessage('s', '   '));
    });

    it('AC-2: POST /chat is called with session+text', async () => {
      let receivedMethod: string | undefined;
      let receivedUrl: string | undefined;
      let receivedBody: unknown;

      globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        receivedUrl = input.toString();
        receivedMethod = init?.method;
        receivedBody = JSON.parse(init?.body as string);
        return mockFetchResponse({
          status: 200,
          body: JSON.stringify({ session: 's1', pid: 1 }),
        });
      };

      const client = new ChatClient('http://127.0.0.1:8765');
      await client.sendMessage('s1', 'hello');
      assert.strictEqual(receivedMethod, 'POST');
      assert.ok(receivedUrl?.endsWith('/chat'));
      assert.deepStrictEqual(receivedBody, { session: 's1', text: 'hello' });
    });
  });

  describe('listSessions / createSession', () => {
    it('GET /sessions returns parsed array', async () => {
      globalThis.fetch = async () => {
        return mockFetchResponse({
          status: 200,
          body: JSON.stringify([{ session: 'a', path: 'chat/a.md', mtime: 1.0 }]),
        });
      };

      const client = new ChatClient('http://127.0.0.1:8765');
      const items = await client.listSessions();
      assert.strictEqual(items.length, 1);
      assert.strictEqual(items[0].session, 'a');
    });

    it('POST /sessions sends topic+persona', async () => {
      let receivedBody: unknown;

      globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
        receivedBody = JSON.parse(init?.body as string);
        return mockFetchResponse({
          status: 201,
          body: JSON.stringify({ session: '2026-04-26_t', path: 'chat/2026-04-26_t.md', mtime: 1.0 }),
        });
      };

      const client = new ChatClient('http://127.0.0.1:8765');
      await client.createSession('t', 'フチコマ');
      assert.deepStrictEqual(receivedBody, { topic: 't', persona: 'フチコマ' });
    });
  });

  describe('streamResponse', () => {
    it('AC-3: receives chunks then done', (done) => {
      const encoder = new TextEncoder();
      const frames = [
        'event: chunk\ndata: 一行目\n\n',
        'event: chunk\ndata: 二行目\n\n',
        'event: done\ndata: \n\n',
      ];

      globalThis.fetch = async () => {
        return mockFetchResponse({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: async function* () {
            for (const frame of frames) {
              yield encoder.encode(frame);
            }
          },
        });
      };

      const client = new ChatClient('http://127.0.0.1:8765');
      const chunks: string[] = [];
      let finished = false;
      client.streamResponse(
        's',
        (c) => chunks.push(c),
        () => {
          finished = true;
          try {
            assert.deepStrictEqual(chunks, ['一行目', '二行目']);
            assert.ok(finished);
            done();
          } catch (e) {
            done(e as Error);
          }
        },
        (err) => {
          done(new Error('unexpected error: ' + err));
        },
        5
      );
    });

    it('AC: HTTP error → onError called', (done) => {
      globalThis.fetch = async () => {
        return mockFetchResponse({
          status: 500,
          body: 'boom',
        });
      };

      const client = new ChatClient('http://127.0.0.1:8765');
      client.streamResponse(
        's',
        () => {
          done(new Error('chunk should not arrive'));
        },
        () => {
          done(new Error('done should not arrive'));
        },
        (err) => {
          assert.match(err, /500/);
          done();
        },
        5
      );
    });
  });
});
