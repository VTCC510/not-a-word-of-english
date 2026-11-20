'use strict';

/**
 * tools/asar-lite.js
 * 零外部依赖的纯原生 Node.js ASAR 读取、完整性校验与虚拟补丁引擎。
 *
 * 设计亮点：
 * 1. 严格遵循 Electron Chromium Pickle 二进制头与 4 字节对齐规范。
 * 2. 自动计算并写入与官方 @electron/asar 完全一致的 4MB 分块 SHA-256 integrity 字段。
 * 3. patchAsar() 采用“包内虚拟替换”：无需把上千个文件解压到硬盘，完整保留所有未修改文件、
 *    unpacked: true 外部解压映射、executable 权限标记与符号链接元数据。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BLOCK_SIZE = 4 * 1024 * 1024; // 4 MiB，与 @electron/asar 官方分块大小一致

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * 计算与 @electron/asar 完全一致的 integrity 元数据对象。
 */
function computeIntegrity(buf) {
  const fullHash = sha256Buffer(buf);
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(fullHash);
  } else {
    for (let offset = 0; offset < buf.length; offset += BLOCK_SIZE) {
      const slice = buf.subarray(offset, Math.min(offset + BLOCK_SIZE, buf.length));
      blocks.push(sha256Buffer(slice));
    }
  }
  return {
    algorithm: 'SHA256',
    hash: fullHash,
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

/**
 * 编码 ASAR 文件头（双层 Chromium Pickle）。
 */
function encodeHeaderPickle(headerObj) {
  const jsonBuf = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const pad = (4 - (jsonBuf.length % 4)) % 4;
  const headerPayloadSize = 4 + jsonBuf.length + pad;
  const headerPickleSize = 4 + headerPayloadSize;

  const out = Buffer.alloc(8 + headerPickleSize, 0);
  // 外层 sizePickle（8 字节）
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(headerPickleSize, 4);
  // 内层 headerPickle
  out.writeUInt32LE(headerPayloadSize, 8);
  out.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(out, 16);
  // 末尾 0..3 字节已由 Buffer.alloc 填零对齐
  return out;
}

/**
 * 读取并校验 ASAR 文件头。
 */
function readHeader(asarPath) {
  const stat = fs.statSync(asarPath);
  if (stat.size < 16) {
    throw new Error(`无效的 ASAR 文件（体积过小: ${stat.size} 字节）: ${asarPath}`);
  }
  const fd = fs.openSync(asarPath, 'r');
  try {
    const prefix = Buffer.alloc(16);
    fs.readSync(fd, prefix, 0, 16, 0);

    const sizePicklePayload = prefix.readUInt32LE(0);
    const headerPickleSize = prefix.readUInt32LE(4);
    const headerPayloadSize = prefix.readUInt32LE(8);
    const jsonByteLen = prefix.readUInt32LE(12);

    if (sizePicklePayload !== 4) {
      throw new Error(`ASAR sizePickle 格式异常（期望 4，实际 ${sizePicklePayload}）`);
    }
    if (headerPickleSize !== 4 + headerPayloadSize) {
      throw new Error(`ASAR headerPickle 长度不一致`);
    }
    const pad = (4 - (jsonByteLen % 4)) % 4;
    if (headerPayloadSize !== 4 + jsonByteLen + pad) {
      throw new Error(`ASAR JSON 对齐长度异常`);
    }
    const baseOffset = 8 + headerPickleSize;
    if (baseOffset > stat.size) {
      throw new Error(`ASAR 文件被截断（头结束于 ${baseOffset}，文件仅 ${stat.size} 字节）`);
    }

    const jsonBuf = Buffer.alloc(jsonByteLen);
    fs.readSync(fd, jsonBuf, 0, jsonByteLen, 16);
    const header = JSON.parse(jsonBuf.toString('utf8'));
    if (!header || typeof header !== 'object' || !header.files) {
      throw new Error('ASAR JSON 头缺少根 files 字段');
    }

    return {
      header,
      headerSize: headerPickleSize,
      baseOffset,
      fileSize: stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function normalizeRelPath(relPath) {
  return String(relPath)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function findEntry(header, relPath) {
  const norm = normalizeRelPath(relPath);
  if (!norm) return header;
  let cur = header;
  for (const part of norm.split('/')) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      return null;
    }
    cur = cur.files[part];
  }
  return cur;
}

/**
 * 列出 ASAR 内所有文件条目。
 */
function listEntries(asarPath) {
  const { header } = readHeader(asarPath);
  const entries = [];
  function walk(node, prefix) {
    for (const [name, meta] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (meta.files) {
        walk(meta, rel);
      } else {
        entries.push({ path: rel, ...meta });
      }
    }
  }
  walk(header, '');
  return entries;
}

/**
 * 从 ASAR 读取单个文件的 Buffer（若不存在返回 null）。
 */
function readFileBuffer(asarPath, relPath) {
  const { header, baseOffset } = readHeader(asarPath);
  const entry = findEntry(header, relPath);
  if (!entry || entry.files) return null;
  if (entry.unpacked) {
    const unpackedPath = path.join(`${asarPath}.unpacked`, normalizeRelPath(relPath));
    return fs.existsSync(unpackedPath) ? fs.readFileSync(unpackedPath) : null;
  }
  if (entry.link) return null;

  const size = Number(entry.size || 0);
  const offset = Number(entry.offset || 0);
  if (size === 0) return Buffer.alloc(0);

  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buf, 0, size, baseOffset + offset);
    if (bytesRead !== size) {
      throw new Error(`读取 ASAR 条目失败（截断）: ${relPath}`);
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function readFileText(asarPath, relPath) {
  const buf = readFileBuffer(asarPath, relPath);
  return buf ? buf.toString('utf8') : null;
}

/**
 * 校验 ASAR 归档结构、边界长度与（可选）所有打包条目的 SHA-256 完整性。
 */
function verifyAsar(asarPath, { checkIntegrity = true } = {}) {
  const { header, baseOffset, fileSize } = readHeader(asarPath);
  const fd = fs.openSync(asarPath, 'r');
  let packedCount = 0;
  let unpackedCount = 0;
  let maxEnd = 0;

  try {
    function walk(node, prefix) {
      for (const [name, meta] of Object.entries(node.files || {})) {
        const rel = prefix ? `${prefix}/${name}` : name;
        if (meta.files) {
          walk(meta, rel);
          continue;
        }
        if (meta.unpacked) {
          unpackedCount++;
          continue;
        }
        if (meta.link) {
          continue;
        }
        packedCount++;
        const offset = Number(meta.offset);
        const size = Number(meta.size);
        if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(size) || size < 0) {
          throw new Error(`条目偏移或大小无效: ${rel}`);
        }
        const end = offset + size;
        if (baseOffset + end > fileSize) {
          throw new Error(`条目越界（超出文件末尾）: ${rel}`);
        }
        if (end > maxEnd) maxEnd = end;

        if (checkIntegrity && meta.integrity && meta.integrity.algorithm === 'SHA256') {
          const buf = Buffer.alloc(size);
          if (size > 0) {
            fs.readSync(fd, buf, 0, size, baseOffset + offset);
          }
          const actual = computeIntegrity(buf);
          if (actual.hash !== meta.integrity.hash) {
            throw new Error(`条目 SHA-256 完整性校验失败: ${rel}`);
          }
        }
      }
    }

    walk(header, '');
  } finally {
    fs.closeSync(fd);
  }

  if (baseOffset + maxEnd !== fileSize) {
    throw new Error(
      `ASAR 总长度不匹配（头部+数据区=${baseOffset + maxEnd}，实际文件=${fileSize}）`
    );
  }

  return {
    ok: true,
    fileSize,
    packedCount,
    unpackedCount,
  };
}

/**
 * 在内存树中设置或删除路径节点。
 */
function cloneHeader(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function ensureDirNode(root, dirParts) {
  let cur = root;
  for (const part of dirParts) {
    if (!cur.files) cur.files = {};
    if (!cur.files[part]) {
      cur.files[part] = { files: {} };
    }
    if (!cur.files[part].files) {
      throw new Error(`路径冲突：${part} 已存在且不是目录`);
    }
    cur = cur.files[part];
  }
  return cur;
}

function deletePathNode(root, relPath) {
  const parts = normalizeRelPath(relPath).split('/');
  const leaf = parts.pop();
  let cur = root;
  for (const part of parts) {
    if (!cur.files || !cur.files[part]) return;
    cur = cur.files[part];
  }
  if (cur.files && leaf) {
    delete cur.files[leaf];
  }
}

/**
 * 虚拟补丁打包（核心方法）：
 * 读取 srcAsarPath，保留所有未修改条目（含 unpacked / executable / link），
 * 仅应用 modifications（Map 或普通对象: { 'dist/main.js': Buffer|string, ... }，值为 null 表示删除），
 * 原子写入 destAsarPath，并在返回前自动做完整性自检。
 */
function patchAsar(srcAsarPath, destAsarPath, modifications) {
  const modMap = new Map();
  if (modifications instanceof Map) {
    for (const [k, v] of modifications.entries()) {
      modMap.set(normalizeRelPath(k), v);
    }
  } else if (modifications && typeof modifications === 'object') {
    for (const [k, v] of Object.entries(modifications)) {
      modMap.set(normalizeRelPath(k), v);
    }
  }

  const { header: srcHeader, baseOffset: srcBaseOffset } = readHeader(srcAsarPath);
  const newHeader = cloneHeader(srcHeader);

  // 先在头树中应用删除与新增占位
  for (const [rel, content] of modMap.entries()) {
    if (content === null) {
      deletePathNode(newHeader, rel);
    } else {
      const parts = rel.split('/');
      const fileName = parts.pop();
      const dirNode = ensureDirNode(newHeader, parts);
      const existing = dirNode.files[fileName];
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      const nextMeta = {
        size: buf.length,
        offset: '0',
        integrity: computeIntegrity(buf),
      };
      if (existing && existing.executable) {
        nextMeta.executable = true;
      }
      dirNode.files[fileName] = nextMeta;
    }
  }

  // 第一遍：收集所有待写入的数据片段并计算精确 offset
  const writePlan = [];
  let cursor = 0;

  function assignOffsets(node, prefix) {
    for (const [name, meta] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (meta.files) {
        assignOffsets(meta, rel);
        continue;
      }
      if (meta.unpacked || meta.link) {
        continue;
      }
      if (modMap.has(rel)) {
        const raw = modMap.get(rel);
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
        meta.size = buf.length;
        meta.offset = String(cursor);
        meta.integrity = computeIntegrity(buf);
        writePlan.push({ type: 'buffer', buf });
        cursor += buf.length;
      } else {
        const srcEntry = findEntry(srcHeader, rel);
        if (!srcEntry) {
          throw new Error(`源 ASAR 中找不到未修改条目: ${rel}`);
        }
        const size = Number(srcEntry.size);
        const srcOffset = Number(srcEntry.offset);
        meta.size = size;
        meta.offset = String(cursor);
        writePlan.push({ type: 'copy', srcOffset, size });
        cursor += size;
      }
    }
  }

  assignOffsets(newHeader, '');

  // 第二遍：先写入临时文件，校验后再原子重命名到 destAsarPath
  const destDir = path.dirname(destAsarPath);
  fs.mkdirSync(destDir, { recursive: true });
  const tmpPath = `${destAsarPath}.tmp.${process.pid}.${Date.now()}`;

  const srcFd = fs.openSync(srcAsarPath, 'r');
  const dstFd = fs.openSync(tmpPath, 'w');
  const copyBuf = Buffer.allocUnsafe(1024 * 1024);

  try {
    const headerPickle = encodeHeaderPickle(newHeader);
    fs.writeSync(dstFd, headerPickle);

    for (const item of writePlan) {
      if (item.type === 'buffer') {
        if (item.buf.length > 0) {
          fs.writeSync(dstFd, item.buf);
        }
      } else {
        let remaining = item.size;
        let readPos = srcBaseOffset + item.srcOffset;
        while (remaining > 0) {
          const toRead = Math.min(remaining, copyBuf.length);
          const n = fs.readSync(srcFd, copyBuf, 0, toRead, readPos);
          if (n <= 0) {
            throw new Error(`复制源 ASAR 数据时意外到达文件末尾`);
          }
          fs.writeSync(dstFd, copyBuf, 0, n);
          readPos += n;
          remaining -= n;
        }
      }
    }
    fs.fsyncSync(dstFd);
  } catch (err) {
    try { fs.closeSync(dstFd); } catch (_) {}
    try { fs.closeSync(srcFd); } catch (_) {}
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }

  fs.closeSync(dstFd);
  fs.closeSync(srcFd);

  // 写入完成后立即对临时文件做全量完整性自检
  try {
    verifyAsar(tmpPath, { checkIntegrity: true });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    throw new Error(`新生成的 ASAR 自检失败，已自动中止并清理临时文件: ${err.message}`);
  }

  fs.renameSync(tmpPath, destAsarPath);
  return {
    destAsarPath,
    sha256: sha256File(destAsarPath),
    size: fs.statSync(destAsarPath).size,
  };
}

/**
 * 从内存文件映射直接生成一个全新的 ASAR 归档（主要用于自动化测试）。
 * fileMap 条目值支持 Buffer | string | { content, executable?, unpacked?, link? }
 */
function createAsarFromMap(fileMap, destAsarPath) {
  const header = { files: {} };
  const buffers = [];
  let cursor = 0;

  for (const [rawKey, spec] of Object.entries(fileMap)) {
    const rel = normalizeRelPath(rawKey);
    const parts = rel.split('/');
    const fileName = parts.pop();
    const dirNode = ensureDirNode(header, parts);

    if (spec && typeof spec === 'object' && !Buffer.isBuffer(spec)) {
      if (spec.unpacked) {
        dirNode.files[fileName] = { size: Number(spec.size || 0), unpacked: true };
        continue;
      }
      if (spec.link) {
        dirNode.files[fileName] = { link: String(spec.link) };
        continue;
      }
      const buf = Buffer.isBuffer(spec.content)
        ? spec.content
        : Buffer.from(String(spec.content || ''), 'utf8');
      const meta = {
        size: buf.length,
        offset: String(cursor),
        integrity: computeIntegrity(buf),
      };
      if (spec.executable) meta.executable = true;
      dirNode.files[fileName] = meta;
      buffers.push(buf);
      cursor += buf.length;
    } else {
      const buf = Buffer.isBuffer(spec) ? spec : Buffer.from(String(spec), 'utf8');
      dirNode.files[fileName] = {
        size: buf.length,
        offset: String(cursor),
        integrity: computeIntegrity(buf),
      };
      buffers.push(buf);
      cursor += buf.length;
    }
  }

  fs.mkdirSync(path.dirname(destAsarPath), { recursive: true });
  const fd = fs.openSync(destAsarPath, 'w');
  try {
    fs.writeSync(fd, encodeHeaderPickle(header));
    for (const buf of buffers) {
      if (buf.length > 0) fs.writeSync(fd, buf);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return verifyAsar(destAsarPath, { checkIntegrity: true });
}

module.exports = {
  BLOCK_SIZE,
  sha256Buffer,
  sha256File,
  computeIntegrity,
  encodeHeaderPickle,
  readHeader,
  listEntries,
  readFileBuffer,
  readFileText,
  verifyAsar,
  patchAsar,
  createAsarFromMap,
};
