import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, get } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

const root = new URL('./', import.meta.url);
const expectedBuilder = `components:
  - name: web
    role: web
    platform: nodejs
    platformVersion: "24"
    path: /
    run:
      port: 8080
      start: node server.mjs
      healthCheckPath: /health
      healthCheckStatusCodes: [200]
`;

test('root manifests preserve the Node.js 24 dependency-free startup contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, 'module');
  assert.deepEqual(packageJson.engines, { node: '24.x' });
  assert.equal(packageJson.scripts.start, 'node server.mjs');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.deepEqual(packageJson[key] ?? {}, {});
  }
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, packageJson.name);
  assert.equal(lock.version, packageJson.version);
  assert.deepEqual(lock.packages, {
    '': {
      name: packageJson.name,
      version: packageJson.version,
      engines: packageJson.engines,
    },
  });
  assert.equal(await readFile(new URL('builder.yaml', root), 'utf8'), expectedBuilder);
});

function request(path) {
  return new Promise((resolve, reject) => {
    const req = get(`http://127.0.0.1:8080${path}`, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        type: response.headers['content-type'],
        body,
      }));
    });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(new Error(`Timed out requesting ${path}`)));
  });
}

async function assertPortAvailable() {
  const probe = createServer();
  probe.listen(8080, '0.0.0.0');
  await once(probe, 'listening');
  await new Promise((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });
}

async function waitForServer(child, getStderr) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    assert.equal(child.exitCode, null, `Server exited: ${getStderr()}`);
    try {
      await request('/health');
      return;
    } catch (error) {
      if (error.code !== 'ECONNREFUSED') throw error;
      await delay(100);
    }
  }
  throw new Error(`Server did not become ready: ${getStderr()}`);
}

test('HTTP routes and public greeting work with no external services', { timeout: 30000 }, async (t) => {
  for (const greeting of [undefined, 'Welcome', '']) {
    await t.test(`SAMPLE_GREETING=${greeting === undefined ? '(unset)' : JSON.stringify(greeting)}`, async () => {
      await assertPortAvailable();
      const env = { ...process.env };
      delete env.SAMPLE_GREETING;
      if (greeting !== undefined) env.SAMPLE_GREETING = greeting;
      const child = spawn(process.execPath, ['server.mjs'], {
        cwd: root,
        env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      const exited = once(child, 'exit');
      try {
        await waitForServer(child, () => stderr);
        assert.deepEqual(await request('/'), {
          status: 200,
          type: 'text/plain; charset=utf-8',
          body: `App Service Builder / nodejs-web: ${greeting || 'Hello'}\n`,
        });
        assert.deepEqual(await request('/health'), {
          status: 200,
          type: 'text/plain; charset=utf-8',
          body: 'OK\n',
        });
        assert.deepEqual(await request('/not-found'), {
          status: 404,
          type: 'text/plain; charset=utf-8',
          body: 'Not found\n',
        });
      } finally {
        if (child.exitCode === null) child.kill('SIGTERM');
        await exited;
      }
    });
  }
});
