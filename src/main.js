const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const { ReceiveStorage, validatePolicy } = require('./receive-storage');
const { VersionUpdater, REPO } = require('./version-updater');

const DISCOVERY_PORT = 43111;
const DISCOVERY_INTERVAL_MS = 2000;
const DEVICE_TTL_MS = 7000;
const DEFAULT_TRANSFER_PORT = 43112;
const APP_NAME = 'BlinkSend';
const APP_PROTOCOL = 'blinksend';
const LEGACY_PROTOCOL = 'lan-share';
const ACCEPTED_PROTOCOLS = new Set([APP_PROTOCOL, LEGACY_PROTOCOL]);
const TRANSFER_UPDATE_INTERVAL_MS = 500;

let mainWindow;
let udpSocket;
let tcpServer;
let transferPort = DEFAULT_TRANSFER_PORT;
let discoveryTimer;
let pruneTimer;
let historySaveTimer;
let updater;
const receiveStorage = new ReceiveStorage();

const devices = new Map();
const pendingIncoming = new Map();
const batchDecisions = new Map();
const transfers = new Map();
let transferHistory = [];

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function historyPath() {
  return path.join(app.getPath('userData'), 'history.json');
}

function defaultDownloadDir() {
  return path.join(app.getPath('downloads'), 'BlinkSend');
}

async function readConfig() {
  try {
    const raw = await fsp.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const legacyDefault = path.join(app.getPath('downloads'), 'LANShare');
    const downloadDir = parsed.downloadDir === legacyDefault ? defaultDownloadDir() : (parsed.downloadDir || defaultDownloadDir());
    return {
      downloadDir: defaultDownloadDir(),
      ...parsed,
      downloadDir,
      conflictPolicy: ['keep-both', 'replace', 'new-folder'].includes(parsed.conflictPolicy) ? parsed.conflictPolicy : 'keep-both',
    };
  } catch {
    return {
      downloadDir: defaultDownloadDir(),
      conflictPolicy: 'keep-both',
    };
  }
}

async function writeConfig(config) {
  const safeConfig = {
    downloadDir: config.downloadDir || defaultDownloadDir(),
    conflictPolicy: validatePolicy(config.conflictPolicy || 'keep-both'),
  };
  await fsp.mkdir(app.getPath('userData'), { recursive: true });
  await fsp.writeFile(configPath(), JSON.stringify(safeConfig, null, 2));
  return safeConfig;
}

async function loadHistory() {
  try {
    const raw = await fsp.readFile(historyPath(), 'utf8');
    transferHistory = JSON.parse(raw);
  } catch {
    transferHistory = [];
  }
}

async function saveHistory() {
  await fsp.mkdir(app.getPath('userData'), { recursive: true });
  await fsp.writeFile(historyPath(), JSON.stringify(transferHistory.slice(0, 200), null, 2));
}

function queueHistorySave() {
  clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(() => {
    saveHistory().catch(() => {});
  }, 800);
}

function isFinalStatus(status) {
  return ['completed', 'failed', 'rejected'].includes(status);
}

function updateTransfer(update) {
  const existing = transfers.get(update.id) || {};
  const now = Date.now();
  const transfer = { ...existing, ...update };
  let shouldEmit = true;

  if (transfer.status === 'running' && Number.isFinite(transfer.transferred)) {
    const lastSpeedAt = existing.lastSpeedAt || transfer.startedAt || now;
    const lastTransferred = Number.isFinite(existing.lastTransferred) ? existing.lastTransferred : transfer.transferred;
    const elapsed = Math.max(now - lastSpeedAt, 1);
    const delta = Math.max(transfer.transferred - lastTransferred, 0);

    if (!existing.lastSpeedAt || elapsed >= 250 || transfer.transferred >= transfer.size) {
      transfer.speed = Math.round(delta / (elapsed / 1000));
      transfer.lastSpeedAt = now;
      transfer.lastTransferred = transfer.transferred;
    } else {
      transfer.speed = existing.speed || 0;
      transfer.lastSpeedAt = existing.lastSpeedAt;
      transfer.lastTransferred = existing.lastTransferred;
    }

    shouldEmit = !existing.lastEmittedAt
      || now - existing.lastEmittedAt >= TRANSFER_UPDATE_INTERVAL_MS
      || transfer.transferred >= transfer.size;
  }

  if (shouldEmit) {
    transfer.lastEmittedAt = now;
  }

  transfers.set(update.id, transfer);
  if (shouldEmit) {
    sendToRenderer('transfer:update', transfer);
  }

  if (isFinalStatus(transfer.status) && !existing.historySaved) {
    transfers.set(update.id, { ...transfer, historySaved: true });
    const historyItem = {
      ...transfer,
      historySaved: undefined,
      recordedAt: Date.now(),
    };
    transferHistory.unshift(historyItem);
    transferHistory = transferHistory.slice(0, 200);
    queueHistorySave();
    sendToRenderer('history:update', transferHistory);
  }
}

function getDeviceId() {
  const idFile = path.join(app.getPath('userData'), 'device-id.txt');
  try {
    return fs.readFileSync(idFile, 'utf8').trim();
  } catch {
    const id = crypto.randomUUID();
    fs.mkdirSync(path.dirname(idFile), { recursive: true });
    fs.writeFileSync(idFile, id);
    return id;
  }
}

const localDevice = {
  id: null,
  name: os.hostname(),
  app: APP_PROTOCOL,
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 680,
    minWidth: 920,
    minHeight: 620,
    title: APP_NAME,
    frame: false,
    thickFrame: true,
    transparent: true,
    backgroundColor: '#00000000',
    icon: path.join(__dirname, 'assets', 'logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('maximize', () => sendToRenderer('window:maximized-change', true));
  mainWindow.on('unmaximize', () => sendToRenderer('window:maximized-change', false));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function sendToRenderer(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function listLocalIPv4() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal)
    .map((item) => item.address);
}

function broadcastPresence() {
  if (!udpSocket) return;

  for (const appId of [APP_PROTOCOL, LEGACY_PROTOCOL]) {
    const payload = Buffer.from(JSON.stringify({
      app: appId,
      id: localDevice.id,
      name: localDevice.name,
      port: transferPort,
      ips: listLocalIPv4(),
      ts: Date.now(),
    }));

    udpSocket.send(payload, 0, payload.length, DISCOVERY_PORT, '255.255.255.255');
  }
}

function startDiscovery() {
  udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  udpSocket.on('message', (buffer, rinfo) => {
    let message;
    try {
      message = JSON.parse(buffer.toString('utf8'));
    } catch {
      return;
    }

    if (!ACCEPTED_PROTOCOLS.has(message.app) || message.id === localDevice.id) return;
    if (!message.id || !message.name || !message.port) return;

    const existing = devices.get(message.id);
    const address = message.ips?.includes(rinfo.address) ? rinfo.address : rinfo.address;
    devices.set(message.id, {
      id: message.id,
      name: message.name,
      address,
      port: message.port,
      lastSeen: Date.now(),
      firstSeen: existing?.firstSeen || Date.now(),
    });

    emitDevices();
  });

  udpSocket.on('listening', () => {
    udpSocket.setBroadcast(true);
    broadcastPresence();
    discoveryTimer = setInterval(broadcastPresence, DISCOVERY_INTERVAL_MS);
  });

  udpSocket.bind(DISCOVERY_PORT);
  pruneTimer = setInterval(pruneDevices, 1000);
}

function pruneDevices() {
  const now = Date.now();
  let changed = false;

  for (const [id, device] of devices.entries()) {
    if (now - device.lastSeen > DEVICE_TTL_MS) {
      devices.delete(id);
      changed = true;
    }
  }

  if (changed) emitDevices();
}

function emitDevices() {
  const onlineDevices = Array.from(devices.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ id, name, address, port, lastSeen }) => ({ id, name, address, port, lastSeen }));

  sendToRenderer('devices:update', onlineDevices);
}

async function startTransferServer() {
  tcpServer = net.createServer({ allowHalfOpen: true }, handleIncomingSocket);

  await new Promise((resolve, reject) => {
    tcpServer.once('error', reject);
    tcpServer.listen(transferPort, resolve);
  }).catch(async (error) => {
    if (error.code !== 'EADDRINUSE') throw error;
    transferPort = 0;
    await new Promise((resolve, reject) => {
      tcpServer = net.createServer({ allowHalfOpen: true }, handleIncomingSocket);
      tcpServer.once('error', reject);
      tcpServer.listen(transferPort, resolve);
    });
  });

  transferPort = tcpServer.address().port;
}

function handleIncomingSocket(socket) {
  socket.setNoDelay(true);
  socket.on('error', () => socket.destroy());

  readJsonLine(socket)
    .then((header) => {
      if (header.kind !== 'file' || !header.name || !Number.isSafeInteger(header.size) || header.size < 0) {
        socket.destroy();
        return;
      }

      const requestId = crypto.randomUUID();
      const request = {
        id: requestId,
        socket,
        header,
        from: {
          id: header.senderId,
          name: header.senderName || socket.remoteAddress,
          address: socket.remoteAddress,
        },
      };

      socket.pause();
      const decision = request.header.batchId ? batchDecisions.get(batchKey(request)) : undefined;
      if (decision?.accept) {
        acceptRequest(request, decision).catch(() => socket.destroy());
        return;
      }

      if (decision?.accept === false) {
        rejectRequest(request);
        return;
      }

      socket.pause();
      pendingIncoming.set(requestId, request);
      socket.once('close', () => {
        if (pendingIncoming.delete(requestId)) sendToRenderer('transfer:request-closed', requestId);
      });
      sendToRenderer('transfer:incoming-request', {
        id: requestId,
        fileName: header.name,
        relativePath: header.relativePath || header.name,
        size: header.size,
        batchId: header.batchId,
        batchName: header.batchName,
        batchCount: header.batchCount,
        batchTotalSize: header.batchTotalSize,
        from: request.from,
      });
    })
    .catch(() => socket.destroy());
}

function readJsonLine(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', reject);
      socket.off('close', onClose);
    };

    const onClose = () => {
      cleanup();
      reject(new Error('Socket closed before header was received.'));
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newlineIndex = buffer.indexOf(10);
      if (newlineIndex === -1) return;

      const line = buffer.subarray(0, newlineIndex).toString('utf8');
      const rest = buffer.subarray(newlineIndex + 1);
      cleanup();
      if (rest.length) socket.unshift(rest);

      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };

    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('close', onClose);
  });
}

function batchKey(request) {
  return `${request.from.id || request.from.address || 'unknown'}:${request.header.batchId}`;
}

async function acceptIncomingTransfer(requestId, policy) {
  const request = pendingIncoming.get(requestId);
  if (!request) return { ok: false, error: '请求已失效' };

  try {
    const config = await readConfig();
    const decision = { accept: true, policy: validatePolicy(policy || config.conflictPolicy), root: config.downloadDir };
    if (decision.policy === 'new-folder') decision.root = await receiveStorage.newFolder(decision.root);
    await acceptRequest(request, decision);
    pendingIncoming.delete(requestId);
    if (request.header.batchId) batchDecisions.set(batchKey(request), decision);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function acceptRequest(request, decision) {
  const storage = await receiveStorage.prepare(decision.root, request.header, decision.policy);
  const destinationPath = storage.destination;
  const partialPath = storage.partial;
  const resumeOffset = storage.offset;

  const transferId = crypto.randomUUID();
  transfers.set(transferId, { direction: 'in', status: 'running' });

  request.socket.write(JSON.stringify({ accept: true, transferId, offset: resumeOffset, completionAck: true }) + '\n');

  receiveFile({
    socket: request.socket,
    transferId,
    fileName: path.basename(destinationPath),
    destinationPath,
    partialPath,
    size: request.header.size,
    resumeOffset,
    from: request.from,
    storage,
  });
}

function rejectIncomingTransfer(requestId) {
  const request = pendingIncoming.get(requestId);
  if (!request) return { ok: false, error: '请求已失效' };

  pendingIncoming.delete(requestId);
  if (request.header.batchId) {
    batchDecisions.set(batchKey(request), { accept: false });
  }

  rejectRequest(request);
  return { ok: true };
}

function rejectRequest(request) {
  request.socket.end(JSON.stringify({ accept: false }) + '\n');
  updateTransfer({
    id: crypto.randomUUID(),
    direction: 'in',
    status: 'rejected',
    fileName: request.header.name,
    size: request.header.size,
    transferred: 0,
    peerName: request.from.name,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  });
}

function receiveFile({ socket, transferId, fileName, destinationPath, partialPath, size, resumeOffset, from, storage }) {
  let received = resumeOffset;
  const startedAt = Date.now();
  const output = fs.createWriteStream(partialPath, { flags: resumeOffset > 0 ? 'a' : 'w' });

  updateTransfer({
    id: transferId,
    direction: 'in',
    status: 'running',
    fileName,
    size,
    transferred: resumeOffset,
    peerName: from.name,
    destinationPath,
    resumed: resumeOffset > 0,
    startedAt,
  });

  socket.on('data', (chunk) => {
    received += chunk.length;
    updateTransfer({
      id: transferId,
      direction: 'in',
      status: 'running',
      fileName,
      size,
      transferred: Math.min(received, size),
      peerName: from.name,
      destinationPath,
      startedAt,
    });
  });

  socket.pipe(output);
  socket.resume();

  let failed = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    socket.destroy();
    output.destroy();
    failTransfer(transferId, 'in', fileName, from.name, error.message);
  };
  output.on('close', async () => {
    try {
      if (failed) return;
      if (!output.writableFinished || received !== size) throw new Error('传输中断，已保留临时文件');
      await storage.finalize();
      updateTransfer({
      id: transferId,
      direction: 'in',
      status: 'completed',
      fileName,
      size,
      transferred: Math.min(received, size),
      peerName: from.name,
      destinationPath,
      startedAt,
      finishedAt: Date.now(),
      });
      socket.end(JSON.stringify({ completed: true }) + '\n');
    } catch (error) { fail(error); }
    finally { storage.release(); }
  });

  socket.on('error', fail);
  socket.on('close', () => { if (!socket.readableEnded) fail(new Error('连接中断')); });
  output.on('error', fail);
}

function failTransfer(id, direction, fileName, peerName, error) {
  updateTransfer({
    id,
    direction,
    status: 'failed',
    fileName,
    peerName,
    error,
    finishedAt: Date.now(),
  });
}

async function chooseFiles() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择要发送的文件或文件夹',
    properties: ['openFile', 'openDirectory', 'multiSelections'],
  });

  if (result.canceled) return [];
  return flattenPaths(result.filePaths);
}

async function chooseDownloadDir() {
  const config = await readConfig();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择接收目录',
    defaultPath: config.downloadDir,
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || !result.filePaths[0]) {
    return { ok: false, downloadDir: config.downloadDir };
  }

  const nextConfig = await writeConfig({ ...config, downloadDir: result.filePaths[0] });
  sendToRenderer('config:update', nextConfig);
  return { ok: true, downloadDir: nextConfig.downloadDir };
}

async function flattenPaths(pathsToSend) {
  const files = [];

  for (const selectedPath of pathsToSend) {
    const stat = await fsp.stat(selectedPath);
    if (stat.isFile()) {
      files.push({
        path: selectedPath,
        name: path.basename(selectedPath),
        relativePath: path.basename(selectedPath),
        size: stat.size,
      });
      continue;
    }

    if (stat.isDirectory()) {
      const rootName = path.basename(selectedPath);
      await walkDirectory(selectedPath, selectedPath, rootName, files);
    }
  }

  return files;
}

async function walkDirectory(root, current, rootName, files) {
  const entries = await fsp.readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(root, entryPath, rootName, files);
    } else if (entry.isFile()) {
      const stat = await fsp.stat(entryPath);
      files.push({
        path: entryPath,
        name: entry.name,
        relativePath: path.join(rootName, path.relative(root, entryPath)),
        size: stat.size,
      });
    }
  }
}

async function sendFiles(deviceId, files) {
  const device = devices.get(deviceId);
  if (!device) return { ok: false, error: '设备不在线' };
  if (!files?.length) return { ok: false, error: '没有可发送的文件' };

  runSendQueue(device, files).catch(() => {});

  return { ok: true };
}

async function runSendQueue(device, files) {
  const batch = makeBatch(files);

  for (const file of files) {
    const transferId = crypto.randomUUID();
    const startedAt = Date.now();
    updateTransfer({
      id: transferId,
      direction: 'out',
      status: 'queued',
      fileName: file.relativePath || file.name,
      size: file.size,
      transferred: 0,
      peerName: device.name,
      startedAt,
    });

    try {
      await sendOneFile(device, file, transferId, startedAt, batch);
    } catch (error) {
      failTransfer(transferId, 'out', file.relativePath || file.name, device.name, error.message);
    }
  }
}

function makeBatch(files) {
  if (files.length <= 1) return null;

  const totalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const firstSegments = files
    .map((file) => String(file.relativePath || file.name || '').split(/[\\/]/)[0])
    .filter(Boolean);
  const commonRoot = firstSegments.every((segment) => segment === firstSegments[0]) ? firstSegments[0] : '';

  return {
    id: crypto.randomUUID(),
    name: commonRoot || `${files.length} 个文件`,
    count: files.length,
    totalSize,
  };
}

async function sendOneFile(device, file, transferId, startedAt, batch) {
  const stat = await fsp.stat(file.path);

  const socket = net.createConnection({ host: device.address, port: device.port });
  socket.setNoDelay(true);

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  socket.write(JSON.stringify({
    kind: 'file',
    name: file.name || path.basename(file.path),
    relativePath: file.relativePath || path.basename(file.path),
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    senderId: localDevice.id,
    senderName: localDevice.name,
    batchId: batch?.id,
    batchName: batch?.name,
    batchCount: batch?.count,
    batchTotalSize: batch?.totalSize,
  }) + '\n');

  const response = await readJsonLine(socket);
  if (!response.accept) {
    socket.destroy();
    updateTransfer({
      id: transferId,
      direction: 'out',
      status: 'rejected',
      fileName: file.relativePath || file.name,
      size: stat.size,
      transferred: 0,
      peerName: device.name,
      startedAt,
      finishedAt: Date.now(),
    });
    return;
  }

  const offset = Math.max(0, Math.min(Number(response.offset || 0), stat.size));
  let transferred = offset;
  const input = fs.createReadStream(file.path, { start: offset });
  const completion = response.completionAck ? readJsonLine(socket) : Promise.resolve({ completed: true });

  updateTransfer({
    id: transferId,
    direction: 'out',
    status: 'running',
    fileName: file.relativePath || file.name,
    size: stat.size,
    transferred,
    peerName: device.name,
    resumed: offset > 0,
    startedAt,
  });

  input.on('data', (chunk) => {
    transferred += chunk.length;
    updateTransfer({
      id: transferId,
      direction: 'out',
      status: 'running',
      fileName: file.relativePath || file.name,
      size: stat.size,
      transferred,
      peerName: device.name,
      startedAt,
    });
  });

  let receipt;
  try {
    [, receipt] = await Promise.all([new Promise((resolve, reject) => {
    input.on('error', reject);
    socket.on('error', reject);
    socket.on('close', resolve);
    input.pipe(socket);
    }), completion]);
  } catch (error) {
    input.destroy();
    socket.destroy();
    throw error;
  }
  if (!receipt.completed) throw new Error('接收端未完成保存');

  updateTransfer({
    id: transferId,
    direction: 'out',
    status: transferred >= stat.size ? 'completed' : 'failed',
    fileName: file.relativePath || file.name,
    size: stat.size,
    transferred,
    peerName: device.name,
    startedAt,
    finishedAt: Date.now(),
  });
}

ipcMain.handle('app:get-state', async () => {
  const config = await readConfig();
  return {
    self: {
      id: localDevice.id,
      name: localDevice.name,
      ips: listLocalIPv4(),
      transferPort,
      downloadDir: config.downloadDir,
      conflictPolicy: config.conflictPolicy,
      version: app.getVersion(),
    },
    devices: Array.from(devices.values()),
    history: transferHistory,
    update: updater.state,
  };
});

ipcMain.handle('files:choose', chooseFiles);
ipcMain.handle('config:choose-download-dir', chooseDownloadDir);
ipcMain.handle('config:set-conflict-policy', async (_event, policy) => {
  const config = await writeConfig({ ...await readConfig(), conflictPolicy: validatePolicy(policy) });
  sendToRenderer('config:update', config);
  return config;
});
ipcMain.handle('update:check', () => updater.check());
ipcMain.handle('update:download', () => updater.download());
ipcMain.handle('update:open-releases', () => shell.openExternal(`${REPO}/releases`));
ipcMain.handle('update:launch', async () => {
  if (updater.state.status !== 'ready' || !updater.target) return { ok: false, error: '请先下载新版' };
  if (pendingIncoming.size || [...transfers.values()].some((item) => ['running', 'queued'].includes(item.status))) {
    return { ok: false, error: '请等待传输任务结束后再切换版本' };
  }
  const result = await dialog.showMessageBox(mainWindow, { type: 'question', buttons: ['切换新版', '取消'], defaultId: 1, cancelId: 1,
    message: `切换到 BlinkSend ${updater.release.version}？`, detail: `当前程序会关闭。新版位置：${updater.target}` });
  if (result.response !== 0) return { ok: false };
  if (pendingIncoming.size || [...transfers.values()].some((item) => ['running', 'queued'].includes(item.status))) {
    return { ok: false, error: '有新的传输任务，请稍后切换' };
  }
  await saveHistory();
  const error = await shell.openPath(updater.target);
  if (error) return { ok: false, error };
  app.quit();
  return { ok: true };
});
ipcMain.handle('files:flatten', (_event, filePaths) => flattenPaths(filePaths));
ipcMain.handle('transfer:send', (_event, { deviceId, files }) => sendFiles(deviceId, files));
ipcMain.handle('transfer:accept', (_event, requestId, policy) => acceptIncomingTransfer(requestId, policy));
ipcMain.handle('transfer:reject', (_event, requestId) => rejectIncomingTransfer(requestId));
ipcMain.handle('shell:open-path', (_event, targetPath) => shell.openPath(targetPath));
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggleMaximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => mainWindow?.close());

app.whenReady().then(async () => {
  app.setName(APP_NAME);
  updater = new VersionUpdater({ version: app.getVersion(),
    directory: process.env.PORTABLE_EXECUTABLE_DIR || path.join(app.getPath('downloads'), 'BlinkSend-Updates'),
    onState: (state) => sendToRenderer('update:state', state) });
  localDevice.id = getDeviceId();
  await loadHistory();
  await startTransferServer();
  startDiscovery();
  createWindow();
  mainWindow.webContents.once('did-finish-load', () => { updater.check(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  clearInterval(discoveryTimer);
  clearInterval(pruneTimer);
  udpSocket?.close();
  tcpServer?.close();
});
