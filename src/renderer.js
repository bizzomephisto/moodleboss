const el = id => document.getElementById(id);
const syncFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'short' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const numberFormat = new Intl.NumberFormat();
let snapshot = null;
let fullSnapshot = null;
let visibilityScope = null;
let hiddenCourseIds = new Set();
let savingCourseVisibility = false;
let courseId = null;
let dashboardRefresh;
let environment = { live: false };
let view = 'overview';
const expandedCourses = new Set();
const expandedAssignments = new Set();
let expandedInitialCourse = false;
const compactNavigation = matchMedia('(max-width: 820px)');
const navigation = {
  overview: { button: 'overview', heading: 'title', name: 'Overview' },
  builder: { button: 'new-assignment', heading: 'builder-title', name: 'Assignment builder' },
  chat: { button: 'chat-tab', heading: 'chat-title', name: 'AI chat' },
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, className, action) {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', action);
  return element;
}

function setStatus(state, message) {
  el('connection').dataset.state = state;
  const status = state === 'connected' ? 'Moodle connected' : state === 'loading' ? 'Checking Moodle…' :
    snapshot ? 'Showing saved data' : state === 'login' ? 'Sign in required' : 'Moodle unavailable';
  el('status-text').textContent = environment.live ? `Live · ${state === 'connected' ? 'Read-only' : status}` : status;
  el('connection').title = message;
  el('connection').setAttribute('aria-label', message);
  el('connect').hidden = state === 'connected' || state === 'loading';
  el('connect').textContent = snapshot ? 'Reconnect' : 'Connect to Moodle';
  if (environment.live) {
    el('moodle-connect-hint').textContent = state === 'error' ? message : environment.microsoft ?
      'Sign in with your university Microsoft account to test the read-only dashboard.' :
      `Sign in to ${new URL(environment.site).host} to test the read-only dashboard.`;
  }
}

function cachedAt() {
  return snapshot ? ` Showing the snapshot from ${syncFormat.format(new Date(snapshot.checkedAt))}.` : '';
}

function total(assignments, key) {
  const values = assignments.map(assignment => assignment[key]).filter(Number.isFinite);
  return values.length ? numberFormat.format(values.reduce((sum, value) => sum + value, 0)) : '—';
}

function setView(next) {
  view = next;
  el('composer').hidden = next !== 'builder';
  el('chat-view').hidden = next !== 'chat';
  el('overview-view').hidden = next !== 'overview';
  for (const [key, item] of Object.entries(navigation)) {
    if (key === next) el(item.button).setAttribute('aria-current', 'page');
    else el(item.button).removeAttribute('aria-current');
  }
  el('current-view').textContent = navigation[next].name;
}

function setNavigation(open) {
  const expanded = open && compactNavigation.matches;
  document.body.dataset.navOpen = String(expanded);
  el('workspace-sidebar').inert = compactNavigation.matches && !expanded;
  document.querySelector('main').inert = expanded;
  el('nav-scrim').hidden = !expanded;
  el('toggle-navigation').setAttribute('aria-expanded', String(expanded));
}

function closeNavigation(returnFocus = false) {
  if (document.body.dataset.navOpen !== 'true') return;
  setNavigation(false);
  if (returnFocus) el('toggle-navigation').focus();
}

function navigate(next) {
  closeNavigation();
  setView(next);
  el(navigation[next].heading).focus();
}

function selectCourse(id) {
  courseId = id;
  closeNavigation();
  setView('overview');
  render();
  el('title').focus();
}

function renderCourseTree(courses) {
  const focusedKey = document.activeElement?.dataset.courseControl;
  if (!expandedInitialCourse && courses.length) {
    expandedCourses.add(courses[0].id);
    expandedInitialCourse = true;
  }
  el('course-buttons').replaceChildren(...courses.map(course => {
    const branch = node('details', 'course-tree');
    branch.open = expandedCourses.has(course.id);
    branch.addEventListener('toggle', () => {
      if (branch.open) expandedCourses.add(course.id);
      else expandedCourses.delete(course.id);
    });
    const header = node('summary', 'course-name', course.title);
    header.dataset.courseControl = `course-${course.id}`;
    const items = node('div', 'course-items');
    const addControl = (key, control, group = items) => {
      control.dataset.courseControl = `course-${course.id}-${key}`;
      group.append(control);
    };
    addControl('dashboard', button('Course dashboard', 'tree-link', () => selectCourse(course.id)));
    const assignments = snapshot.assignments.filter(item => item.courseId === course.id);
    const assignmentGroup = node('details', 'assignment-tree');
    const assignmentSummary = node('summary', 'tree-label', 'Assignments');
    assignmentSummary.dataset.courseControl = `course-${course.id}-assignments`;
    assignmentGroup.open = expandedAssignments.has(course.id);
    assignmentGroup.addEventListener('toggle', () => {
      if (assignmentGroup.open) expandedAssignments.add(course.id);
      else expandedAssignments.delete(course.id);
    });
    assignmentSummary.append(node('span', 'draft-count', numberFormat.format(assignments.length)));
    assignmentGroup.append(assignmentSummary);
    items.append(assignmentGroup);
    if (!environment.live) addControl('new-assignment', button('New assignment', 'tree-link tree-new', () => {
      setView('builder');
      window.dispatchEvent(new CustomEvent('workspace:new-draft', { detail: course.id }));
    }), assignmentGroup);
    for (const assignment of assignments) {
      const link = environment.live ? node('div', 'tree-link', assignment.title) :
        button(assignment.title, 'tree-link', () => window.workspace.open('assignment', assignment.id));
      if (assignment.submitted !== null && assignment.needsGrading !== null) {
        link.append(node('small', 'tree-count', `${assignment.submitted} submitted · ${assignment.needsGrading} to grade`));
      }
      addControl(`assignment-${assignment.id}`, link, assignmentGroup);
    }
    if (!environment.live) {
      items.append(node('p', 'tree-label', 'Announcements'));
      addControl('announcements', button('Open in Moodle', 'tree-link', () => window.workspace.open('announcements', course.id)));
    }
    branch.append(header, items);
    return branch;
  }));
  if (!courses.length) el('course-buttons').append(node('p', 'tree-empty',
    fullSnapshot?.courses.length ? 'All current courses are hidden. Show them in Settings → Course visibility.' :
      snapshot ? 'Moodle lists no courses in progress.' : 'Your current Moodle courses appear here.'));
  if (focusedKey) el('course-buttons').querySelector(`[data-course-control="${CSS.escape(focusedKey)}"]`)?.focus();
}

function render() {
  const courses = snapshot?.courses ?? [];
  const course = courses.find(item => item.id === courseId);
  if (!course) courseId = null;
  renderCourseTree(courses);
  setView(view);
  el('title').textContent = course?.title ?? 'Teaching overview';
  el('subtitle').textContent = course ? 'Assignments and upcoming activities in this course.' :
    'Assignments, submissions, and upcoming activities for your current courses.';
  el('open-course').hidden = environment.live || !course;
  el('empty').hidden = Boolean(snapshot);
  el('dashboard').hidden = !snapshot;
  if (!snapshot) return;

  const courseNames = new Map(courses.map(item => [item.id, item.title]));
  const assignments = snapshot.assignments.filter(item => !course || item.courseId === course.id);
  const upcoming = snapshot.upcoming.filter(item => !course || item.courseId === course.id);
  const unavailable = snapshot.unavailableCourses.filter(id => !course || id === course.id);
  const partialCounts = assignments.some(item => item.submitted === null || item.needsGrading === null);
  const notes = [];
  if (unavailable.length) notes.push('Some course assignments are unavailable.');
  if (partialCounts) notes.push('Submission totals include only assignments with counts visible in Moodle.');
  el('partial').textContent = notes.join(' ');
  el('partial').hidden = !notes.length;
  el('stat-assignments').textContent = assignments.length || !unavailable.length ? numberFormat.format(assignments.length) : '—';
  el('stat-submitted').textContent = total(assignments, 'submitted');
  el('stat-grading').textContent = total(assignments, 'needsGrading');

  el('assignments').replaceChildren(...assignments.map(item => {
    const row = node('article', 'assignment');
    const top = node('div', 'assignment-top');
    const details = node('div');
    const title = environment.live ? node('p', 'item-title', item.title) :
      button(item.title, 'item-title', () => window.workspace.open('assignment', item.id));
    const metadata = [!course && courseNames.get(item.courseId), item.due ? `Due ${item.due}` : 'No due date'];
    details.append(title, node('p', 'item-meta', metadata.filter(Boolean).join(' · ')));
    top.append(details);
    if (!environment.live) {
      const actions = node('div', 'assignment-actions');
      if (item.canGrade) actions.append(button('Open grading', 'row-button', () => window.workspace.open('grading', item.id)));
      const manage = button('Manage', 'row-button', () => openAssignmentControls(item));
      manage.dataset.manageAssignment = item.id;
      manage.setAttribute('aria-label', `Manage ${item.title}`);
      actions.append(manage);
      top.append(actions);
    }
    const counts = node('div', 'counts');
    if (item.submitted !== null) counts.append(node('span', 'count', `${item.submitted} submitted`));
    if (item.needsGrading !== null) {
      counts.append(node('span', item.needsGrading ? 'count attention' : 'count', `${item.needsGrading} needs grading`));
    }
    if (!counts.childElementCount) counts.append(node('span', 'item-meta', 'Submission counts unavailable'));
    row.append(top, counts);
    return row;
  }));
  if (!assignments.length) {
    el('assignments').append(node('p', 'panel-empty', unavailable.length ? 'Moodle did not return an assignment list.' : 'No assignments to show.'));
  }

  el('upcoming').replaceChildren(...upcoming.map(item => {
    const date = new Date(item.time);
    const row = node('article', 'event');
    const badge = node('time', 'event-date', monthFormat.format(date));
    badge.dateTime = date.toISOString();
    badge.append(node('strong', '', date.getDate()));
    const details = node('div');
    details.append(environment.live ? node('p', 'item-title', item.title) :
      button(item.title, 'item-title', () => window.workspace.open('event', item.id)),
      node('p', 'item-meta', [item.course, timeFormat.format(date)].filter(Boolean).join(' · ')));
    row.append(badge, details);
    return row;
  }));
  if (!upcoming.length) {
    el('upcoming').append(node('p', 'panel-empty', snapshot.calendarAvailable ? 'No upcoming events in this view.' : 'Moodle’s calendar is unavailable.'));
  }
}

function renderCourseVisibility(focusId) {
  const list = el('course-visibility-list');
  const courses = fullSnapshot?.courses ?? [];
  const shown = courses.filter(course => !hiddenCourseIds.has(course.id)).length;
  const summary = !fullSnapshot ? 'Connect to Moodle to see your courses.' :
    !courses.length ? 'Moodle lists no courses in progress.' :
    !visibilityScope ? 'Refresh Moodle to manage course visibility.' : `${shown} of ${courses.length} courses shown`;
  el('course-visibility-summary').textContent = summary;
  list.replaceChildren(...courses.toSorted((a, b) => a.title.localeCompare(b.title)).map(course => {
    const label = node('label', 'course-visibility-row');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !hiddenCourseIds.has(course.id);
    checkbox.disabled = !visibilityScope || savingCourseVisibility;
    checkbox.dataset.courseVisibility = String(course.id);
    checkbox.addEventListener('change', () => setCourseVisibility(course.id, checkbox.checked));
    const title = node('span', '', course.title);
    if (course.shortName && course.shortName !== course.title) title.append(node('small', '', course.shortName));
    label.append(checkbox, title);
    return label;
  }));
  if (focusId) list.querySelector(`[data-course-visibility="${focusId}"]`)?.focus();
}

function updateVisibleDashboard(focusId) {
  const visible = item => !hiddenCourseIds.has(item.courseId);
  snapshot = fullSnapshot && {
    ...fullSnapshot,
    courses: fullSnapshot.courses.filter(course => !hiddenCourseIds.has(course.id)),
    assignments: fullSnapshot.assignments.filter(visible),
    upcoming: fullSnapshot.upcoming.filter(visible),
    unavailableCourses: fullSnapshot.unavailableCourses.filter(id => !hiddenCourseIds.has(id)),
  };
  render();
  renderCourseVisibility(focusId);
  window.dispatchEvent(new Event('workspace:synced'));
}

function setDashboard(result) {
  fullSnapshot = result.snapshot;
  if (visibilityScope !== result.scope) {
    visibilityScope = result.scope;
    hiddenCourseIds = new Set(result.hiddenCourses);
    el('course-visibility-error').textContent = '';
  }
  updateVisibleDashboard(document.activeElement?.dataset.courseVisibility);
}

async function setCourseVisibility(id, visible) {
  if (savingCourseVisibility) return;
  const scope = visibilityScope;
  const list = el('course-visibility-list');
  const errorText = el('course-visibility-error');
  savingCourseVisibility = true;
  for (const checkbox of list.querySelectorAll('input')) checkbox.disabled = true;
  errorText.textContent = '';
  try {
    const result = await window.workspace.setCourseVisibility(scope, id, visible);
    if (!result.ok) throw new Error(result.message);
    if (scope === visibilityScope) hiddenCourseIds = new Set(result.value);
  } catch (error) {
    if (scope === visibilityScope) errorText.textContent = error.message;
  } finally {
    savingCourseVisibility = false;
    updateVisibleDashboard(scope === visibilityScope && el('settings').open ? id : null);
  }
}

async function refreshDashboard(target) {
  el('refresh').disabled = true;
  try {
    const result = await window.workspace.refresh();
    if (target !== environment) return;
    if (result.status === 'connected') {
      setDashboard(result);
      setStatus('connected', `Connected · Synced ${syncFormat.format(new Date(snapshot.checkedAt))}`);
    } else if (result.status === 'login') {
      setStatus('login', `Sign in to refresh your dashboard.${cachedAt()}`);
    } else {
      setStatus('error', `${result.message}${cachedAt()}`);
    }
  } catch {
    if (target === environment) setStatus('error', `The dashboard could not refresh.${cachedAt()}`);
  } finally {
    if (target === environment) el('refresh').disabled = false;
  }
}

function refresh() {
  const target = environment;
  dashboardRefresh ??= refreshDashboard(target).finally(() => {
    if (target === environment) dashboardRefresh = null;
  });
  return dashboardRefresh;
}

async function refreshAfterMoodleChange() {
  if (dashboardRefresh) await dashboardRefresh;
  await refresh();
}

for (const item of Object.values(navigation)) el(item.heading).tabIndex = -1;
el('chat-tab').addEventListener('click', () => navigate('chat'));
el('new-assignment').addEventListener('click', () => navigate('builder'));
el('overview').addEventListener('click', () => selectCourse(null));
el('open-course').addEventListener('click', () => window.workspace.open('course', courseId));
el('connect').addEventListener('click', () => window.workspace.connect());
el('overview-connect').addEventListener('click', () => window.workspace.connect());
el('toggle-navigation').addEventListener('click', () => {
  setNavigation(true);
  el(navigation[view].button).focus();
});
el('nav-scrim').addEventListener('click', () => closeNavigation(true));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) closeNavigation(true);
});
compactNavigation.addEventListener('change', () => {
  const sidebarFocused = el('workspace-sidebar').contains(document.activeElement);
  setNavigation(false);
  if (compactNavigation.matches && sidebarFocused) el('toggle-navigation').focus();
});
const liveToggle = el('live-moodle');
const liveUrl = el('live-moodle-url');
const environmentStatus = el('moodle-environment-status');
const applyEnvironment = el('apply-moodle-environment');

function updateEnvironmentFields() {
  el('live-moodle-fields').hidden = !liveToggle.checked;
  liveUrl.disabled = !liveToggle.checked || liveToggle.disabled;
  liveUrl.required = liveToggle.checked;
}

function showEnvironment(next) {
  const changed = environment.live !== next.live || environment.site !== next.site;
  environment = next;
  dashboardRefresh = null;
  if (changed) {
    courseId = null;
    expandedCourses.clear();
    expandedAssignments.clear();
    expandedInitialCourse = false;
    el('assignment-feedback').textContent = '';
  }
  liveToggle.checked = next.live;
  liveUrl.value = next.site;
  updateEnvironmentFields();
  el('moodle-environment').textContent = next.live ? 'Live Moodle · Read-only' : 'Local sandbox · Moodle 4.5';
  el('moodle-connect-hint').textContent = 'Sign in to the sandbox to see your courses, upcoming activities, and grading queue.';
  environmentStatus.dataset.error = 'false';
  environmentStatus.textContent = next.live ? `Live Moodle · ${next.site}` : 'Sandbox is active.';
  setDashboard(next);
  setStatus('loading', 'Checking Moodle…');
  return refresh();
}

liveToggle.addEventListener('change', updateEnvironmentFields);
el('moodle-environment-form').addEventListener('submit', async event => {
  event.preventDefault();
  liveToggle.disabled = true;
  applyEnvironment.disabled = true;
  updateEnvironmentFields();
  try {
    const result = await window.workspace.configure(liveToggle.checked, liveUrl.value);
    if (!result.ok) throw new Error(result.message);
    showEnvironment(result.value);
  } catch (error) {
    environmentStatus.dataset.error = 'true';
    environmentStatus.textContent = error.message;
  } finally {
    liveToggle.disabled = false;
    applyEnvironment.disabled = false;
    updateEnvironmentFields();
  }
});

setNavigation(false);
el('refresh').addEventListener('click', refresh);
window.workspace.onConnected(refreshAfterMoodleChange);
window.workspace.onLoginFailed(message => {
  if (environment.live) setStatus('error', message);
});
window.workspace.environment().then(next => {
  el('app-version').textContent = `v${next.appVersion}`;
  const repositoryLink = el('repository-link');
  repositoryLink.href = next.repositoryUrl;
  repositoryLink.hidden = false;
  repositoryLink.addEventListener('click', async event => {
    event.preventDefault();
    try {
      await window.workspace.openRepository();
    } catch {
      repositoryLink.title = 'Could not open your browser.';
    }
  });
  liveToggle.disabled = false;
  applyEnvironment.disabled = false;
  return showEnvironment(next);
});
