const { load } = require('cheerio');

const origin = 'http://127.0.0.1:8787';
const loginPath = '/login/index.php';
const courseScope = 'inprogress';

class SignInRequired extends Error {}

function liveSite(value) {
  try {
    const url = new URL(value.trim());
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
      return url.href.replace(/\/+$/, '');
    }
  } catch {
    // Show one validation message for malformed and unsupported URLs.
  }
  throw new Error('Enter the HTTPS address of your Moodle site, including its subdirectory if it has one.');
}

function siteUrls(root) {
  const site = new URL(root);
  const prefix = site.pathname.replace(/\/+$/, '');
  function localUrl(value, base = root + '/') {
    if (!value) return null;
    try {
      const url = new URL(value, base);
      if (url.origin === site.origin && !url.username && !url.password &&
          (url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) return url;
    } catch {
      // Ignore malformed links in Moodle markup.
    }
    return null;
  }
  return { url: path => root + path, localUrl, route: url => url?.pathname.slice(prefix.length) };
}

function plainText(value) {
  return load(value ?? '', {}, false).text().trim();
}

function assignmentsFrom(html, courseId, { localUrl, route }) {
  const $ = load(html);
  return $('#region-main table tbody tr').toArray().flatMap(row => {
    const cells = $(row).children('td');
    const links = cells.find('a[href]').toArray();
    const activity = links.find(link => {
      const url = localUrl($(link).attr('href'));
      return route(url) === '/mod/assign/view.php' &&
        /^\d+$/.test(url.searchParams.get('id')) && !url.searchParams.has('action');
    });
    if (!activity) return [];

    const url = localUrl($(activity).attr('href'));
    const id = Number(url.searchParams.get('id'));
    const index = cells.index($(activity).closest('td')[0]);
    const submitted = cells.eq(index + 2).text().trim();
    const grading = cells.eq(index + 3).find('a[href]').first();
    const gradingUrl = localUrl(grading.attr('href'));
    const canGrade = gradingUrl?.pathname === url.pathname &&
      gradingUrl.searchParams.get('id') === String(id) &&
      gradingUrl.searchParams.get('action') === 'grading';
    const needsGrading = grading.text().match(/\d+/);
    const due = cells.eq(index + 1).text().trim();

    return [{
      id,
      courseId,
      title: $(activity).text().trim(),
      due: due && due !== '-' ? due : null,
      submitted: canGrade && /^\d+$/.test(submitted) ? Number(submitted) : null,
      needsGrading: canGrade && needsGrading ? Number(needsGrading[0]) : null,
      canGrade,
    }];
  });
}

async function request(connection, path, { timeoutMs = 12000, ...options } = {}) {
  const { session, url, live } = connection;
  let response;
  if (live) connection.signInRequired = false;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    response = await session.fetch(url(path), {
      credentials: 'include',
      redirect: 'follow',
      signal: live ? AbortSignal.any([timeout, connection.abort.signal]) : timeout,
      ...options,
    });
  } catch {
    if (connection.signInRequired) throw new SignInRequired();
    throw new Error(live ? 'Could not reach live Moodle. Check the site address and your network connection.' :
      'Could not reach the Moodle sandbox. Check that it is running.');
  }
  if (live && connection.route(connection.localUrl(response.url)) === loginPath) throw new SignInRequired();
  if (response.status === 401) throw new SignInRequired();
  if (!response.ok) throw new Error(`Moodle returned HTTP ${response.status}.`);
  return response;
}

async function htmlPage(response) {
  const html = await response.text();
  if (load(html)('#page-login-index, form#login').length) throw new SignInRequired();
  return html;
}

async function courseSections(connection, courseId) {
  const html = await htmlPage(await request(connection, `/course/view.php?id=${courseId}`));
  const $ = load(html);
  const sections = $('#region-main li.course-section[data-number]').toArray().flatMap(element => {
    const section = $(element);
    const number = Number(section.attr('data-number'));
    if (!Number.isSafeInteger(number) || number < 0 || section.attr('data-orphan') === 'true') return [];
    const title = section.attr('data-sectionname') || (number === 0 ? 'General' : `Section ${number}`);
    return [{ number, title: plainText(title) }];
  });
  if (!sections.length) throw new Error('Moodle did not return course sections.');
  return sections;
}

async function announcementsUrl(connection, courseId) {
  const { url: siteUrl, localUrl, route } = connection;
  const index = siteUrl(`/mod/forum/index.php?id=${courseId}`);
  const html = await htmlPage(await request(connection, `/mod/forum/index.php?id=${courseId}`));
  const $ = load(html);
  for (const link of $('#region-main a[href]').toArray()) {
    if (!/^(announcements|news forum)$/i.test($(link).text().trim())) continue;
    const url = localUrl($(link).attr('href'), index);
    if (route(url) === '/mod/forum/view.php' && /^\d+$/.test(url.searchParams.get('f') ?? url.searchParams.get('id'))) {
      return url.href;
    }
  }
  return index;
}

async function ajax(connection, sesskey, calls) {
  if (connection.readOnly && calls.some(call => !dashboardMethods.has(call.methodname))) {
    throw new Error('Live Moodle is read-only.');
  }
  const params = new URLSearchParams({ sesskey, info: calls.map(call => call.methodname).join(',') });
  const response = await request(connection, `/lib/ajax/service.php?${params}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(calls.map((call, index) => ({ index, ...call }))),
  });
  if (response.headers.get('content-type')?.includes('text/html')) {
    await htmlPage(response);
    throw new Error('Moodle returned a page in place of dashboard data.');
  }
  const results = await response.json();
  if (!Array.isArray(results) || results.length !== calls.length) {
    throw new Error('Moodle returned an unexpected dashboard response.');
  }
  if (results.some(result => ['invalidsesskey', 'requireloginerror'].includes(result?.exception?.errorcode))) {
    throw new SignInRequired();
  }
  return results;
}

async function assignmentSettings(connection, assignment) {
  const html = await htmlPage(await request(connection, `/course/modedit.php?update=${assignment.id}&return=1`));
  const $ = load(html);
  const form = $('#id_name').closest('form');
  const field = name => form.find(`[name="${name}"]`).first().val();
  if (field('update') !== String(assignment.id) || field('course') !== String(assignment.courseId) ||
      field('modulename') !== 'assign' || !field('sesskey')) {
    throw new Error('Moodle did not grant access to edit this assignment.');
  }
  const visibility = form.find('select[name="visible"]');
  const mode = visibility.val();
  const options = visibility.is(':disabled') ? [] : visibility.find('option:not([disabled])').toArray()
    .map(option => ({ value: $(option).val(), label: $(option).text().trim() }));
  return {
    sesskey: field('sesskey'),
    title: field('name'),
    visibility: options.find(option => option.value === mode)?.label ?? '',
    action: mode === '0' && options.some(option => option.value === '1') ? 'show' :
      (mode === '1' || mode === '-1') && options.some(option => option.value === '0') ? 'hide' : null,
  };
}

async function setAssignmentVisibility(connection, assignment, action, expectedTitle) {
  const settings = await assignmentSettings(connection, assignment);
  if (settings.title !== expectedTitle || settings.action !== action) {
    throw new Error('This assignment changed in Moodle. Reopen Manage before changing visibility.');
  }
  const [result] = await ajax(connection, settings.sesskey, [{
    methodname: 'core_courseformat_update_course',
    args: { action: `cm_${action}`, courseid: assignment.courseId, ids: [assignment.id] },
  }]);
  if (result.error || typeof result.data !== 'string') {
    throw new Error('Moodle could not change this assignment’s visibility.');
  }
  const updated = await assignmentSettings(connection, assignment);
  if (updated.action !== (action === 'hide' ? 'show' : 'hide')) {
    throw new Error('Moodle did not confirm the visibility change. Reopen Manage to check.');
  }
  return updated;
}

async function deleteAssignment(connection, assignment, expectedTitle) {
  const settings = await assignmentSettings(connection, assignment);
  if (settings.title !== expectedTitle) {
    throw new Error('This assignment changed in Moodle. Reopen Manage to confirm the current title.');
  }
  const result = await htmlPage(await request(connection, '/course/mod.php', {
    method: 'POST',
    body: new URLSearchParams({ delete: assignment.id, confirm: 1, sesskey: settings.sesskey }),
  }));
  if (load(result)('#region-main .alert-danger, #page-mod-assign-delete').length) {
    throw new Error('Moodle did not accept the deletion.');
  }
  const index = await htmlPage(await request(connection, `/mod/assign/index.php?id=${assignment.courseId}`));
  if (load(index)('#region-main .alert-danger').length || assignmentsFrom(index, assignment.courseId, connection).some(item => item.id === assignment.id)) {
    throw new Error('Moodle did not confirm deletion. Refresh the assignment list before trying again.');
  }
}

const dashboardMethods = new Set([
  'core_course_get_enrolled_courses_by_timeline_classification',
  'core_calendar_get_calendar_upcoming_view',
]);

async function dashboard(connection) {
  const page = await htmlPage(await request(connection, '/my/courses.php'));

  const cfg = page.match(/\bM\.cfg\s*=\s*(\{[^\n]+?\});/)?.[1];
  if (!cfg) throw new Error('Could not read the session from Moodle’s My courses page.');
  const { sesskey, userId } = JSON.parse(cfg);
  const accountId = Number(userId);
  if (!sesskey || !Number.isSafeInteger(accountId) || accountId < 1) throw new SignInRequired();

  const [courseResult, calendarResult] = await ajax(connection, sesskey, [
    { methodname: 'core_course_get_enrolled_courses_by_timeline_classification', args: { classification: courseScope } },
    { methodname: 'core_calendar_get_calendar_upcoming_view', args: { courseid: 0, categoryid: 0 } },
  ]);
  if (!Array.isArray(courseResult?.data?.courses)) throw new Error('Moodle could not list your courses.');

  const courses = courseResult.data.courses.map(course => ({
    id: Number(course.id),
    title: plainText(course.fullname),
    shortName: plainText(course.shortname),
  })).filter(course => Number.isSafeInteger(course.id) && course.id > 0);
  const courseIds = new Set(courses.map(course => course.id));
  const assignments = [];
  const unavailableCourses = [];

  // The PHP development server processes one request at a time.
  for (const course of courses) {
    connection.abort?.signal.throwIfAborted();
    try {
      const html = await htmlPage(await request(connection, `/mod/assign/index.php?id=${course.id}`));
      if (load(html)('#region-main .alert-danger').length) throw new Error('Assignment index unavailable.');
      assignments.push(...assignmentsFrom(html, course.id, connection));
    } catch (error) {
      if (error instanceof SignInRequired) throw error;
      unavailableCourses.push(course.id);
    }
  }

  const events = calendarResult?.data?.events;
  const upcoming = Array.isArray(events) ? events.flatMap(event => {
    const courseId = Number(event.course?.id || event.courseid) || null;
    if (courseId !== null && !courseIds.has(courseId) && event.eventtype !== 'site') return [];
    const link = connection.localUrl(event.viewurl);
    const route = connection.route(link);
    if (route !== '/calendar/view.php' || !Number.isFinite(event.timestart)) return [];
    return [{
      id: event.id,
      title: plainText(event.name),
      course: plainText(event.course?.fullname),
      courseId,
      time: event.timestart * 1000,
      path: `${route}${link.search}${link.hash}`,
    }];
  }).sort((a, b) => a.time - b.time) : [];

  return {
    courseScope,
    accountId,
    checkedAt: new Date().toISOString(),
    courses,
    assignments,
    upcoming,
    unavailableCourses,
    calendarAvailable: Array.isArray(events),
  };
}

module.exports = {
  origin, loginPath, liveSite, siteUrls, courseScope, dashboardMethods, SignInRequired, dashboard, courseSections, announcementsUrl,
  assignmentSettings, setAssignmentVisibility, deleteAssignment,
  request, htmlPage, ajax,
};
