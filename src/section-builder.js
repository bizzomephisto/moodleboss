{
  const api = window.workspace.sectionBuilder;
  const form = el('section-form');
  const fields = el('section-fields');
  const courses = el('section-course');
  const name = el('section-name');
  const summary = el('section-description');
  const urlInput = el('section-deck-url');
  const list = el('section-deck-list');
  const drivePicker = el('section-drive-picker');
  const driveDeck = el('section-drive-deck');
  const status = el('section-status');
  const open = el('section-open');
  const decks = new Map();
  let driveResults = [];
  let busy = false;
  let created;

  function feedback(message, error = false) {
    status.textContent = message;
    status.dataset.error = String(error);
  }

  function sync() {
    const chosen = courses.value;
    courses.replaceChildren(node('option', '', 'Choose a course'));
    courses.firstElementChild.value = '';
    for (const course of snapshot?.courses ?? []) {
      const option = node('option', '', course.title);
      option.value = String(course.id);
      courses.append(option);
    }
    courses.value = chosen && [...courses.options].some(option => option.value === chosen) ? chosen :
      courses.options.length === 2 ? courses.options[1].value : '';
    fields.disabled = busy;
    el('section-create').disabled = !courses.value || Boolean(environment.readOnly);
    open.hidden = !created || Boolean(environment.readOnly);
    const hint = el('section-target-hint');
    hint.textContent = environment.readOnly ? 'Unlock Live Moodle to create the section.' :
      courses.options.length === 1 ? 'Connect to Moodle to load your current courses.' : '';
    hint.hidden = !hint.textContent;
  }

  function renderDecks() {
    list.replaceChildren(...[...decks.values()].map(deck => {
      const item = node('li');
      const remove = button('Remove', 'row-button', () => {
        decks.delete(deck.url);
        renderDecks();
        urlInput.focus();
      });
      remove.setAttribute('aria-label', 'Remove ' + deck.title);
      item.append(node('span', '', deck.title), remove);
      return item;
    }));
  }

  function addDeck(value, title) {
    const url = URL.parse(value.trim());
    const id = url?.origin === 'https://docs.google.com' && !url.username && !url.password &&
      url.pathname.match(/^\/presentation\/(?:u\/\d+\/)?d\/([\w-]{1,200})(?:\/|$)/)?.[1];
    if (!id) throw new Error('Enter a Google Slides presentation link.');
    const canonical = 'https://docs.google.com/presentation/d/' + id + '/edit';
    if (!decks.has(canonical) && decks.size >= 6) throw new Error('Add up to six slide decks per section.');
    decks.set(canonical, { url: canonical, title: title || 'Google Slides deck · ' + id.slice(-12) });
    renderDecks();
    feedback('');
  }

  function addLink() {
    addDeck(urlInput.value);
    urlInput.value = '';
  }

  async function use(promise) {
    const result = await promise;
    if (!result.ok) throw new Error(result.message);
    return result.value;
  }

  async function run(action) {
    if (busy) return;
    busy = true;
    sync();
    try {
      await action();
    } catch (error) {
      feedback(error.message, true);
    } finally {
      busy = false;
      sync();
    }
  }

  el('section-add-deck').addEventListener('click', () => {
    try {
      addLink();
      urlInput.focus();
    } catch (error) {
      feedback(error.message, true);
    }
  });
  urlInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    el('section-add-deck').click();
  });
  el('section-list-decks').addEventListener('click', () => run(async () => {
    feedback('Loading decks from Google Drive…');
    driveResults = await use(api.listDecks());
    driveDeck.replaceChildren(...driveResults.map((deck, index) => {
      const option = node('option', '', deck.title);
      option.value = String(index);
      return option;
    }));
    drivePicker.hidden = !driveResults.length;
    feedback(driveResults.length ? '' : 'There are no Google Slides decks available to MoodleBOSS on this account.');
  }));
  el('section-add-drive-deck').addEventListener('click', () => {
    const selected = driveResults[Number(driveDeck.value)];
    if (!selected) return;
    try {
      addDeck(selected.url, selected.title);
    } catch (error) {
      feedback(error.message, true);
    }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (environment.readOnly) return;
    run(async () => {
      if (urlInput.value.trim()) addLink();
      created = null;
      open.hidden = true;
      feedback('Preparing the section…');
      created = await use(api.build({
        courseId: Number(courses.value), title: name.value, summary: summary.value, urls: [...decks.keys()],
      }));
      name.value = summary.value = '';
      decks.clear();
      renderDecks();
      feedback(created.uploaded ? `Created “${created.title}” and uploaded ${created.uploaded} PDF${created.uploaded === 1 ? '' : 's'}. The section and files are hidden in Moodle.` :
        `Created “${created.title}” as a hidden section in Moodle.`);
    });
  });
  open.addEventListener('click', () => run(() => use(api.open(created.sectionId))));
  api.onProgress(message => feedback(message));
  courses.addEventListener('change', sync);
  window.addEventListener('workspace:synced', sync);
  window.addEventListener('workspace:section-deck', event => {
    navigate('section');
    try {
      addDeck(event.detail.url, event.detail.title);
      if (!courses.value && courseId) courses.value = String(courseId);
      sync();
    } catch (error) {
      feedback(error.message, true);
    }
  });
  sync();
}
