const path = require('node:path');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const POLICIES = new Set(['keep-both', 'replace', 'new-folder']);

function validatePolicy(value) {
  if (!POLICIES.has(value)) throw new Error('Invalid conflict policy');
  return value;
}

function relativeFilePath(value) {
  if (typeof value !== 'string' || !value) throw new Error('Invalid file path');
  const parts = value.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || part === '..' || part === '.' || /[:\x00-\x1f]/.test(part))) {
    throw new Error('Invalid file path');
  }
  return path.join(...parts);
}

async function exists(value) {
  try { await fs.stat(value); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

class ReceiveStorage {
  constructor() { this.reserved = new Set(); }

  async newFolder(root) {
    await fs.mkdir(root, { recursive: true });
    return fs.mkdtemp(path.join(root, 'BlinkSend-'));
  }

  async prepare(root, header, policy) {
    validatePolicy(policy);
    const target = path.join(root, relativeFilePath(header.relativePath || header.name));
    const identity = JSON.stringify([header.senderId, header.relativePath || header.name, header.size, header.modifiedAt]);
    const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24);
    const partial = path.join(root, '.blinksend-partials', `${key}.part`);
    const metaPath = `${partial}.json`;
    let destination = target;
    let offset = 0;
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      const stat = await fs.stat(partial);
      const withinRoot = path.relative(root, meta.destination);
      if (header.modifiedAt != null && meta.identity === identity && meta.policy === policy
          && withinRoot && !withinRoot.startsWith('..') && !path.isAbsolute(withinRoot)
          && stat.size <= header.size) {
        destination = meta.destination;
        offset = stat.size;
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
    if (this.reserved.has(destination.toLowerCase())) throw new Error('该文件正在接收，请稍后重试');
    if (policy !== 'replace' && await exists(destination)) {
      offset = 0;
      const ext = path.extname(target);
      const base = target.slice(0, target.length - ext.length);
      let index = 1;
      do { destination = `${base} (${index++})${ext}`; }
      while (await exists(destination) || this.reserved.has(destination.toLowerCase()));
    }
    this.reserved.add(destination.toLowerCase());
    const release = () => this.reserved.delete(destination.toLowerCase());
    try {
      await fs.mkdir(path.dirname(partial), { recursive: true });
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(metaPath, JSON.stringify({ identity, policy, destination }));
      if (!offset) await fs.writeFile(partial, Buffer.alloc(0));
    } catch (error) { release(); throw error; }
    return { destination, partial, offset, release, finalize: async () => {
      const stat = await fs.stat(partial);
      if (stat.size !== header.size) throw new Error('接收大小不匹配，保留临时文件');
      if (policy === 'replace') {
        // Rename replaces only after the complete download has reached disk.
        await fs.rename(partial, destination);
      } else {
        try {
          await fs.link(partial, destination);
        } catch (error) {
          if (!['EPERM', 'ENOTSUP', 'EXDEV'].includes(error.code)) throw error;
          await fs.copyFile(partial, destination, require('node:fs').constants.COPYFILE_EXCL);
        }
        await fs.unlink(partial);
      }
      await fs.unlink(metaPath).catch(() => {});
    } };
  }
}

module.exports = { ReceiveStorage, validatePolicy, relativeFilePath };
