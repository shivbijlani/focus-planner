const http = require('http');
const fs = require('fs');
const path = require('path');
const root = __dirname;
http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f, (e, data) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    const ext = path.extname(f);
    const ct = ext === '.html' ? 'text/html' : ext === '.png' ? 'image/png' : 'text/plain';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
}).listen(8777, '127.0.0.1', () => console.log('serving on 8777'));
