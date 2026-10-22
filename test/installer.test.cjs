const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { NightshadeInstaller, selectRelease, verifyChecksum, runCommand, download } = require('../out/installer.js');

const tarball = Buffer.from('release archive');
const digest = createHash('sha256').update(tarball).digest('hex');
const url = 'https://github.com/DicksonWu654/nightshade/releases/download/v1.2.3/';
const release = { tag_name: 'v1.2.3', draft: false, prerelease: false, assets: [
  { name: 'nightshade-compact-1.2.3.tgz', browser_download_url: url + 'nightshade-compact-1.2.3.tgz', digest: 'sha256:' + digest },
  { name: 'SHA256SUMS', browser_download_url: url + 'SHA256SUMS' }
] };
const options = { docker: 'docker', image: 'nightshade', autoInstall: true };

async function fixture(t, changes = {}) {
  const storage = await mkdtemp(path.join(tmpdir(), 'nightshade-installer-test-'));
  t.after(() => rm(storage, { recursive: true, force: true }));
  const images = new Set();
  const calls = [];
  let requests = 0;
  const run = async (command, args) => {
    calls.push(args);
    if (args[0] === 'info') return { code: 0, stdout: 'linux\n', stderr: '' };
    if (args[0] === 'image') return { code: images.has(args[2]) ? 0 : 1, stdout: '', stderr: '' };
    if (args[0] === 'build') {
      assert.deepEqual(await readFile(path.join(args.at(-1), 'nightshade.tgz')), tarball);
      assert.ok((await readFile(path.join(args.at(-1), 'Dockerfile'), 'utf8')).includes('npm install --global'));
      images.add(args[args.indexOf('--tag') + 1]);
    }
    return { code: 0, stdout: 'Nightshade', stderr: '' };
  };
  const get = async endpoint => {
    requests++;
    if (endpoint.endsWith('/latest')) return Buffer.from(JSON.stringify(release));
    if (endpoint.endsWith('/SHA256SUMS')) return Buffer.from(`${digest}  nightshade-compact-1.2.3.tgz\n`);
    return tarball;
  };
  const deps = { run, download: get, ...changes };
  return { storage, images, calls, run, get, requests: () => requests,
    installer: new NightshadeInstaller(storage, deps), deps };
}

test('cold install shares one build across concurrent scans and reuses persisted image offline', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.installer.ensure(options), f.installer.ensure(options), f.installer.ensure(options)]);
  assert.equal(new Set(results).size, 1);
  assert.equal(f.calls.filter(a => a[0] === 'build').length, 1);
  assert.equal(f.requests(), 2);
  assert.equal(JSON.parse(await readFile(path.join(f.storage, 'installation.json'))).version, 'v1.2.3');
  assert.deepEqual(await readdir(f.storage), ['installation.json']);
  const restarted = new NightshadeInstaller(f.storage, { run: f.run, download: () => { throw Error('offline'); } });
  assert.equal(await restarted.ensure(options), results[0]);
});

test('existing default and custom images are used without any release request', async t => {
  const f = await fixture(t);
  f.images.add('nightshade');
  f.images.add('custom:tag');
  assert.equal(await f.installer.ensure(options), 'nightshade');
  assert.equal(await f.installer.ensure({ ...options, image: 'custom:tag' }), 'custom:tag');
  assert.equal(f.requests(), 0);
});

test('missing custom image and disabled auto-install never download', async t => {
  const f = await fixture(t);
  await assert.rejects(f.installer.ensure({ ...options, image: 'custom:tag' }), /Custom Docker image/);
  await assert.rejects(f.installer.ensure({ ...options, autoInstall: false }), /Enable nightshade.autoInstall/);
  assert.equal(f.requests(), 0);
});

test('manual update bypasses existing default; removed managed images are reinstalled', async t => {
  const f = await fixture(t);
  f.images.add('nightshade');
  const managed = await f.installer.ensure(options, true);
  assert.match(managed, /^nightshade-inline-managed:/);
  f.images.clear();
  assert.equal(await f.installer.ensure(options), managed);
  assert.equal(f.calls.filter(a => a[0] === 'build').length, 2);
});

test('checksum tampering prevents execution and cleans up; failed download can be retried', async t => {
  const f = await fixture(t);
  let fail = true;
  const installer = new NightshadeInstaller(f.storage, { run: f.run, download: endpoint =>
    endpoint.endsWith('.tgz') && fail ? Buffer.from('tampered') : f.get(endpoint) });
  await assert.rejects(installer.ensure(options), /SHA-256/);
  assert.equal(f.calls.filter(a => a[0] === 'build').length, 0);
  assert.deepEqual(await readdir(f.storage), []);
  fail = false;
  await installer.ensure(options);
});

test('SHA256SUMS is used when the release API lacks a digest', async t => {
  const f = await fixture(t);
  const withoutDigest = structuredClone(release);
  delete withoutDigest.assets[0].digest;
  const installer = new NightshadeInstaller(f.storage, { run: f.run, download: endpoint =>
    endpoint.endsWith('/latest') ? Buffer.from(JSON.stringify(withoutDigest)) : f.get(endpoint) });
  await installer.ensure(options);
  assert.equal(f.calls.filter(a => a[0] === 'build').length, 1);
});

test('failed build preserves the previous installation and cleans temporary downloads', async t => {
  const f = await fixture(t);
  const previous = { version: 'v0.1.0', image: 'nightshade-inline-managed:' + 'a'.repeat(64), digest: 'a'.repeat(64) };
  await writeFile(path.join(f.storage, 'installation.json'), JSON.stringify(previous));
  f.images.add(previous.image);
  const installer = new NightshadeInstaller(f.storage, { download: f.get, run: (c, a) =>
    a[0] === 'build' ? { code: 1, stdout: '', stderr: 'build error' } : f.run(c, a) });
  await assert.rejects(installer.ensure(options, true), /build failed/);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.storage, 'installation.json'))), previous);
  assert.deepEqual(await readdir(f.storage), ['installation.json']);
  assert.equal(await installer.ensure(options), previous.image);
});

test('missing or stopped Docker has actionable errors and performs no downloads', async t => {
  const f = await fixture(t);
  for (const run of [async () => { throw Error('ENOENT'); }, async () => ({ code: 1, stdout: '', stderr: 'daemon stopped' })]) {
    const installer = new NightshadeInstaller(f.storage, { run, download: f.get });
    await assert.rejects(installer.ensure(options), /Docker/);
  }
  assert.equal(f.requests(), 0);
});

test('rejects prereleases, missing assets, and assets outside the upstream repository', () => {
  assert.throws(() => selectRelease({ ...release, prerelease: true }), /stable/);
  assert.throws(() => selectRelease({ ...release, assets: [] }), /tarball/);
  assert.throws(() => selectRelease({ ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://example.com/a.tgz' }] }), /URL/);
  assert.throws(() => verifyChecksum(tarball, 'a'.repeat(64)), /SHA-256/);
});

test('spawn errors reject instead of masquerading as successful scans; exit 1 and 2 remain usable', async () => {
  await assert.rejects(runCommand('nonexistent-nightshade-test-command', [], process.cwd()), /ENOENT/);
  for (const code of [1, 2]) {
    const result = await runCommand(process.execPath, ['-e', `console.log('report'); process.exit(${code})`], process.cwd());
    assert.equal(result.code, code);
    assert.equal(result.stdout.trim(), 'report');
  }
});

test('downloads reject rate limits and oversized payloads', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async () => new Response('rate limited', { status: 403 });
  await assert.rejects(download('https://api.github.com/test', 10), /rate limit/);
  global.fetch = async () => new Response('too big');
  await assert.rejects(download('https://api.github.com/test', 2), /allowed size/);
});

test('GitHub API metadata uses JSON Accept while release assets use octet-stream', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const accepts = [];
  global.fetch = async (_url, options) => { accepts.push(options.headers.Accept); return new Response('{}'); };
  await download('https://api.github.com/repos/DicksonWu654/nightshade/releases/latest', 1024);
  await download(url + 'nightshade-compact-1.2.3.tgz', 1024);
  assert.deepEqual(accepts, ['application/vnd.github+json', 'application/octet-stream']);
});
