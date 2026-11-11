const { readFile, writeFile, rename, rm } = require('node:fs/promises');
const path = require('node:path');

async function secureStorage(directory, safeStorage, platform = process.platform) {
  // On Electron 45 the Linux backend name describes the synchronous API only.
  const linux = platform === 'linux';
  const available = await Promise.resolve().then(() => linux
    ? safeStorage.isEncryptionAvailable() && ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']
      .includes(safeStorage.getSelectedStorageBackend())
    : safeStorage.isAsyncEncryptionAvailable()).catch(() => false);
  const file = name => path.join(directory, name + '.enc');
  return {
    available,
    async read(name) {
      if (!available) return null;
      const encrypted = await readFile(file(name)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!encrypted) return null;
      const json = linux ? safeStorage.decryptString(encrypted) :
        (await safeStorage.decryptStringAsync(encrypted)).result;
      return JSON.parse(json);
    },
    async write(name, value) {
      if (!available) throw new Error('Secure credential storage is unavailable.');
      const json = JSON.stringify(value);
      const encrypted = linux ? safeStorage.encryptString(json) : await safeStorage.encryptStringAsync(json);
      const target = file(name);
      await writeFile(target + '.tmp', encrypted, { mode: 0o600 });
      await rename(target + '.tmp', target);
    },
    async remove(name) {
      await rm(file(name), { force: true });
      await rm(file(name) + '.tmp', { force: true });
    },
  };
}

module.exports = { secureStorage };
