import http from 'node:http';

/** Only the gateway shell (same origin) may frame the app. */
function limitFraming(h) {
  const csp = h['content-security-policy'];
  if (!csp) h['content-security-policy'] = "frame-ancestors 'self'";
  else if (!/frame-ancestors/i.test(csp)) h['content-security-policy'] = `${csp}; frame-ancestors 'self'`;
  if (!h['x-frame-options']) h['x-frame-options'] = 'SAMEORIGIN';
}

/** Proxy one HTTP request to the user's sandbox, swapping in the sandbox auth cookie. */
export function proxyHttp(req, res, sb, onError) {
  const headers = { ...req.headers, cookie: sb.cookie };
  const up = http.request(
    { host: sb.host, port: sb.port, method: req.method, path: req.url, headers },
    (ures) => {
      const out = { ...ures.headers };
      delete out['set-cookie']; // sandbox credentials never reach the browser
      limitFraming(out);
      res.writeHead(ures.statusCode, out);
      ures.pipe(res);
    },
  );
  up.on('error', (e) => {
    onError(e);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('Bad gateway');
  });
  res.on('close', () => up.destroy());
  req.pipe(up);
}

/** Proxy a WebSocket upgrade. Calls onClose once when the tunnel ends. */
export function proxyUpgrade(req, socket, head, sb, { onOpen, onClose, onError }) {
  const headers = { ...req.headers, cookie: sb.cookie };
  const up = http.request({ host: sb.host, port: sb.port, method: req.method, path: req.url, headers });
  let opened = false;
  up.on('upgrade', (ures, usock, uhead) => {
    opened = true;
    onOpen();
    let raw = `HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}\r\n`;
    for (let i = 0; i < ures.rawHeaders.length; i += 2) {
      if (ures.rawHeaders[i].toLowerCase() === 'set-cookie') continue;
      raw += `${ures.rawHeaders[i]}: ${ures.rawHeaders[i + 1]}\r\n`;
    }
    socket.write(`${raw}\r\n`);
    if (uhead.length) socket.write(uhead);
    if (head.length) usock.write(head);
    usock.pipe(socket);
    socket.pipe(usock);
    const done = () => {
      usock.destroy();
      socket.destroy();
      onClose();
    };
    usock.on('close', done);
    socket.on('close', done);
    usock.on('error', () => {});
    socket.on('error', () => {});
  });
  up.on('response', (ures) => {
    // Upstream declined the upgrade (e.g. 401/403): relay the status and end.
    const hdrs = Object.entries(ures.headers)
      .filter(([k]) => k !== 'set-cookie')
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    socket.end(`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage}\r\n${hdrs}\r\n\r\n`);
    ures.resume();
  });
  up.on('error', (e) => {
    onError(e);
    if (!opened) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  up.end();
}
