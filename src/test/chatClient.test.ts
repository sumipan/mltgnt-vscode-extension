import * as assert from 'assert';
import * as http from 'http';
import { ChatClient, parseSSEFrame } from '../chatClient';
import type { AddressInfo } from 'net';

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

/**
 * 仮想 chat-server を立てて ChatClient の HTTP/SSE 経路を検証する。
 */
function startStubServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      });
    });
  });
}

describe('ChatClient', () => {
  describe('sendMessage', () => {
    it('AC: empty text → throws without HTTP call', async () => {
      const client = new ChatClient('http://127.0.0.1:1');
      await assert.rejects(() => client.sendMessage('s', '   '));
    });

    it('AC-2: POST /chat is called with session+text', async () => {
      let received: any = null;
      const stub = await startStubServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received = { method: req.method, url: req.url, body: JSON.parse(body) };
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ session: received.body.session, pid: 1 }));
        });
      });
      try {
        const client = new ChatClient(stub.url);
        await client.sendMessage('s1', 'hello');
        assert.strictEqual(received.method, 'POST');
        assert.strictEqual(received.url, '/chat');
        assert.deepStrictEqual(received.body, { session: 's1', text: 'hello' });
      } finally {
        stub.close();
      }
    });
  });

  describe('listSessions / createSession', () => {
    it('GET /sessions returns parsed array', async () => {
      const stub = await startStubServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ session: 'a', path: 'chat/a.md', mtime: 1.0 }]));
      });
      try {
        const client = new ChatClient(stub.url);
        const items = await client.listSessions();
        assert.strictEqual(items.length, 1);
        assert.strictEqual(items[0].session, 'a');
      } finally {
        stub.close();
      }
    });

    it('POST /sessions sends topic+persona', async () => {
      let body: any;
      const stub = await startStubServer((req, res) => {
        let buf = '';
        req.on('data', (c) => (buf += c));
        req.on('end', () => {
          body = JSON.parse(buf);
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ session: '2026-04-26_t', path: 'chat/2026-04-26_t.md', mtime: 1.0 }));
        });
      });
      try {
        const client = new ChatClient(stub.url);
        await client.createSession('t', 'フチコマ');
        assert.deepStrictEqual(body, { topic: 't', persona: 'フチコマ' });
      } finally {
        stub.close();
      }
    });
  });

  describe('streamResponse', () => {
    it('AC-3: receives chunks then done', (done) => {
      startStubServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: chunk\ndata: 一行目\n\n');
        res.write('event: chunk\ndata: 二行目\n\n');
        res.write('event: done\ndata: \n\n');
        res.end();
      }).then((stub) => {
        const client = new ChatClient(stub.url);
        const chunks: string[] = [];
        let finished = false;
        client.streamResponse(
          's',
          (c) => chunks.push(c),
          () => {
            finished = true;
            stub.close();
            try {
              assert.deepStrictEqual(chunks, ['一行目', '二行目']);
              assert.ok(finished);
              done();
            } catch (e) {
              done(e as Error);
            }
          },
          (err) => {
            stub.close();
            done(new Error('unexpected error: ' + err));
          },
          5
        );
      });
    });

    it('AC: HTTP error → onError called', (done) => {
      startStubServer((req, res) => {
        res.writeHead(500);
        res.end('boom');
      }).then((stub) => {
        const client = new ChatClient(stub.url);
        client.streamResponse(
          's',
          () => {
            stub.close();
            done(new Error('chunk should not arrive'));
          },
          () => {
            stub.close();
            done(new Error('done should not arrive'));
          },
          (err) => {
            stub.close();
            assert.match(err, /500/);
            done();
          },
          5
        );
      });
    });
  });
});
