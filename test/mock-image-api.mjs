// 测试用的 OpenAI 兼容 images/edits 桩：不解析 multipart，直接回一张图的 b64。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const png = readFileSync('/tmp/t3-avatar.png').toString('base64');

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    console.log('mock hit', req.method, req.url, 'bytes', chunks.reduce((n, c) => n + c.length, 0));
    if (!req.url.includes('/images/edits')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ created: Date.now(), data: [{ b64_json: png }] }));
  });
}).listen(18080, '127.0.0.1', () => console.log('mock on 18080'));
