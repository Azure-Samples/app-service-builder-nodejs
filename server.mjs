import { createServer } from 'node:http';

createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (path === '/health') {
    response.writeHead(200).end('OK\n');
  } else if (path === '/') {
    // Only this deliberately public setting is reflected; never dump process.env.
    response.writeHead(200).end(
      `App Service Builder / nodejs-web: ${process.env.SAMPLE_GREETING || 'Hello'}\n`,
    );
  } else {
    response.writeHead(404).end('Not found\n');
  }
}).listen(8080, '0.0.0.0');
