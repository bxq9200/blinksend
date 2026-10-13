const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ReceiveStorage } = require('../src/receive-storage');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinksend-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, storage: new ReceiveStorage(), header: { name: 'file.txt', relativePath: 'file.txt', size: 3, modifiedAt: 123, senderId: 'sender' } };
}

test('keep both preserves existing files regardless of size', async (t) => {
  const { root, storage, header } = await fixture(t);
  await fs.writeFile(path.join(root, header.name), 'long original');
  const item = await storage.prepare(root, header, 'keep-both');
  await fs.writeFile(item.partial, 'new');
  await item.finalize(); item.release();
  assert.equal(await fs.readFile(path.join(root, header.name), 'utf8'), 'long original');
  assert.equal(await fs.readFile(path.join(root, 'file (1).txt'), 'utf8'), 'new');
});

test('replace leaves old contents until a full transfer is available', async (t) => {
  const { root, storage, header } = await fixture(t);
  await fs.writeFile(path.join(root, header.name), 'old');
  let item = await storage.prepare(root, header, 'replace');
  await fs.writeFile(item.partial, 'n');
  await assert.rejects(item.finalize(), /大小不匹配/);
  item.release();
  assert.equal(await fs.readFile(path.join(root, header.name), 'utf8'), 'old');
  item = await storage.prepare(root, header, 'replace');
  assert.equal(item.offset, 1);
  await fs.appendFile(item.partial, 'ew');
  await item.finalize(); item.release();
  assert.equal(await fs.readFile(path.join(root, header.name), 'utf8'), 'new');
});

test('changed source does not resume from another file', async (t) => {
  const { root, storage, header } = await fixture(t);
  const item = await storage.prepare(root, header, 'replace');
  await fs.writeFile(item.partial, 'o'); item.release();
  const changed = await storage.prepare(root, { ...header, modifiedAt: 124 }, 'replace');
  assert.equal(changed.offset, 0); changed.release();
});

test('new directory preserves hierarchy for a whole batch', async (t) => {
  const { root, storage, header } = await fixture(t);
  const directory = await storage.newFolder(root);
  for (const name of ['folder/a.txt', 'folder/sub/b.txt']) {
    const item = await storage.prepare(directory, { ...header, relativePath: name }, 'new-folder');
    await fs.writeFile(item.partial, 'new'); await item.finalize(); item.release();
    assert.equal(await fs.readFile(path.join(directory, name), 'utf8'), 'new');
  }
});

test('invalid paths and simultaneous replacement cannot escape or corrupt files', async (t) => {
  const { root, storage, header } = await fixture(t);
  for (const relativePath of ['../bad', 'C:\\bad', '/bad', 'folder/../../bad']) {
    await assert.rejects(storage.prepare(root, { ...header, relativePath }, 'replace'));
  }
  const item = await storage.prepare(root, header, 'replace');
  await assert.rejects(storage.prepare(root, header, 'replace'), /正在接收/);
  item.release();
});
