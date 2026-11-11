const isMoodleSession = cookie => /^MoodleSession\w*$/.test(cookie.name);

async function restoreMoodleSession(cookies, url, storage, name) {
  const saved = await storage.read(name);
  if (!Array.isArray(saved)) return;
  for (const cookie of saved.filter(isMoodleSession)) {
    const { expirationDate, hostOnly, domain, path, secure, httpOnly, sameSite, value } = cookie;
    if (expirationDate !== undefined && expirationDate <= Date.now() / 1000) continue;
    await cookies.set({ url, name: cookie.name, value, path, secure, httpOnly, sameSite,
      ...(hostOnly ? {} : { domain }), ...(expirationDate === undefined ? {} : { expirationDate }) });
  }
}

async function rememberMoodleSession(cookies, url, storage, name) {
  const saved = (await cookies.get({ url })).filter(isMoodleSession);
  if (saved.length) await storage.write(name, saved);
  else await storage.remove(name);
}

module.exports = { restoreMoodleSession, rememberMoodleSession };
