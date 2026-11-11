const { load } = require('cheerio');
const { request, htmlPage, ajax, SignInRequired } = require('./moodle.cjs');

const idPattern = /^[1-9]\d*$/;
const escapeHtml = value => value.replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);

async function courseUpdates(connection, sesskey, courseid, action, ids = []) {
  const [result] = await ajax(connection, sesskey, [{
    methodname: 'core_courseformat_update_course', args: { action, courseid, ids },
  }]);
  if (result.error || typeof result.data !== 'string') throw new Error('Moodle did not allow this course section operation.');
  const updates = JSON.parse(result.data);
  if (!Array.isArray(updates)) throw new Error('Moodle did not return the updated course structure.');
  return updates;
}

const fieldsFor = (updates, name) => updates.filter(item => item.name === name).map(item => item.fields);

function moodleForm(connection, html, route, selector) {
  const $ = load(html);
  const form = $(selector).closest('form');
  const action = connection.localUrl(form.attr('action'), connection.url(route));
  if (!form.length || connection.route(action) !== route || form.attr('method')?.toLowerCase() !== 'post') {
    throw new Error('Moodle did not return the expected editing form.');
  }
  const values = new URLSearchParams(form.serializeArray().map(({ name, value }) => [name, value]));
  return { form, values, path: route + action.search };
}

async function saveForm(connection, form, submit) {
  const control = form.form.find(`input[type="submit"][name="${submit}"], button[type="submit"][name="${submit}"]`).first();
  if (!control.length) throw new Error('Moodle did not offer a save action.');
  form.values.set(submit, control.val() || '1');
  const response = await request(connection, form.path, { method: 'POST', body: form.values });
  const $ = load(await htmlPage(response));
  if (!$('body[id^="page-course-view"], body#page-course-section').length) {
    const reason = $('#region-main .alert-danger, #region-main .invalid-feedback').toArray()
      .map(element => $(element).text().trim()).find(Boolean);
    throw new Error(reason ? `Moodle rejected the save: ${reason.slice(0, 220)}` :
      'Moodle did not confirm the save.');
  }
}

async function saveSectionSettings(connection, courseId, section, title, summary) {
  const route = '/course/editsection.php';
  const html = await htmlPage(await request(connection, route + '?id=' + section.id));
  const form = moodleForm(connection, html, route, 'input[name="id"][value="' + section.id + '"]');
  if (form.values.get('course') !== String(courseId) || !form.values.has('summary_editor[text]')) {
    throw new Error('Moodle did not grant access to this section’s settings.');
  }
  form.values.set('name', title);
  form.values.set('summary_editor[text]', escapeHtml(summary).replace(/\n/g, '<br>'));
  form.values.set('summary_editor[format]', '1');
  await saveForm(connection, form, 'submitbutton');
}

async function addPdf(connection, courseId, section, file) {
  const route = '/course/modedit.php';
  const params = new URLSearchParams({ add: 'resource', course: courseId, section: section.number });
  const html = await htmlPage(await request(connection, route + '?' + params));
  const form = moodleForm(connection, html, route, 'input[name="files"]');
  const { values } = form;
  const itemId = values.get('files');
  if (values.get('add') !== 'resource' || values.get('update') !== '0' ||
      values.get('course') !== String(courseId) || values.get('section') !== String(section.number) ||
      !values.get('sesskey') || !idPattern.test(itemId ?? '') ||
      !form.form.find('select[name="visible"]:enabled option[value="0"]:enabled').length) {
    throw new Error('Moodle did not grant access to add a hidden File resource.');
  }

  const configs = [...html.matchAll(/M\.form_filemanager\.init\(Y,\s*(\{[^\n]+?\})\s*\);/g)];
  const config = configs.map(match => JSON.parse(match[1])).find(item => String(item.itemid) === itemId);
  const repository = Object.values(config?.filepicker?.repositories ?? {}).find(item => item.type === 'upload');
  if (!idPattern.test(String(repository?.id)) || !idPattern.test(String(config?.context?.id)) ||
      String(config.context.instanceid) !== String(courseId) || config.context.contextlevel !== 50) {
    throw new Error('Moodle’s Upload a file repository is unavailable for this course.');
  }
  if (config.maxbytes > 0 && file.pdf.length > config.maxbytes) throw new Error('The PDF exceeds this course’s upload limit.');

  const filename = (file.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || 'Presentation') + '.pdf';
  const upload = new FormData();
  for (const [key, value] of Object.entries({
    repo_id: repository.id, ctx_id: config.context.id, sesskey: values.get('sesskey'), itemid: itemId,
    env: 'filemanager', maxbytes: config.maxbytes, areamaxbytes: config.areamaxbytes, savepath: '/',
  })) upload.append(key, String(value));
  upload.append('repo_upload_file', new Blob([file.pdf], { type: 'application/pdf' }), filename);
  const response = await request(connection, '/repository/repository_ajax.php?action=upload', {
    method: 'POST', body: upload, timeoutMs: 60000,
  });
  const result = await response.json().catch(() => null);
  const uploaded = connection.localUrl(result?.url);
  if (!result?.file || result.error || String(result.id) !== itemId ||
      !/^\/draftfile\.php(?:\/|$)/.test(connection.route(uploaded) ?? '')) {
    throw new Error('Moodle did not accept the PDF into the File resource’s draft area.');
  }
  values.set('name', file.title);
  values.set('visible', '0');
  await saveForm(connection, form, 'submitbutton2');
}

async function buildSection(connection, courseId, { title, summary, files }, progress) {
  const coursePath = '/course/view.php?id=' + courseId;
  const html = await htmlPage(await request(connection, coursePath));
  const rawConfig = html.match(/\bM\.cfg\s*=\s*(\{[^\n]+?\});/)?.[1];
  const config = rawConfig && JSON.parse(rawConfig);
  if (!config?.sesskey || Number(config.userId) !== connection.snapshot.accountId) throw new SignInRequired();

  const { sesskey } = config;
  const update = (action, ids) => courseUpdates(connection, sesskey, courseId, action, ids);
  const prior = fieldsFor(await update('course_state'), 'section');
  if (!prior.length) throw new Error('Moodle did not return the course’s existing sections.');
  const ids = new Set(prior.map(section => String(section.id)));
  let created;
  let hidden = false;
  let uploaded = 0;
  try {
    progress('Creating an empty Moodle section…');
    const added = fieldsFor(await update('section_add'), 'section')
      .filter(section => !ids.has(String(section.id)) && !section.component && idPattern.test(String(section.id)));
    if (added.length !== 1) throw new Error('Moodle did not identify exactly one new section.');
    created = added[0];
    const hiddenUpdates = fieldsFor(await update('section_hide', [Number(created.id)]), 'section');
    const target = hiddenUpdates.find(section => String(section.id) === String(created.id));
    if (target?.visible !== false || !idPattern.test(String(target.number))) {
      throw new Error('Moodle did not confirm that the empty section was hidden.');
    }
    hidden = true;
    await saveSectionSettings(connection, courseId, target, title, summary);
    const readSection = () => update('section_state', [Number(target.id)]);
    const checkSection = updates => {
      const current = fieldsFor(updates, 'section').find(section => String(section.id) === String(target.id));
      if (current?.visible !== false || current.number !== target.number || current.rawtitle !== title) {
        throw new Error('Moodle did not confirm the saved hidden section settings.');
      }
    };
    let state = await readSection();
    checkSection(state);
    for (const file of files) {
      progress(`Uploading PDF ${uploaded + 1} of ${files.length}…`);
      const previousModules = new Set(fieldsFor(state, 'cm').map(module => String(module.id)));
      await addPdf(connection, courseId, target, file);
      state = await readSection();
      checkSection(state);
      const resource = fieldsFor(state, 'cm').filter(module =>
        !previousModules.has(String(module.id)) && module.module === 'resource' &&
        String(module.sectionid) === String(target.id) && module.visible === false);
      if (resource.length !== 1) throw new Error('Moodle did not confirm exactly one new hidden PDF resource.');
      uploaded++;
    }
    return { courseId, sectionId: Number(target.id), title, uploaded };
  } catch (error) {
    const detail = hidden ? `Section ${created.id} was created and hidden. Confirmed PDFs: ${uploaded} of ${files.length}.` :
      'Moodle may have added an empty section. No title, description, or files were sent to that section.';
    throw new Error(`${error.message} ${detail} Check the course in Moodle before retrying.`);
  }
}

module.exports = { buildSection };
