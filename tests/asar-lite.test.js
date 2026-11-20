'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const asar = require('../tools/asar-lite');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nawe-asar-test-'));
}

test('ASAR Pickle 4-byte alignment works for all JSON length mod 4 values (0, 1, 2, 3)', () => {
  const dir = makeTempDir();
  try {
    for (let padLen = 0; padLen < 4; padLen++) {
      const filePath = path.join(dir, `align-${padLen}.asar`);
      const key = 'a'.repeat(padLen + 1) + '.txt';
      asar.createAsarFromMap(
        {
          [key]: 'hello alignment ' + padLen,
          'empty.txt': '',
        },
        filePath
      );
      const res = asar.verifyAsar(filePath, { checkIntegrity: true });
      assert.equal(res.ok, true);
      assert.equal(res.packedCount, 2);
      assert.equal(asar.readFileText(filePath, key), 'hello alignment ' + padLen);
      assert.equal(asar.readFileText(filePath, 'empty.txt'), '');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('patchAsar preserves unpacked, executable, link, and untouched files verbatim', () => {
  const dir = makeTempDir();
  try {
    const src = path.join(dir, 'orig.asar');
    const dst = path.join(dir, 'patched.asar');
    asar.createAsarFromMap(
      {
        'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
        'dist/main.js': 'console.log("orig main");',
        'dist/preload.js': 'console.log("orig preload");',
        'bin/helper': { content: '#!/bin/sh\necho hi\n', executable: true },
        'native/addon.node': { unpacked: true, size: 12345 },
        'sym/latest': { link: 'bin/helper' },
      },
      src
    );

    const modMap = new Map([
      ['dist/main.js', 'require("./nawe-hook");\nconsole.log("orig main");'],
      ['dist/nawe-hook.js', 'module.exports = { ok: true };'],
      ['.nawe-meta.json', '{"project":"not-a-word-of-english"}'],
    ]);
    const patchRes = asar.patchAsar(src, dst, modMap);
    assert.ok(patchRes.sha256.length === 64);

    const verifyRes = asar.verifyAsar(dst, { checkIntegrity: true });
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.unpackedCount, 1);

    // 验证新修改与新增内容
    assert.match(asar.readFileText(dst, 'dist/main.js'), /nawe-hook/);
    assert.equal(asar.readFileText(dst, 'dist/nawe-hook.js'), 'module.exports = { ok: true };');
    // 验证未修改条目完好
    assert.equal(asar.readFileText(dst, 'dist/preload.js'), 'console.log("orig preload");');

    // 验证元数据（unpacked / executable / link）完整保留
    const entries = new Map(asar.listEntries(dst).map((e) => [e.path, e]));
    assert.equal(entries.get('native/addon.node').unpacked, true);
    assert.equal(entries.get('bin/helper').executable, true);
    assert.equal(entries.get('sym/latest').link, 'bin/helper');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('computeIntegrity splits > 4 MiB buffers into multiple SHA-256 blocks', () => {
  const bigBuf = Buffer.alloc(asar.BLOCK_SIZE + 1024, 0x41);
  const integrity = asar.computeIntegrity(bigBuf);
  assert.equal(integrity.algorithm, 'SHA256');
  assert.equal(integrity.blockSize, asar.BLOCK_SIZE);
  assert.equal(integrity.blocks.length, 2);
  assert.equal(integrity.hash, asar.sha256Buffer(bigBuf));
});

test('verifyAsar detects single-byte corruption inside archive payload', () => {
  const dir = makeTempDir();
  try {
    const filePath = path.join(dir, 'corrupt.asar');
    asar.createAsarFromMap({ 'dist/main.js': 'console.log("safe");' }, filePath);

    // 篡改文件最后一个字节
    const buf = fs.readFileSync(filePath);
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
    fs.writeFileSync(filePath, buf);

    assert.throws(() => asar.verifyAsar(filePath, { checkIntegrity: true }), /SHA-256/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
