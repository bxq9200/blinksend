const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const semver = require('semver');

const REPO = 'https://github.com/bxq9200/blinksend';
const API = 'https://api.github.com/repos/bxq9200/blinksend/releases/latest';

function selectRelease(release, currentVersion) {
  const version = semver.valid(String(release.tag_name || '').replace(/^v/, ''));
  if (!version || release.draft || release.prerelease) throw new Error('发布版本信息无效');
  if (!semver.gt(version, currentVersion)) return null;
  const name = `BlinkSend-Portable-${version}.exe`;
  const asset = (release.assets || []).find((item) => item.name === name && item.state === 'uploaded');
  const url = asset?.browser_download_url;
  if (!asset || !url?.startsWith(`${REPO}/releases/download/`) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error('新版便携包尚未发布完成，请稍后再试');
  }
  return { version, name, url, size: asset.size, digest: asset.digest,
    checksumUrl: release.assets?.find((item) => item.name === 'SHA256SUMS.txt')?.browser_download_url,
    notes: String(release.body || '').slice(0, 8000), releaseUrl: `${REPO}/releases/tag/v${version}` };
}

class VersionUpdater {
  constructor({ version, directory, fetchImpl = fetch, onState = () => {} }) {
    this.version = version;
    this.directory = directory;
    this.fetch = fetchImpl;
    this.onState = onState;
    this.state = { status: 'idle', currentVersion: version };
  }

  emit(patch) { this.state = { ...this.state, ...patch }; this.onState(this.state); return this.state; }

  async check() {
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    this.emit({ status: 'checking', error: null });
    try {
      const response = await this.fetch(API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'BlinkSend' }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(response.status === 404 ? '暂时没有可用的正式版本' : `检查失败 (HTTP ${response.status})`);
      this.release = selectRelease(await response.json(), this.version);
      return this.emit({ status: this.release ? 'available' : 'current', latestVersion: this.release?.version || this.version, notes: this.release?.notes || '' });
    } catch (error) { return this.emit({ status: 'error', error: error.message }); }
  }

  async download() {
    if (!this.release || ['checking', 'downloading', 'ready'].includes(this.state.status)) return this.state;
    const release = this.release;
    const target = path.join(this.directory, release.name);
    const partial = `${target}.${crypto.randomUUID()}.download`;
    let handle;
    this.emit({ status: 'downloading', progress: 0, error: null });
    try {
      let expected = /^sha256:([a-f0-9]{64})$/i.exec(release.digest || '')?.[1];
      if (!expected && release.checksumUrl?.startsWith(`${REPO}/releases/download/`)) {
        const checksum = await this.fetch(release.checksumUrl, { signal: AbortSignal.timeout(15000) });
        if (!checksum.ok) throw new Error('无法获取更新校验信息');
        const line = (await checksum.text()).split(/\r?\n/).find((item) => item.trim().endsWith(`  ${release.name}`));
        expected = /^([a-f0-9]{64})  /i.exec(line || '')?.[1];
      }
      if (!expected) throw new Error('新版缺少 SHA-256 校验信息');
      await fs.mkdir(this.directory, { recursive: true });
      handle = await fs.open(partial, 'wx');
      const response = await this.fetch(release.url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
      if (!response.ok || !response.body) throw new Error(`下载失败 (HTTP ${response.status})`);
      const hash = crypto.createHash('sha256');
      let bytes = 0;
      let emittedAt = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > release.size) throw new Error('下载大小与发布信息不符');
        hash.update(chunk);
        let position = 0;
        while (position < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, position, chunk.length - position);
          if (!bytesWritten) throw new Error('更新文件写入失败');
          position += bytesWritten;
        }
        if (Date.now() - emittedAt >= 250) {
          emittedAt = Date.now();
          this.emit({ progress: Math.floor(bytes / release.size * 100) });
        }
      }
      await handle.close(); handle = null;
      if (bytes !== release.size || hash.digest('hex') !== expected.toLowerCase()) throw new Error('更新包校验失败，请重新下载');
      // An exclusive copy avoids replacing an unrelated executable at the destination.
      await fs.copyFile(partial, target, require('node:fs').constants.COPYFILE_EXCL);
      await fs.unlink(partial);
      this.target = target;
      return this.emit({ status: 'ready', progress: 100, path: target });
    } catch (error) {
      await handle?.close().catch(() => {});
      await fs.unlink(partial).catch(() => {});
      return this.emit({ status: 'error', error: error.code === 'EEXIST' ? '目录中已有同名新版 exe，请先移走后重试' : error.message });
    }
  }
}

module.exports = { VersionUpdater, selectRelease, REPO };
