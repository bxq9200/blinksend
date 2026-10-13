const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { VersionUpdater, selectRelease, REPO } = require('../src/version-updater');

const bytes = Buffer.from('test portable executable');
function release(version = '0.4.0') {
  return { tag_name: `v${version}`, assets: [{ name: `BlinkSend-Portable-${version}.exe`, state: 'uploaded', size: bytes.length,
    browser_download_url: `${REPO}/releases/download/v${version}/BlinkSend-Portable-${version}.exe`,
    digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` }] };
}

test('version check uses numeric versions and ignores old releases', () => {
  assert.equal(selectRelease(release('0.10.0'), '0.3.0').version, '0.10.0');
  assert.equal(selectRelease(release('0.2.4'), '0.3.0'), null);
  assert.throws(() => selectRelease({ ...release(), prerelease: true }, '0.3.0'));
  assert.throws(() => selectRelease({ tag_name: 'v0.4.0', assets: [] }, '0.3.0'));
});

async function updaterFixture(t, data = release(), body = bytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'blinksend-update-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const updater = new VersionUpdater({ version: '0.3.0', directory, fetchImpl: async (url) => url.includes('/latest')
    ? new Response(JSON.stringify(data)) : new Response(body) });
  await updater.check();
  return { directory, updater };
}

test('download must be fully verified before becoming launchable', async (t) => {
  const { directory, updater } = await updaterFixture(t);
  assert.equal(updater.state.status, 'available');
  assert.equal((await updater.download()).status, 'ready');
  assert.deepEqual(await fs.readFile(path.join(directory, 'BlinkSend-Portable-0.4.0.exe')), bytes);
  assert.equal((await fs.readdir(directory)).length, 1);
});

test('hash mismatch removes partial package and never exposes launch target', async (t) => {
  const corrupted = release(); corrupted.assets[0].digest = `sha256:${'0'.repeat(64)}`;
  const { directory, updater } = await updaterFixture(t, corrupted);
  assert.equal((await updater.download()).status, 'error');
  assert.equal(updater.target, undefined);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('download cannot overwrite an existing executable', async (t) => {
  const { directory, updater } = await updaterFixture(t);
  const target = path.join(directory, 'BlinkSend-Portable-0.4.0.exe');
  await fs.writeFile(target, 'existing');
  assert.equal((await updater.download()).status, 'error');
  assert.equal(await fs.readFile(target, 'utf8'), 'existing');
});

test('network errors are visible and check can be retried', async () => {
  let calls = 0;
  const updater = new VersionUpdater({ version: '0.3.0', directory: os.tmpdir(), fetchImpl: async () => {
    if (++calls === 1) throw new Error('offline');
    return new Response(JSON.stringify(release('0.3.0')));
  } });
  assert.equal((await updater.check()).status, 'error');
  assert.equal((await updater.check()).status, 'current');
});
