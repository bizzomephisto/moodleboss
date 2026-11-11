const { app, BrowserWindow, ipcMain, session, protocol, shell, dialog, safeStorage } = require('electron');
const { createHash } = require('node:crypto');
const { mkdir, readFile, rename, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { repository } = require('../package.json');
const {
  origin, loginPath, liveSite, siteUrls, courseScope, dashboardMethods, SignInRequired, dashboard, courseSections, announcementsUrl,
  assignmentSettings, setAssignmentVisibility, deleteAssignment,
} = require('./moodle.cjs');
const { loadComposer, draftFrom } = require('./composer.cjs');
const { fillAssignment } = require('./assignment-form.cjs');
const { site: louisianaMoodle, isSignInRedirect, microsoftSignIn } = require('./microsoft-sso.cjs');
const { loadGoogle } = require('./google-slides.cjs');
const { secureStorage } = require('./secure-storage.cjs');
const { restoreMoodleSession, rememberMoodleSession } = require('./moodle-session.cjs');

app.setName('Moodle Instructor');
app.enableSandbox();
const ownsProfile = app.requestSingleInstanceLock();
if (!ownsProfile) app.quit();
protocol.registerSchemesAsPrivileged([
  { scheme: 'instructor', privileges: { standard: true, secure: true } },
]);

const workspaceUrl = 'instructor://workspace/index.html';
const assetTypes = new Map([
  ['/index.html', 'text/html'],
  ['/styles.css', 'text/css'],
  ['/renderer.js', 'text/javascript'],
  ['/composer.js', 'text/javascript'],
  ['/assignment.js', 'text/javascript'],
]);
const windowSettings = { sandbox: true, contextIsolation: true, nodeIntegration: false };
let mainWindow;
let moodleWindow;
let moodle;
let sandbox;
let lastLiveSite = '';
let signInContentsId;
let assignmentMutation = false;

function requireSandbox() {
  if (moodle.live) throw new Error('Live Moodle is read-only. Switch to Sandbox to manage assignments.');
  return sandbox;
}

function allowsLiveRequest(connection, details, url) {
  const route = connection.route(url);
  const signingIn = details.webContentsId !== undefined && details.webContentsId === signInContentsId;
  if (!url) {
    if (signingIn) return connection.signIn?.allowsRequest(details);
    if (connection.root === louisianaMoodle && isSignInRedirect(details.url)) connection.signInRequired = true;
    return false;
  }
  if (details.method === 'POST') {
    if (signingIn && connection.signIn?.acceptsCallback(details, url)) return true;
    if (route === loginPath) return signingIn && !url.search;
    const methods = url.searchParams.get('info')?.split(',');
    return route === '/lib/ajax/service.php' && !signingIn &&
      methods?.length && methods.every(method => dashboardMethods.has(method));
  }
  if (details.method !== 'GET') return false;
  if (route === '/my/courses.php') return !url.search;
  if (route === '/mod/assign/index.php') return !signingIn && /^\?id=\d+$/.test(url.search);
  if (route === loginPath) {
    return !url.search || (signingIn && /^\?(?:testsession=\d+|loginredirect=[01])$/.test(url.search));
  }
  if (!signingIn) return false;
  if (['/', '/my/', '/my/index.php'].includes(route)) return !url.search;
  return details.resourceType !== 'mainFrame' &&
    /^\/(?:pix\/|theme\/(?:styles|image|font|javascript|yui_combo)\.php$|lib\/(?:javascript|requirejs|jsrev)\.php$)/.test(route);
}

function connection(root, live, snapshotFile, storage) {
  const id = live ? createHash('sha256').update(root).digest('hex') : null;
  const browserSession = session.fromPartition(live ? `moodle-live-${id}` : 'persist:moodle-sandbox', { cache: !live });
  const target = { ...siteUrls(root), root, live, session: browserSession, snapshotFile, snapshot: null,
    abort: live ? new AbortController() : null };
  if (live && storage?.available) {
    const url = target.url('/my/courses.php');
    const name = 'moodle-session-' + id;
    target.restored = restoreMoodleSession(browserSession.cookies, url, storage, name).catch(() => {});
    target.rememberSession = () => rememberMoodleSession(browserSession.cookies, url, storage, name);
    target.forgetSession = () => storage.remove(name);
  }
  browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browserSession.setPermissionCheckHandler(() => false);
  browserSession.removeListener('will-download', preventDownload);
  browserSession.on('will-download', preventDownload);
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const url = target.localUrl(details.url);
    // The sandbox login can race with an optional media request and rotate the session cookie.
    const loginMediaRequest = signInContentsId !== undefined && details.webContentsId === signInContentsId &&
      target.route(url) === '/lib/ajax/service.php' && url.searchParams.get('info') === 'media_videojs_get_language';
    callback({ cancel: live ? !allowsLiveRequest(target, details, url) : !url || loginMediaRequest });
  });
  return target;
}

function preventDownload(event) {
  event.preventDefault();
}

function visibilityScope(target) {
  const accountId = target.snapshot?.accountId;
  return accountId ? createHash('sha256').update(JSON.stringify([target.root, accountId])).digest('hex') : null;
}

function dashboardView(target, composer) {
  const scope = visibilityScope(target);
  return { snapshot: target.snapshot, scope, hiddenCourses: scope ? composer.hiddenCourses(scope) : [],
    courseColors: scope ? composer.courseColors(scope) : {} };
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

function secureWindow(window, allowsNavigation, onBlocked) {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const eventName of ['will-navigate', 'will-redirect']) {
    window.webContents.on(eventName, (event, legacyUrl) => {
      const url = event.url ?? legacyUrl;
      if (!allowsNavigation(url)) {
        event.preventDefault();
        if (event.isMainFrame !== false) onBlocked?.(url);
      }
    });
  }
}

function openMoodle(url, { signingIn = false, prepare = false } = {}) {
  const target = moodle;
  if (!signingIn) requireSandbox();
  if (moodleWindow && !moodleWindow.isDestroyed()) moodleWindow.close();

  const window = new BrowserWindow({
    width: signingIn ? 760 : 1050,
    height: signingIn ? 700 : 780,
    title: signingIn ? (target.live ? 'Sign in to Live Moodle' : 'Connect to Moodle Sandbox') :
      prepare ? 'Review assignment in Moodle' : 'Moodle Sandbox',
    show: !prepare,
    autoHideMenuBar: true,
    parent: mainWindow,
    webPreferences: { ...windowSettings, session: target.session },
  });
  moodleWindow = window;
  const signIn = signingIn && target.root === louisianaMoodle ? microsoftSignIn() : null;
  if (signingIn) {
    signInContentsId = window.webContents.id;
    target.signIn = signIn;
  }
  const reportLoginFailure = target.live ? message => {
    if (window.isDestroyed()) return;
    window.close();
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('moodle:login-failed', message);
  } : undefined;
  secureWindow(window, value => Boolean(target.localUrl(value)) || Boolean(signIn?.allowsNavigation(value)), value => {
    const host = URL.parse(value)?.hostname;
    reportLoginFailure?.(host ? `Moodle sign-in redirected to ${host}, which this connection does not allow.` :
      'Moodle sign-in attempted an unsupported redirect.');
  });
  window.on('closed', () => {
    if (moodleWindow === window) {
      moodleWindow = null;
      signInContentsId = undefined;
      target.signIn = null;
    }
  });
  if (signingIn) {
    if (reportLoginFailure) {
      window.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) reportLoginFailure(`Moodle could not load the sign-in page (${description}).`);
      });
    }
    window.webContents.on('did-navigate', (_event, value, status) => {
      if (status >= 400 && reportLoginFailure) {
        reportLoginFailure(`The sign-in page returned HTTP ${status}. Check the Moodle site address.`);
        return;
      }
      const route = target.route(target.localUrl(value));
      if (!route?.startsWith('/my/') && !(route === '/' && signIn?.returned)) return;
      window.close();
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('moodle:connected');
    });
  }
  const loaded = window.loadURL(url).then(() => true, () => {
    // Closing the window during a redirect also aborts the navigation.
    return false;
  });
  return { window, loaded };
}

function refreshAfterAssignmentEdit(window) {
  window.webContents.on('did-navigate', (_event, value) => {
    const destination = sandbox.localUrl(value)?.pathname;
    if (['/course/view.php', '/course/section.php', '/mod/assign/view.php'].includes(destination)) {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('moodle:connected');
    }
  });
}

function requireAssignment(id) {
  const assignment = requireSandbox().snapshot?.assignments.find(item => item.id === id);
  if (!assignment) throw new Error('This assignment is no longer in your Moodle snapshot. Refresh and try again.');
  return assignment;
}

function publicAssignmentSettings({ title, visibility, action }) {
  return { title, visibility, action };
}

async function sectionsFor(courseId) {
  const target = requireSandbox();
  if (!Number.isSafeInteger(courseId) || !target.snapshot?.courses.some(course => course.id === courseId)) {
    throw new Error('Choose a course from the Moodle dashboard.');
  }
  return courseSections(target, courseId);
}

async function reviewAssignment(value) {
  const draft = draftFrom(value);
  if (!draft.title.trim() || !draft.instructions.trim()) {
    throw new Error('Enter a title and instructions before opening Moodle.');
  }
  if (draft.cutoffEnabled && (!draft.cutoff || (draft.due && draft.cutoff < draft.due))) {
    throw new Error('Set a cutoff at or after the due date, or turn it off.');
  }
  const sections = await sectionsFor(draft.courseId);
  if (!sections.some(section => section.number === draft.section)) {
    throw new Error('Choose an available Moodle course section.');
  }

  const params = new URLSearchParams({ add: 'assign', course: draft.courseId, section: draft.section });
  const { window, loaded } = openMoodle(`${origin}/course/modedit.php?${params}`, { prepare: true });
  try {
    if (!(await loaded) || window.isDestroyed()) throw new Error('The Moodle assignment form could not load.');
    const page = sandbox.localUrl(window.webContents.getURL());
    if (page?.pathname === loginPath) throw new SignInRequired();
    if (page?.pathname !== '/course/modedit.php' || page.searchParams.get('add') !== 'assign') {
      throw new Error('Moodle did not open a new assignment form for this course.');
    }
    const result = await window.webContents.executeJavaScript(`(${fillAssignment.toString()})(${JSON.stringify(draft)})`);
    if (!result?.ok) throw new Error(result?.error || 'The Moodle form could not be filled.');
    refreshAfterAssignmentEdit(window);
    window.show();
  } catch (error) {
    if (!window.isDestroyed()) window.close();
    throw error;
  }
}

async function refresh(target, composer) {
  try {
    await target.restored;
    const updated = await dashboard(target);
    if (!target.abort?.signal.aborted) await target.rememberSession?.().catch(() => {});
    if (target.snapshotFile) {
      const temporaryFile = `${target.snapshotFile}.tmp`;
      await writeFile(temporaryFile, JSON.stringify(updated), { mode: 0o600 });
      await rename(temporaryFile, target.snapshotFile);
    }
    target.snapshot = updated;
    return { status: 'connected', ...dashboardView(target, composer) };
  } catch (error) {
    if (error instanceof SignInRequired) {
      if (!target.abort?.signal.aborted) await target.forgetSession?.().catch(() => {});
      return { status: 'login' };
    }
    return { status: 'error', message: error.message };
  }
}

function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame?.url !== workspaceUrl) {
      throw new Error('Unrecognized workspace request.');
    }
    return handler(...args);
  });
}

function handleComposer(channel, handler) {
  handle(channel, async (...args) => {
    try {
      return { ok: true, value: await handler(...args) };
    } catch (error) {
      const login = error instanceof SignInRequired;
      return { ok: false, login, message: login ? 'Reconnect to Moodle to continue. Your draft is still here.' : error.message };
    }
  });
}

function workspaceBackground(theme) {
  return theme === 'dark' ? '#1a1b19' : '#f3f4f3';
}

function createWindow(workspaceSession, theme) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    title: 'MoodleBOSS',
    minWidth: 640,
    minHeight: 500,
    show: false,
    backgroundColor: workspaceBackground(theme),
    autoHideMenuBar: true,
    webPreferences: { ...windowSettings, session: workspaceSession, preload: path.join(__dirname, 'preload.cjs') },
  });
  secureWindow(mainWindow, url => url === workspaceUrl);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(workspaceUrl);
}

app.whenReady().then(async () => {
  if (!ownsProfile) return;
  const dataDirectory = app.getPath('userData');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const storage = await secureStorage(dataDirectory, safeStorage);
  const composer = await loadComposer(dataDirectory, storage);
  const google = await loadGoogle(dataDirectory, url => shell.openExternal(url), storage);
  app.on('will-quit', google.close);
  const presentations = new Map();
  const progress = message => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('presentation:progress', message);
  };
  // Keep the workspace files together for this launch, including after Reload.
  // The temporary workspace session avoids reusing assets cached by an earlier build.
  const workspaceSession = session.fromPartition('instructor-workspace', { cache: false });
  const assets = new Map(await Promise.all([...assetTypes].map(async ([name, type]) => [
    name, { type, data: await readFile(path.join(__dirname, name.slice(1))) },
  ])));
  workspaceSession.protocol.handle('instructor', request => {
    const url = new URL(request.url);
    const asset = assets.get(url.pathname);
    if (url.hostname !== 'workspace' || !asset) {
      return new Response(null, { status: 404 });
    }
    const data = url.pathname === '/index.html' && composer.get().theme === 'dark'
      ? asset.data.toString('utf8').replace('data-theme="light"', 'data-theme="dark"')
      : asset.data;
    return new Response(data, {
      headers: { 'Content-Type': `${asset.type}; charset=utf-8`, 'Cache-Control': 'no-store' },
    });
  });
  sandbox = connection(origin, false, path.join(dataDirectory, 'dashboard.json'));
  moodle = sandbox;
  const savedEnvironment = composer.moodleEnvironment();
  try {
    if (savedEnvironment.site) {
      lastLiveSite = liveSite(savedEnvironment.site);
      if (savedEnvironment.live === true) moodle = connection(lastLiveSite, true, undefined, storage);
    }
  } catch {
    // A previously configured site may no longer be valid.
  }
  try {
    const cached = JSON.parse(await readFile(sandbox.snapshotFile, 'utf8'));
    if (cached?.courseScope === courseScope) sandbox.snapshot = cached;
  } catch {
    // A fresh profile has no sandbox snapshot.
  }

  const environment = () => ({
    ...dashboardView(moodle, composer), live: moodle.live, site: lastLiveSite, microsoft: moodle.root === louisianaMoodle,
    appVersion: app.getVersion(), repositoryUrl: repository.url,
  });
  handle('moodle:environment', environment);
  handle('workspace:open-repository', () => shell.openExternal(repository.url));
  handleComposer('workspace:course-visibility', (scope, id, visible) => {
    if (!scope || scope !== visibilityScope(moodle) || !Number.isSafeInteger(id) ||
        typeof visible !== 'boolean' || !moodle.snapshot.courses.some(course => course.id === id)) {
      throw new Error('Refresh Moodle to update course visibility.');
    }
    return composer.saveCourseVisibility(scope, id, visible);
  });
  handleComposer('workspace:course-color', (scope, id, color) => {
    if (!scope || scope !== visibilityScope(moodle) || !Number.isSafeInteger(id) ||
        !moodle.snapshot.courses.some(course => course.id === id) ||
        (color !== null && (!Number.isInteger(color) || color < 0 || color >= 16))) {
      throw new Error('Select a valid color for a current course.');
    }
    return composer.saveCourseColor(scope, id, color);
  });
  handleComposer('moodle:configure', async (live, site) => {
    const root = live === true ? liveSite(site) : origin;
    if (moodle.root === root && moodle.live === live) return environment();
    if (moodleWindow || assignmentMutation) throw new Error('Close the Moodle window and wait for pending changes before switching.');
    await composer.saveMoodleEnvironment({ live: live === true, site: live === true ? root : lastLiveSite });
    moodle.abort?.abort();
    if (live === true) {
      moodle = connection(root, true, undefined, storage);
      lastLiveSite = root;
    } else {
      moodle = sandbox;
    }
    return environment();
  });
  handle('moodle:connect', async () => {
    const target = moodle;
    await target.restored;
    if (target === moodle) openMoodle(target.url(loginPath), { signingIn: true });
  });
  handleComposer('moodle:forget-session', async () => {
    const target = moodle;
    if (!target.live || moodleWindow) throw new Error('Close the Moodle window before forgetting this sign-in.');
    target.abort.abort();
    await target.restored;
    await target.refresh;
    try {
      await target.forgetSession?.();
      await target.session.clearStorageData({ storages: ['cookies'] });
    } finally {
      if (target === moodle) moodle = connection(target.root, true, undefined, storage);
    }
    return environment();
  });
  handle('moodle:refresh', () => {
    const target = moodle;
    target.refresh ??= refresh(target, composer).finally(() => { target.refresh = null; });
    return target.refresh;
  });
  handle('moodle:open', async (kind, id) => {
    const { snapshot, localUrl } = requireSandbox();
    if (!Number.isSafeInteger(id) || id < 1) return;
    const course = snapshot?.courses.find(course => course.id === id);
    const assignment = snapshot?.assignments.find(assignment => assignment.id === id);
    const event = snapshot?.upcoming.find(event => event.id === id);
    if (kind === 'course' && course) openMoodle(`${origin}/course/view.php?id=${id}`);
    if (kind === 'announcements' && course) {
      const url = await announcementsUrl(sandbox, id).catch(() => `${origin}/mod/forum/index.php?id=${id}`);
      openMoodle(url);
    }
    if (kind === 'assignment' && assignment) openMoodle(`${origin}/mod/assign/view.php?id=${id}`);
    if (kind === 'grading' && assignment?.canGrade) openMoodle(`${origin}/mod/assign/view.php?id=${id}&action=grading`);
    if (kind === 'event' && localUrl(event?.path)?.pathname === '/calendar/view.php') {
      openMoodle(new URL(event.path, origin).href);
    }
  });
  handleComposer('composer:load', composer.get);
  handleComposer('workspace:theme', async theme => {
    await composer.saveTheme(theme);
    if (!mainWindow.isDestroyed()) mainWindow.setBackgroundColor(workspaceBackground(theme));
  });
  handleComposer('composer:save', composer.saveDraft);
  handleComposer('composer:open-draft', composer.openDraft);
  handleComposer('composer:delete-draft', composer.deleteDraft);
  handleComposer('composer:settings', composer.saveSettings);
  handleComposer('composer:models', composer.models);
  handleComposer('composer:generate', composer.generate);
  handleComposer('composer:chat', composer.chat);
  handleComposer('presentation:prepare', async history => {
    const plan = await composer.presentation(history, progress);
    if (presentations.size >= 12) presentations.delete(presentations.keys().next().value);
    presentations.set(plan.id, plan);
    return plan;
  });
  handleComposer('presentation:create', async (id, includeImages) => {
    const plan = presentations.get(id);
    if (!plan || typeof includeImages !== 'boolean') throw new Error('Research a presentation in Chat first.');
    const deck = await google.create(plan, includeImages, progress);
    plan.deck = deck;
    return deck;
  });
  handleComposer('presentation:open', (id, kind, sourceId) => {
    const plan = presentations.get(id);
    if (!plan) throw new Error('This presentation plan is no longer available in this app session.');
    const url = kind === 'deck' ? plan.deck?.url : kind === 'image' ?
      plan.images.find(image => image.id === sourceId)?.pageUrl :
      plan.sources.find(source => source.id === sourceId)?.url;
    if (!url) throw new Error('This presentation link is unavailable.');
    return shell.openExternal(url);
  });
  handleComposer('google:status', google.status);
  handleComposer('google:import', async () => {
    const selected = await dialog.showOpenDialog(mainWindow, { title: 'Import Google Desktop app credentials',
      properties: ['openFile'], filters: [{ name: 'Google OAuth credentials', extensions: ['json'] }] });
    if (selected.canceled) return google.status();
    const value = await readFile(selected.filePaths[0], 'utf8');
    if (value.length > 20000) throw new Error('Choose a Google OAuth Desktop credentials JSON file.');
    try { return await google.importClient(JSON.parse(value)); } catch (error) {
      if (error instanceof SyntaxError) throw new Error('The credentials file does not contain valid JSON.');
      throw error;
    }
  });
  handleComposer('google:connect', google.connect);
  handleComposer('google:cancel', google.close);
  handleComposer('google:disconnect', google.disconnect);
  handle('google:setup', () => shell.openExternal(repository.url + '#connect-google-slides'));
  handleComposer('composer:sections', sectionsFor);
  handleComposer('composer:review', reviewAssignment);
  handleComposer('moodle:assignment-settings', async id =>
    publicAssignmentSettings(await assignmentSettings(sandbox, requireAssignment(id))));
  handleComposer('moodle:edit-assignment', async id => {
    await assignmentSettings(sandbox, requireAssignment(id));
    const { window } = openMoodle(`${origin}/course/modedit.php?update=${id}&return=1`);
    refreshAfterAssignmentEdit(window);
  });
  handleComposer('moodle:change-assignment', async (id, action, expectedTitle) => {
    const assignment = requireAssignment(id);
    if (assignmentMutation) throw new Error('Wait for the current Moodle change to finish.');
    assignmentMutation = true;
    try {
      if (action === 'delete') {
        await deleteAssignment(sandbox, assignment, expectedTitle);
        return null;
      }
      if (action === 'hide' || action === 'show') {
        return publicAssignmentSettings(await setAssignmentVisibility(sandbox, assignment, action, expectedTitle));
      }
      throw new Error('Unknown assignment action.');
    } finally {
      assignmentMutation = false;
    }
  });

  createWindow(workspaceSession, composer.get().theme);
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow(workspaceSession, composer.get().theme);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
