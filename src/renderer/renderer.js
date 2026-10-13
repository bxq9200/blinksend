const state = {
  self: null,
  devices: [],
  selectedDeviceId: null,
  transfers: new Map(),
  requests: new Map(),
  history: [],
};
lucide.createIcons();

let transferRenderFrame = null;
let historyRenderFrame = null;

const devicesEl = document.querySelector('#devices');
const selfInfoEl = document.querySelector('#selfInfo');
const targetTitleEl = document.querySelector('#targetTitle');
const targetSubtitleEl = document.querySelector('#targetSubtitle');
const chooseFilesEl = document.querySelector('#chooseFiles');
const dropZoneEl = document.querySelector('#dropZone');
const transfersEl = document.querySelector('#transfers');
const requestsEl = document.querySelector('#requests');
const queueCountEl = document.querySelector('#queueCount');
const requestCountEl = document.querySelector('#requestCount');
const deviceCountEl = document.querySelector('#deviceCount');
const onlinePillEl = document.querySelector('#onlinePill');
const sentCountEl = document.querySelector('#sentCount');
const receivedCountEl = document.querySelector('#receivedCount');
const downloadDirEl = document.querySelector('#downloadDir');
const chooseDownloadDirEl = document.querySelector('#chooseDownloadDir');
const historyEl = document.querySelector('#history');
const historyCountEl = document.querySelector('#historyCount');
const conflictPolicyEl = document.querySelector('#conflictPolicy');
const updateDialog = document.querySelector('#updateDialog');
let updateState = {};

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatSpeed(bytesPerSecond = 0) {
  if (!bytesPerSecond) return '0 B/s';
  return `${formatBytes(bytesPerSecond)}/s`;
}

function statusText(status) {
  return {
    queued: '排队中',
    running: '传输中',
    completed: '完成',
    failed: '失败',
    rejected: '已拒绝',
  }[status] || status;
}

function directionText(direction) {
  return direction === 'out' ? '发送' : '接收';
}

function selectedDevice() {
  return state.devices.find((device) => device.id === state.selectedDeviceId);
}

function renderSelf() {
  if (!state.self) return;
  const ipText = state.self.ips.length ? state.self.ips.join(', ') : '未检测到局域网 IP';
  selfInfoEl.textContent = `${state.self.name} · ${ipText}`;
  downloadDirEl.textContent = shortPath(state.self.downloadDir);
  downloadDirEl.title = state.self.downloadDir;
  conflictPolicyEl.value = state.self.conflictPolicy || 'keep-both';
  document.querySelector('#appVersion').textContent = `v${state.self.version}`;
}

function shortPath(value) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return value;
  return `${parts.at(-2)}\\${parts.at(-1)}`;
}

function renderDevices() {
  deviceCountEl.textContent = state.devices.length;
  onlinePillEl.textContent = `${state.devices.length} 台在线`;

  if (!state.devices.length) {
    devicesEl.innerHTML = '<div class="empty-state">暂未发现其他设备。</div>';
    return;
  }

  devicesEl.innerHTML = '';
  for (const device of state.devices) {
    const button = document.createElement('button');
    button.className = `device${device.id === state.selectedDeviceId ? ' is-selected' : ''}`;
    button.innerHTML = `<strong>${escapeHtml(device.name)}</strong><span>${device.address}:${device.port}</span>`;
    button.addEventListener('click', () => {
      state.selectedDeviceId = device.id;
      renderDevices();
      renderTarget();
    });
    devicesEl.appendChild(button);
  }
}

function renderTarget() {
  const device = selectedDevice();
  const hasTarget = Boolean(device);
  chooseFilesEl.disabled = !hasTarget;
  dropZoneEl.classList.toggle('is-disabled', !hasTarget);

  if (!device) {
    targetTitleEl.textContent = '未选择';
    targetSubtitleEl.textContent = '选择在线设备后开始传输';
    return;
  }

  targetTitleEl.textContent = device.name;
  targetSubtitleEl.textContent = `${device.address}:${device.port}`;
}

function renderTransfers() {
  const transfers = Array.from(state.transfers.values()).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  queueCountEl.textContent = transfers.length;
  sentCountEl.textContent = state.history.filter((item) => item.direction === 'out' && item.status === 'completed').length;
  receivedCountEl.textContent = state.history.filter((item) => item.direction === 'in' && item.status === 'completed').length;

  if (!transfers.length) {
    transfersEl.className = 'transfers empty-state';
    transfersEl.textContent = '还没有传输任务。';
    return;
  }

  transfersEl.className = 'transfers';
  transfersEl.innerHTML = '';

  for (const transfer of transfers.slice(0, 80)) {
    const percent = transfer.size ? Math.min(100, Math.round((transfer.transferred || 0) / transfer.size * 100)) : 0;
    const item = document.createElement('div');
    item.className = 'transfer';
    item.innerHTML = `
      <div class="transfer-head">
        <div>
          <div class="transfer-title">${escapeHtml(transfer.fileName || '未知文件')}</div>
          <div class="meta">${transfer.direction === 'out' ? '发送到' : '来自'} ${escapeHtml(transfer.peerName || '未知设备')} · ${formatBytes(transfer.transferred || 0)} / ${formatBytes(transfer.size || 0)} · ${formatSpeed(transfer.speed || 0)}</div>
        </div>
        <span class="status ${transfer.status}">${statusText(transfer.status)}</span>
      </div>
      <div class="progress"><div class="bar" style="width:${percent}%"></div></div>
    `;
    if (transfer.destinationPath && transfer.status === 'completed') {
      const button = document.createElement('button');
      button.className = 'ghost-button';
      button.style.marginTop = '10px';
      button.textContent = '打开文件';
      button.addEventListener('click', () => window.lanShare.openPath(transfer.destinationPath));
      item.appendChild(button);
    }
    transfersEl.appendChild(item);
  }
}

function scheduleTransferRender() {
  if (transferRenderFrame) return;
  transferRenderFrame = requestAnimationFrame(() => {
    transferRenderFrame = null;
    renderTransfers();
  });
}

function scheduleHistoryRender() {
  if (historyRenderFrame) return;
  historyRenderFrame = requestAnimationFrame(() => {
    historyRenderFrame = null;
    renderHistory();
    renderTransfers();
  });
}

function renderRequests() {
  const requests = Array.from(state.requests.values());
  requestCountEl.textContent = requests.length;

  if (!requests.length) {
    requestsEl.className = 'requests empty-state';
    requestsEl.textContent = '等待其他设备发送文件。';
    return;
  }

  requestsEl.className = 'requests';
  requestsEl.innerHTML = '';

  for (const request of requests) {
    const title = request.batchId
      ? `${request.batchName || '文件夹'} (${request.batchCount || 1} 项)`
      : (request.relativePath || request.fileName);
    const size = request.batchId ? request.batchTotalSize : request.size;
    const item = document.createElement('div');
    item.className = 'request';
    item.innerHTML = `
      <div class="request-head">
        <div>
          <div class="request-title">${escapeHtml(title)}</div>
          <div class="meta">来自 ${escapeHtml(request.from.name)} · ${formatBytes(size)}</div>
        </div>
      </div>
      <label class="request-policy">同名文件 <select aria-label="本次接收的同名文件处理方式">
        <option value="keep-both">保留两份</option>
        <option value="replace">替换原文件</option>
        <option value="new-folder">保存到新目录</option>
      </select></label>
      <div class="request-actions"></div>
    `;

    const actions = item.querySelector('.request-actions');
    const policySelect = item.querySelector('select');
    policySelect.value = request.policy || state.self?.conflictPolicy || 'keep-both';
    policySelect.addEventListener('change', () => { request.policy = policySelect.value; });
    const accept = document.createElement('button');
    accept.className = 'primary-button';
    accept.textContent = '接收';
    accept.addEventListener('click', async () => {
      accept.disabled = reject.disabled = true;
      try {
        const result = await window.lanShare.acceptTransfer(request.id, policySelect.value);
        if (!result.ok) { alert(result.error || '接收失败'); return; }
        state.requests.delete(request.id);
        renderRequests();
      } catch (error) { alert(error.message); }
      finally { accept.disabled = reject.disabled = false; }
    });

    const reject = document.createElement('button');
    reject.className = 'danger-button';
    reject.textContent = '拒绝';
    reject.addEventListener('click', async () => {
      await window.lanShare.rejectTransfer(request.id);
      state.requests.delete(request.id);
      renderRequests();
    });

    actions.append(accept, reject);
    requestsEl.appendChild(item);
  }
}

function renderHistory() {
  historyCountEl.textContent = state.history.length;

  if (!state.history.length) {
    historyEl.className = 'history empty-state';
    historyEl.textContent = '完成、失败和拒绝的记录会保存在这里。';
    return;
  }

  historyEl.className = 'history';
  historyEl.innerHTML = '';

  for (const item of state.history.slice(0, 30)) {
    const row = document.createElement('div');
    row.className = 'history-item';
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(item.fileName || '未知文件')}</strong>
        <span>${directionText(item.direction)} · ${escapeHtml(item.peerName || '未知设备')} · ${formatBytes(item.size || 0)}</span>
      </div>
      <span class="status ${item.status}">${statusText(item.status)}</span>
    `;
    historyEl.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function sendPaths(paths) {
  const device = selectedDevice();
  if (!device) return;

  const files = await window.lanShare.flattenFiles(paths);
  const result = await window.lanShare.sendFiles(device.id, files);
  if (!result.ok) {
    alert(result.error || '发送失败');
  }
}

chooseFilesEl.addEventListener('click', async () => {
  const files = await window.lanShare.chooseFiles();
  const device = selectedDevice();
  if (device && files.length) {
    const result = await window.lanShare.sendFiles(device.id, files);
    if (!result.ok) alert(result.error || '发送失败');
  }
});

chooseDownloadDirEl.addEventListener('click', async () => {
  const result = await window.lanShare.chooseDownloadDir();
  if (result.downloadDir) {
    state.self.downloadDir = result.downloadDir;
    renderSelf();
  }
});

dropZoneEl.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (selectedDevice()) dropZoneEl.classList.add('is-active');
});

dropZoneEl.addEventListener('dragleave', () => {
  dropZoneEl.classList.remove('is-active');
});

dropZoneEl.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropZoneEl.classList.remove('is-active');
  if (!selectedDevice()) return;

  const paths = Array.from(event.dataTransfer.files)
    .map((file) => window.lanShare.filePathFromFile(file))
    .filter(Boolean);

  await sendPaths(paths);
});

window.lanShare.onDevices((devices) => {
  state.devices = devices;
  if (state.selectedDeviceId && !devices.some((device) => device.id === state.selectedDeviceId)) {
    state.selectedDeviceId = null;
  }
  renderDevices();
  renderTarget();
});

window.lanShare.onIncomingRequest((request) => {
  state.requests.set(request.id, request);
  renderRequests();
});

window.lanShare.onTransferUpdate((transfer) => {
  state.transfers.set(transfer.id, {
    ...state.transfers.get(transfer.id),
    ...transfer,
  });
  scheduleTransferRender();

  if (['completed', 'failed', 'rejected'].includes(transfer.status)) {
    setTimeout(() => {
      const current = state.transfers.get(transfer.id);
      if (current && ['completed', 'failed', 'rejected'].includes(current.status)) {
        state.transfers.delete(transfer.id);
        scheduleTransferRender();
      }
    }, 5000);
  }
});

window.lanShare.onHistoryUpdate((history) => {
  state.history = history;
  scheduleHistoryRender();
});

window.lanShare.onConfigUpdate((config) => {
  if (state.self && config.downloadDir) {
    state.self.downloadDir = config.downloadDir;
    state.self.conflictPolicy = config.conflictPolicy;
    renderSelf();
  }
});

conflictPolicyEl.addEventListener('change', async () => {
  try {
    const config = await window.lanShare.setConflictPolicy(conflictPolicyEl.value);
    state.self.conflictPolicy = config.conflictPolicy;
  } catch (error) { alert(error.message); renderSelf(); }
});

function renderUpdate(value) {
  updateState = value;
  const labels = { idle: '尚未检查', checking: '正在检查更新…', current: '当前已是最新版本', available: `发现新版 v${value.latestVersion}`,
    downloading: `正在下载 ${value.progress || 0}%`, ready: '新版已下载并校验，可切换运行', error: value.error || '更新失败' };
  document.querySelector('#updateStatus').textContent = `当前 v${value.currentVersion || state.self?.version || ''} · ${labels[value.status] || ''}`;
  document.querySelector('#updateNotes').textContent = value.notes || '';
  document.querySelector('#checkUpdateBtn').disabled = ['checking', 'downloading', 'ready'].includes(value.status);
  document.querySelector('#downloadUpdateBtn').hidden = !['available', 'error'].includes(value.status) || !value.latestVersion || value.latestVersion === value.currentVersion;
  document.querySelector('#launchUpdateBtn').hidden = value.status !== 'ready';
  document.querySelector('#updateProgress').hidden = value.status !== 'downloading';
  document.querySelector('#updateProgress').value = value.progress || 0;
  document.querySelector('#updateBtn').title = value.status === 'available' ? `发现新版 v${value.latestVersion}` : '版本更新';
  document.querySelector('#updateBtn').classList.toggle('has-update', value.status === 'available' || value.status === 'ready');
}
document.querySelector('#updateBtn').addEventListener('click', () => { updateDialog.showModal(); renderUpdate(updateState); });
document.querySelector('#closeUpdateBtn').addEventListener('click', () => updateDialog.close());
document.querySelector('#checkUpdateBtn').addEventListener('click', async () => renderUpdate(await window.lanShare.checkUpdate()));
document.querySelector('#downloadUpdateBtn').addEventListener('click', async () => renderUpdate(await window.lanShare.downloadUpdate()));
document.querySelector('#launchUpdateBtn').addEventListener('click', async () => { const result = await window.lanShare.launchUpdate(); if (result.error) alert(result.error); });
document.querySelector('#releasesBtn').addEventListener('click', () => window.lanShare.openReleases());
window.lanShare.onUpdate(renderUpdate);
window.lanShare.onRequestClosed((id) => { state.requests.delete(id); renderRequests(); });

document.querySelector('#minBtn').addEventListener('click', () => window.lanShare.minimize());
document.querySelector('#maxBtn').addEventListener('click', () => window.lanShare.toggleMaximize());
document.querySelector('#closeBtn').addEventListener('click', () => window.lanShare.close());
window.lanShare.onMaximizedChange((isMaximized) => {
  document.body.classList.toggle('is-maximized', Boolean(isMaximized));
});

window.lanShare.getState().then((initialState) => {
  state.self = initialState.self;
  state.devices = initialState.devices;
  state.history = initialState.history || [];
  renderUpdate(initialState.update || {});
  renderSelf();
  renderDevices();
  renderTarget();
  renderTransfers();
  renderRequests();
  renderHistory();
});
