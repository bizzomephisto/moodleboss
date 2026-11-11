const { app, BrowserWindow, ipcMain, session, protocol, shell, dialog, safeStorage } = require('electron');
const { createHash, randomUUID } = require('node:crypto');
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
const { cleanSlide } = require('./presentation.cjs');
const { findImages } = require('./research.cjs');
const { slidePreviews } = require('./slides-layout.cjs');
const { buildSection } = require('./section-builder.cjs');
const { secureStorage } = require('./secure-storage.cjs');
const { restoreMoodleSession, rememberMoodleSession } = require('./moodle-session.cjs');

app.setName('Moodle Instructor');
if (process.platform === 'linux') app.setDesktopName('moodleboss.desktop');
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
  ['/presentation-review.js', 'text/javascript'],
  ['/assignment.js', 'text/javascript'],
  ['/section-builder.js', 'text/javascript'],
]);
const windowSettings = { sandbox: true, contextIsolation: true, nodeIntegration: false };
const windowIcon = process.platform === 'darwin' ? undefined :
  path.join(__dirname, '../assets/desktop/moodleboss.png');
const gradingWindows = new WeakMap();
const openableSubmission = /\.(?:pdf|png|jpe?g|gif|webp|avif|bmp|tiff?|txt|docx?|pptx?|xlsx?|odt|odp|ods)$/i;
let mainWindow;
let moodleWindow;
let moodle;
let sandbox;
let lastLiveSite = '';
let signInContentsId;
let moodleMutation = false;

function requireEditing(target = moodle) {
  if (target !== moodle) throw new Error('The Moodle environment changed. Try again.');
  if (target.readOnly) throw new Error('Live Moodle is read-only. Click the sidebar lock to enable editing.');
  return target;
}

function allowsLiveRequest(connection, details, url) {
  const route = connection.route(url);
  const signingIn = details.webContentsId !== undefined && details.webContentsId === signInContentsId;
  if (!url) {
    if (signingIn) return connection.signIn?.allowsRequest(details);
    if (connection.root === louisianaMoodle && isSignInRedirect(details.url)) connection.signInRequired = true;
    return false;
  }
  if (!connection.readOnly && !signingIn) return true;
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
  const target = { ...siteUrls(root), root, live, readOnly: live, session: browserSession, snapshotFile, snapshot: null,
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
  browserSession.removeListener('will-download', handleMoodleDownload);
  browserSession.on('will-download', handleMoodleDownload);
  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const url = target.localUrl(details.url);
    // The sandbox login can race with an optional media request and rotate the session cookie.
    const loginMediaRequest = signInContentsId !== undefined && details.webContentsId === signInContentsId &&
      target.route(url) === '/lib/ajax/service.php' && url.searchParams.get('info') === 'media_videojs_get_language';
    callback({ cancel: live ? !allowsLiveRequest(target, details, url) : !url || loginMediaRequest });
  });
  return target;
}

function isSubmissionFile(target, value) {
  const url = target.localUrl(value);
  const route = target.route(url);
  if (!route) return false;
  const file = route.startsWith('/pluginfile.php/') ? route.slice('/pluginfile.php'.length) :
    route === '/pluginfile.php' ? url.searchParams.get('file') : null;
  return /^\/\d+\/assignsubmission_file\/submission_files\/\d+\//.test(file ?? '');
}

function handleMoodleDownload(event, item, contents) {
  const target = gradingWindows.get(contents);
  const urls = item.getURLChain();
  if (!target || target !== moodle || target.readOnly || !urls.length || !urls.every(url => target.localUrl(url))) {
    event.preventDefault();
    return;
  }
  if (isSubmissionFile(target, urls[0]) && openableSubmission.test(item.getFilename())) {
    item.once('done', (_event, state) => {
      if (state === 'completed') void offerOpenSubmission(item.getSavePath(), contents).catch(console.error);
    });
  }
}

async function offerOpenSubmission(file, contents) {
  if (!file || !openableSubmission.test(file) || contents.isDestroyed()) return;
  const window = BrowserWindow.fromWebContents(contents);
  if (!window) return;
  const { response } = await dialog.showMessageBox(window, {
    type: 'info',
    message: 'Submission downloaded',
    detail: path.basename(file),
    buttons: ['Done', 'Open file'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) {
    const error = await shell.openPath(file);
    if (error && !window.isDestroyed()) await dialog.showMessageBox(window, {
      type: 'error',
      message: 'Could not open the downloaded file',
      detail: error,
    });
  }
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

function openMoodle(url, { signingIn = false, prepare = false, grading = false } = {}) {
  const target = moodle;
  if (moodleMutation) throw new Error('Wait for the current Moodle change to finish.');
  if (!signingIn) requireEditing(target);
  if (moodleWindow && !moodleWindow.isDestroyed()) moodleWindow.close();

  const window = new BrowserWindow({
    icon: windowIcon,
    width: signingIn ? 760 : 1050,
    height: signingIn ? 700 : 780,
    title: signingIn ? (target.live ? 'Sign in to Live Moodle' : 'Connect to Moodle Sandbox') :
      prepare ? (target.live ? 'Review assignment in Live Moodle' : 'Review assignment in Moodle') :
        (target.live ? 'Live Moodle' : 'Moodle Sandbox'),
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
  if (grading) {
    const contents = window.webContents;
    gradingWindows.set(contents, target);
    contents.setWindowOpenHandler(({ url: link }) => {
      if (target === moodle && !target.readOnly && isSubmissionFile(target, link)) {
        contents.downloadURL(link);
      }
      return { action: 'deny' };
    });
  }
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

function refreshAfterAssignmentEdit(window, target) {
  window.webContents.on('did-navigate', (_event, value) => {
    const destination = target.route(target.localUrl(value));
    if (['/course/view.php', '/course/section.php', '/mod/assign/view.php'].includes(destination)) {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('moodle:connected');
    }
  });
}

function requireAssignment(target, id) {
  const assignment = target.snapshot?.assignments.find(item => item.id === id);
  if (!assignment) throw new Error('This assignment is no longer in your Moodle snapshot. Refresh and try again.');
  return assignment;
}

function publicAssignmentSettings({ title, visibility, action }) {
  return { title, visibility, action };
}

async function sectionsFor(courseId, target = requireEditing()) {
  if (!Number.isSafeInteger(courseId) || !target.snapshot?.courses.some(course => course.id === courseId)) {
    throw new Error('Choose a course from the Moodle dashboard.');
  }
  return courseSections(target, courseId);
}

async function reviewAssignment(value) {
  const target = requireEditing();
  const draft = draftFrom(value);
  if (!draft.title.trim() || !draft.instructions.trim()) {
    throw new Error('Enter a title and instructions before opening Moodle.');
  }
  if (draft.cutoffEnabled && (!draft.cutoff || (draft.due && draft.cutoff < draft.due))) {
    throw new Error('Set a cutoff at or after the due date, or turn it off.');
  }
  const sections = await sectionsFor(draft.courseId, target);
  if (!sections.some(section => section.number === draft.section)) {
    throw new Error('Choose an available Moodle course section.');
  }

  const params = new URLSearchParams({ add: 'assign', course: draft.courseId, section: draft.section });
  requireEditing(target);
  const { window, loaded } = openMoodle(target.url(`/course/modedit.php?${params}`), { prepare: true });
  try {
    if (!(await loaded) || window.isDestroyed()) throw new Error('The Moodle assignment form could not load.');
    const page = target.localUrl(window.webContents.getURL());
    const route = target.route(page);
    if (route === loginPath) throw new SignInRequired();
    if (route !== '/course/modedit.php' || page.searchParams.get('add') !== 'assign') {
      throw new Error('Moodle did not open a new assignment form for this course.');
    }
    const result = await window.webContents.executeJavaScript(`(${fillAssignment.toString()})(${JSON.stringify(draft)})`);
    if (!result?.ok) throw new Error(result?.error || 'The Moodle form could not be filled.');
    refreshAfterAssignmentEdit(window, target);
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
    icon: windowIcon,
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
  const createdSections = new WeakMap();
  const proposals = new WeakMap();
  const exporting = new WeakSet();
  const exportStarted = new WeakSet();
  function presentationPlan(id) {
    const plan = presentations.get(id);
    if (!plan) throw new Error('This presentation plan is no longer available in this app session.');
    return plan;
  }
  function editablePresentation(id, revision) {
    const plan = presentationPlan(id);
    if (plan.revision !== revision || plan.deck || exporting.has(plan)) throw new Error('Reopen the review to continue editing.');
    return plan;
  }
  function reviewView(plan, includeImages) {
    return { plan, previews: slidePreviews(plan, includeImages) };
  }
  function addPresentationImages(plan, images) {
    const found = images.map(image => plan.images.find(existing => existing.url === image.url) ??
      { ...image, id: 'image_' + randomUUID() });
    const used = new Set(plan.slides.flatMap(slide => slide.imageIds));
    const available = new Map([...found, ...plan.images].map(image => [image.id, image]));
    plan.images = [...available.values()].filter(image => used.has(image.id) || found.some(item => item.id === image.id))
      .concat([...available.values()].filter(image => !used.has(image.id) && !found.some(item => item.id === image.id)).slice(0, 12));
    return found;
  }
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
    ...dashboardView(moodle, composer), live: moodle.live, readOnly: moodle.readOnly, site: lastLiveSite, microsoft: moodle.root === louisianaMoodle,
    appVersion: app.getVersion(), repositoryUrl: repository.url,
  });
  handle('moodle:environment', environment);
  handleComposer('moodle:read-only', readOnly => {
    if (!moodle.live || typeof readOnly !== 'boolean') throw new Error('Open Live Moodle to change its read-only setting.');
    if (moodleWindow || moodleMutation) throw new Error('Close the Moodle window and wait for pending changes first.');
    moodle.readOnly = readOnly;
    return environment();
  });
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
    if (moodleWindow || moodleMutation) throw new Error('Close the Moodle window and wait for pending changes before switching.');
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
    if (!target.live || moodleWindow || moodleMutation) throw new Error('Close the Moodle window and wait for pending changes before forgetting this sign-in.');
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
    const target = requireEditing();
    const { snapshot, url, localUrl, route } = target;
    if (!Number.isSafeInteger(id) || id < 1) return;
    const course = snapshot?.courses.find(course => course.id === id);
    const assignment = snapshot?.assignments.find(assignment => assignment.id === id);
    const event = snapshot?.upcoming.find(event => event.id === id);
    if (kind === 'course' && course) openMoodle(url(`/course/view.php?id=${id}`));
    if (kind === 'announcements' && course) {
      const link = await announcementsUrl(target, id).catch(() => url(`/mod/forum/index.php?id=${id}`));
      requireEditing(target);
      openMoodle(link);
    }
    if (kind === 'assignment' && assignment) openMoodle(url(`/mod/assign/view.php?id=${id}`));
    if (kind === 'grading' && assignment?.canGrade) openMoodle(url(`/mod/assign/view.php?id=${id}&action=grading`), { grading: true });
    if (kind === 'event' && event?.path && route(localUrl(url(event.path))) === '/calendar/view.php') {
      openMoodle(url(event.path));
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
  handleComposer('composer:chat', (history, requestId) => {
    if (typeof requestId !== 'string' || requestId.length !== 36) throw new Error('Invalid chat request.');
    const contents = mainWindow.webContents;
    return composer.chat(history, text => {
      if (!contents.isDestroyed()) contents.send('composer:chat-text', requestId, text);
    });
  });
  handleComposer('presentation:prepare', async history => {
    const plan = await composer.presentation(history, progress);
    plan.revision = 0;
    if (presentations.size >= 12) presentations.delete(presentations.keys().next().value);
    presentations.set(plan.id, plan);
    return plan;
  });
  handleComposer('presentation:review', (id, includeImages) => reviewView(presentationPlan(id), includeImages === true));
  handleComposer('presentation:find-images', async (id, revision, index, query) => {
    const plan = editablePresentation(id, revision);
    if (!Number.isInteger(index) || !plan.slides[index]) throw new Error('Select a slide first.');
    const text = typeof query === 'string' ? query.trim().slice(0, 160) : '';
    if (!text) throw new Error('Describe the image to find.');
    const { images } = await findImages([text]);
    editablePresentation(id, revision);
    return addPresentationImages(plan, images);
  });
  handleComposer('presentation:revise', async (id, revision, index, instruction, includeImages) => {
    const plan = editablePresentation(id, revision);
    if (index !== null && (!Number.isInteger(index) || !plan.slides[index])) throw new Error('Select a slide first.');
    const result = await composer.revisePresentation(plan, index, instruction);
    const images = result.imageQueries?.length ? (await findImages(result.imageQueries)).images : [];
    editablePresentation(id, revision);
    let candidate = result;
    if (index !== null) {
      const copy = { ...plan, images: [...plan.images], slides: [...plan.slides] };
      copy.slides[index] = result.slide;
      const choices = addPresentationImages(copy, images);
      if (choices.length) {
        const selected = new Set(result.slide.imageIds);
        if (result.slide.layout !== 'statement') {
          const first = choices.find(image => !selected.has(image.id)) ?? choices[0];
          result.slide.imageIds = [first.id, ...result.slide.imageIds.filter(image => image !== first.id)].slice(0, 4);
        }
      }
      candidate = copy;
    }
    const token = randomUUID();
    proposals.set(plan, { token, revision, candidate });
    return { token, ...reviewView(candidate, includeImages === true) };
  });
  handleComposer('presentation:update', (id, revision, operation, includeImages) => {
    const plan = editablePresentation(id, revision);
    let updated = { ...plan, slides: [...plan.slides] };
    if (operation?.type === 'accept') {
      const proposal = proposals.get(plan);
      if (!proposal || proposal.token !== operation.token || proposal.revision !== revision) throw new Error('Generate a new revision first.');
      updated = proposal.candidate;
    } else if (operation?.type === 'move') {
      const { from, to } = operation;
      if (![from, to].every(index => Number.isInteger(index) && plan.slides[index])) throw new Error('Select a valid slide position.');
      updated.slides.splice(to, 0, ...updated.slides.splice(from, 1));
    } else if (operation?.type === 'edit') {
      const { index, slide } = operation;
      if (!Number.isInteger(index) || !plan.slides[index]) throw new Error('Select a slide first.');
      updated.slides[index] = cleanSlide({ ...slide, sourceIds: plan.slides[index].sourceIds }, plan);
      if (!updated.slides[index].title) throw new Error('Enter a slide title.');
      if (operation.dimensions) {
        const { id: imageId, width, height } = operation.dimensions;
        if (updated.slides[index].imageIds.includes(imageId) &&
            [width, height].every(value => Number.isSafeInteger(value) && value > 0) && width * height <= 25_000_000) {
          updated.images = plan.images.map(image => image.id === imageId ? { ...image, width, height } : image);
        }
      }
    } else throw new Error('Choose a valid slide change.');
    // An edited draft must never reuse a Drive file from an earlier export attempt.
    const nextId = exportStarted.has(plan) ? randomUUID() : id;
    updated = { ...updated, id: nextId, revision: revision + 1 };
    presentations.delete(id);
    presentations.set(nextId, updated);
    return reviewView(updated, includeImages === true);
  });
  handleComposer('presentation:create', async (id, includeImages) => {
    const plan = presentationPlan(id);
    if (typeof includeImages !== 'boolean' || exporting.has(plan)) throw new Error('Wait for the current export to finish.');
    if (plan.deck) return plan.deck;
    exporting.add(plan);
    exportStarted.add(plan);
    try {
      plan.deck = await google.create(plan, includeImages, progress);
      return plan.deck;
    } finally {
      exporting.delete(plan);
    }
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
  handleComposer('section:list-decks', google.listDecks);
  handleComposer('section:build', async value => {
    const target = requireEditing();
    const { courseId } = value ?? {};
    if (!Number.isSafeInteger(courseId) || !target.snapshot?.courses.some(course => course.id === courseId)) {
      throw new Error('Choose a course from the Moodle dashboard.');
    }
    const title = typeof value.title === 'string' ? value.title.trim() : '';
    const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
    if (!title || title.length > 200) throw new Error('Enter a section title up to 200 characters.');
    if (summary.length > 5000) throw new Error('Keep the section description to 5,000 characters or fewer.');
    const urls = Array.isArray(value.urls) ? [...new Set(value.urls)] : [];
    if (urls.length > 6 || urls.some(url => typeof url !== 'string' || url.length > 600)) {
      throw new Error('Add up to six Google Slides links.');
    }
    if (moodleWindow || moodleMutation) throw new Error('Close the Moodle window and wait for pending changes before creating a section.');
    moodleMutation = true;
    const report = message => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('section:progress', message);
    };
    try {
      const files = [];
      for (const url of urls) {
        report(`Exporting Google Slides deck ${files.length + 1} of ${urls.length} to PDF…`);
        files.push(await google.exportDeckPdf(url));
      }
      requireEditing(target);
      const result = await buildSection(target, courseId, { title, summary, files }, report);
      if (!createdSections.has(target)) createdSections.set(target, new Map());
      createdSections.get(target).set(result.sectionId, target.snapshot.accountId);
      return result;
    } finally {
      moodleMutation = false;
    }
  });
  handleComposer('section:open', id => {
    const target = requireEditing();
    if (!target.snapshot?.accountId || createdSections.get(target)?.get(id) !== target.snapshot.accountId) {
      throw new Error('Open the course in Moodle to view this section.');
    }
    openMoodle(target.url('/course/section.php?id=' + id));
  });
  handleComposer('composer:review', reviewAssignment);
  handleComposer('moodle:assignment-settings', async id => {
    const target = requireEditing();
    return publicAssignmentSettings(await assignmentSettings(target, requireAssignment(target, id)));
  });
  handleComposer('moodle:edit-assignment', async id => {
    const target = requireEditing();
    await assignmentSettings(target, requireAssignment(target, id));
    requireEditing(target);
    const { window } = openMoodle(target.url(`/course/modedit.php?update=${id}&return=1`));
    refreshAfterAssignmentEdit(window, target);
  });
  handleComposer('moodle:change-assignment', async (id, action, expectedTitle) => {
    const target = requireEditing();
    const assignment = requireAssignment(target, id);
    if (moodleMutation) throw new Error('Wait for the current Moodle change to finish.');
    moodleMutation = true;
    try {
      if (action === 'delete') {
        await deleteAssignment(target, assignment, expectedTitle);
        return null;
      }
      if (action === 'hide' || action === 'show') {
        return publicAssignmentSettings(await setAssignmentVisibility(target, assignment, action, expectedTitle));
      }
      throw new Error('Unknown assignment action.');
    } finally {
      moodleMutation = false;
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
