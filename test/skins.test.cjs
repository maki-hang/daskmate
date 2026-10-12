const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { allSkins, builtins } = require('../src/core/skins.cjs');
const catalog = require('../assets/catalog.json');
const lock = require('../assets/upstream-lock.json');

test('every bundled character has six intact animated WebPs, provenance and complete notices', async () => {
  assert.equal(builtins.length, 8);
  assert.equal(new Set(builtins.map(s => s.id)).size, 8);
  assert.equal(builtins[0].id, 'white-dragon', 'existing default remains stable');
  assert.equal(lock.revision, catalog.revision);
  assert.equal(lock.repository, catalog.repository);
  const skins = allSkins({ state: { skins: [] } }), checked = new Set();
  for (const skin of skins) {
    assert.deepEqual(Object.keys(skin.names).sort(), ['en', 'ja', 'zh-CN']);
    assert.ok(Object.values(skin.names).every(n => typeof n === 'string' && n.trim()));
    assert.equal(skin.license, 'CC BY-NC 4.0');
    assert.ok(skin.source.startsWith(`${catalog.repository}/tree/${catalog.revision}/`));
    assert.deepEqual(Object.keys(skin.states).sort(), ['attention', 'error', 'happy', 'idle', 'reminder', 'working']);
    const files = [...Object.values(skin.states).map(fileURLToPath), ...['UPSTREAM-LICENSE.txt', 'UPSTREAM-NOTICE.md'].map(file => path.join(skin.directory, file))];
    for (const file of files) {
      const bytes = await fs.readFile(file), relative = path.relative(path.resolve(__dirname, '../assets'), file).split(path.sep).join('/');
      const source = lock.files[relative];
      assert.ok(source, `${relative} has a source record`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256, relative);
      assert.equal(bytes.length, source.bytes);
      checked.add(relative);
      if (!file.endsWith('.webp')) continue;
      assert.equal(source.path, `${skin.source.split('/').pop()}/qa/previews/${path.basename(file)}`);
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
      assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
      assert.equal(bytes.readUInt32LE(4) + 8, bytes.length, 'RIFF must be complete');
      const chunks = [];
      for (let offset = 12; offset < bytes.length;) {
        const size = bytes.readUInt32LE(offset + 4);
        chunks.push(bytes.toString('ascii', offset, offset + 4));
        offset += 8 + size + (size % 2);
        assert.ok(offset <= bytes.length, 'no truncated frames');
      }
      assert.ok(chunks.includes('ANIM'), `${relative} is animated`);
      assert.ok(chunks.filter(c => c === 'ANMF').length > 1, `${relative} has multiple frames`);
    }
    assert.match(await fs.readFile(path.join(skin.directory, 'UPSTREAM-LICENSE.txt'), 'utf8'), /Attribution-NonCommercial 4.0/);
    assert.match(await fs.readFile(path.join(skin.directory, 'UPSTREAM-NOTICE.md'), 'utf8'), /unofficial fan art/);
  }
  assert.equal(checked.size, 64);
  assert.deepEqual([...checked].sort(), Object.keys(lock.files).sort());
});
