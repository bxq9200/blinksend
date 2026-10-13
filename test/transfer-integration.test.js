const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createRequire } = require('node:module');
const { once } = require('node:events');

async function service(t, policy) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinksend-network-'));
  const calls = [];
  const timers = new Set();
  const localRequire = createRequire(path.join(__dirname, '../src/main.js'));
  const app = { getPath: () => root, on: () => {}, whenReady: () => ({ then: () => {} }) };
  const context = vm.createContext({ require: (name) => name === 'electron' ? { app, ipcMain: { handle: () => {} } } : localRequire(name),
    __dirname: path.join(__dirname, '../src'), Buffer, process, console,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout });
  const source = await fs.readFile(path.join(__dirname, '../src/main.js'), 'utf8');
  vm.runInContext(source + '\nglobalThis.api = { handleIncomingSocket, acceptIncomingTransfer, readJsonLine, sendOneFile }; mainWindow = globalThis.fakeWindow;', context);
  context.fakeWindow = { isDestroyed: () => false, webContents: { send: (channel, item) => {
    calls.push({ channel, item });
    if (channel === 'transfer:incoming-request') context.api.acceptIncomingTransfer(item.id, policy).catch(console.error);
  } } };
  vm.runInContext('mainWindow = globalThis.fakeWindow', context);
  await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({ downloadDir: root, conflictPolicy: policy }));
  const server = net.createServer({ allowHalfOpen: true }, context.api.handleIncomingSocket);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { timers.forEach(clearTimeout); await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, calls, sendOneFile: context.api.sendOneFile, device: { address: '127.0.0.1', port: server.address().port, name: 'receiver' }, send: async (name, contents, size = contents.length) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: server.address().port });
    await once(socket, 'connect');
    const response = context.api.readJsonLine(socket);
    socket.write(JSON.stringify({ kind: 'file', name: path.basename(name), relativePath: name, size,
      senderId: 'test-peer', modifiedAt: 123, batchId: 'batch-1', batchCount: 3, batchName: 'folder' }) + '\n');
    const accepted = await response;
    assert.equal(accepted.accept, true);
    const closed = once(socket, 'close');
    socket.end(contents.subarray(accepted.offset));
    await closed;
  } };
}

test('real TCP batch prompts once, preserves hierarchy and handles empty files', { timeout: 10000 }, async (t) => {
  const { root, calls, send } = await service(t, 'new-folder');
  await send('folder/a.txt', Buffer.from('aaa'));
  await send('folder/sub/b.txt', Buffer.from('bbb'));
  await send('folder/empty.txt', Buffer.alloc(0));
  assert.equal(calls.filter((call) => call.channel === 'transfer:incoming-request').length, 1);
  assert.equal(calls.filter((call) => call.channel === 'transfer:update' && call.item.status === 'completed').length, 3);
  const dirs = (await fs.readdir(root)).filter((name) => name.startsWith('BlinkSend-'));
  assert.equal(dirs.length, 1);
  assert.equal(await fs.readFile(path.join(root, dirs[0], 'folder/sub/b.txt'), 'utf8'), 'bbb');
});

test('real sender waits for receiver save acknowledgement', { timeout: 10000 }, async (t) => {
  const { root, calls, sendOneFile, device } = await service(t, 'replace');
  const sourcePath = path.join(root, 'source.txt');
  await fs.writeFile(sourcePath, 'new contents');
  await sendOneFile(device, { path: sourcePath, name: 'destination.txt', relativePath: 'folder/destination.txt' }, 'send-1', Date.now(), null);
  assert.equal(await fs.readFile(path.join(root, 'folder/destination.txt'), 'utf8'), 'new contents');
  assert.ok(calls.some((call) => call.channel === 'transfer:update' && call.item.id === 'send-1' && call.item.status === 'completed'));
});

test('interrupted TCP replacement preserves original and resumes next connection', { timeout: 10000 }, async (t) => {
  const { root, calls, send } = await service(t, 'replace');
  await fs.writeFile(path.join(root, 'a.txt'), 'old');
  await send('a.txt', Buffer.from('n'), 3);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'old');
  await send('a.txt', Buffer.from('new'));
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'new');
  assert.equal(calls.filter((call) => call.channel === 'transfer:update' && call.item.status === 'failed').length, 1);
});
