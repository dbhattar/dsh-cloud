// Fake model provider for the phase 3 acceptance suite. Runs in a container on the sandbox network.
// Accepts only `Authorization: Bearer $REAL_KEY`, reports usage (10 prompt + 20 completion tokens unless the
// last message contains `USAGE:<prompt>:<completion>`), and records every call for GET /__calls.
import http from 'node:http';

const REAL_KEY = process.env.REAL_KEY;
const calls = [];

http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    if (req.url === '/__calls') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(calls));
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') return res.writeHead(404).end();
    const auth = req.headers.authorization;
    const body = JSON.parse(raw || '{}');
    calls.push({ authOk: auth === `Bearer ${REAL_KEY}`, authIsBearer: /^Bearer /.test(auth ?? ''), authLooksLikeUserToken: /^Bearer dshu_/.test(auth ?? ''), model: body.model, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true, maxTokens: body.max_tokens });
    if (auth !== `Bearer ${REAL_KEY}`) return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }));
    const last = String(body.messages?.at(-1)?.content ?? '');
    const m = /USAGE:(\d+):(\d+)/.exec(last);
    const usage = { prompt_tokens: m ? Number(m[1]) : 10, completion_tokens: m ? Number(m[2]) : 20 };
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'fake', choices: [{ message: { role: 'assistant', content: 'hello' } }], usage }));
  })
  .listen(9000, '0.0.0.0', () => console.log('fake upstream on :9000'));
