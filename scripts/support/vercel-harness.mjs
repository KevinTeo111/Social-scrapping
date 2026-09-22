// Serves api/index.js the way Vercel calls it -- a bare (req, res) handler (scripts/test-split.mjs).
import http from 'node:http';
const { default: handler } = await import('../../api/index.js');
http.createServer((req, res) => handler(req, res)).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('harness up'));
