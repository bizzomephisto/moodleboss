const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { loadComposer } = require('../src/composer.cjs');
const { secureStorage } = require('../src/secure-storage.cjs');

test('AI keys survive reload only on the saved endpoint and are removed by Forget key', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moodleboss-keys-'));
  // Test the storage integration with a stand-in for the OS encryption API.
  const os = { isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async value => Buffer.from(value).reverse(),
    decryptStringAsync: async bytes => ({ result: Buffer.from(bytes).reverse().toString() }) };
  const settings = { provider: 'compatible', model: 'fixture', endpoint: 'https://ai.example/v1' };
  try {
    const storage = await secureStorage(directory, os, 'win32');
    let composer = await loadComposer(directory, storage);
    await composer.saveSettings({ ...settings, key: 'fixture-key' });
    assert.doesNotMatch(await readFile(path.join(directory, 'composer.json'), 'utf8'), /fixture-key/);
    composer = await loadComposer(directory, storage);
    assert.equal(composer.get().hasKey, true);
    assert.equal((await composer.saveSettings({ ...settings, endpoint: 'https://other.example/v1' })).hasKey, false);
    assert.equal((await composer.saveSettings(settings)).hasKey, true);
    await composer.saveSettings({ ...settings, clearKey: true });
    assert.equal((await loadComposer(directory, storage)).get().hasKey, false);

    const fallback = await secureStorage(directory, { isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'basic_text' }, 'linux');
    composer = await loadComposer(directory, fallback);
    assert.equal((await composer.saveSettings({ ...settings, key: 'fixture-key' })).hasKey, true);
    assert.equal((await loadComposer(directory, fallback)).get().hasKey, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
