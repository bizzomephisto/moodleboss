{
  const api = window.workspace.composer;
  const settingsDialog = el('settings');
  const deleteDialog = el('delete-draft-dialog');
  let deleteId = null;
  let draftId = null;
  let editRevision = 0;
  let savedRevision = 0;
  let profiles = {};
  let fixedProviders = [];
  const darkMode = el('dark-mode');
  const chatInput = el('chat-input');
  const chatLog = el('chat-log');
  let chatTurns = [];
  let googleState = { configured: false, connected: false };
  let secureCredentials = false;
  const chatSkill = el('chat-skill');
  const provider = el('ai-provider');
  const endpoint = el('ai-endpoint');
  const model = el('ai-model');
  const modelPicker = el('ai-model-picker');
  const key = el('ai-key');
  const course = el('draft-course');
  const section = el('draft-section');
  const prompt = el('draft-notes');
  const title = el('draft-title');
  const instructions = el('draft-instructions');
  const due = el('draft-due');
  const cutoff = el('draft-cutoff');
  const cutoffEnabled = el('draft-cutoff-enabled');
  const status = el('composer-status');
  const draftFeedback = el('draft-feedback');
  const reconnect = el('composer-connect');
  const actions = ['generate-draft', 'save-draft', 'review-draft', 'find-models', 'save-ai', 'clear-key', 'send-chat', 'clear-chat', 'confirm-delete-draft', 'cancel-delete-draft', 'google-import', 'google-connect', 'google-disconnect'];
  let initialized = false;
  let working = false;
  let loadingSections = false;
  let sectionRequest = 0;
  let pendingSection = null;
  let savedTarget;

  function message(text, error = false, feedback = draftFeedback) {
    if (deleteDialog.open && error) el('delete-draft-error').textContent = text;
    const target = settingsDialog.open ? el('settings-status') : feedback;
    target.textContent = text;
    target.dataset.error = String(error);
  }

  function valueOf(select) {
    return select.value === '' ? null : Number(select.value);
  }

  function readDraft() {
    return {
      id: draftId,
      title: title.value,
      instructions: instructions.value,
      notes: prompt.value,
      courseId: valueOf(course) ?? savedTarget?.courseId ?? null,
      section: valueOf(section) ?? pendingSection ?? savedTarget?.section ?? null,
      due: due.value,
      cutoff: cutoff.value,
      cutoffEnabled: cutoffEnabled.checked,
    };
  }

  function syncControls() {
    for (const id of actions) el(id).disabled = working;
    provider.disabled = working;
    chatSkill.disabled = working;
    el('google-connect').disabled = working || !googleState.configured;
    document.querySelectorAll('.presentation-create, .presentation-images').forEach(control => { control.disabled = working; });
    const destination = section.options.length && valueOf(course) !== null;
    const content = title.value.trim() && instructions.value.trim();
    el('review-draft').disabled = environment.live || working || loadingSections || !destination || !content;
    el('review-hint').textContent = environment.live ? 'Live Moodle is read-only. You can save drafts locally.' :
      loadingSections ? 'Loading Moodle sections…' :
      !destination ? 'Choose a course and section in Moodle details.' :
      !content ? 'Add a title and handout before review.' : 'New assignments open hidden in Moodle.';
    const courseName = course.selectedOptions[0]?.text;
    const sectionName = section.selectedOptions[0]?.text;
    const dueLabel = due.value ? `Due ${monthFormat.format(new Date(due.value))} ${Number(due.value.slice(8, 10))}` : '';
    el('destination-summary').textContent = [courseName, sectionName, dueLabel]
      .filter(Boolean).join(' · ') || 'Course, section, and dates';
  }

  async function use(resultPromise) {
    const result = await resultPromise;
    if (!result.ok) {
      if (result.login) reconnect.hidden = false;
      throw new Error(result.message);
    }
    return result.value;
  }

  async function run(action, feedback = draftFeedback) {
    if (working) return;
    working = true;
    syncControls();
    try {
      await action();
    } catch (error) {
      message(error.message, true, feedback);
    } finally {
      working = false;
      syncControls();
    }
  }

  function settingsSummary(hasKey) {
    const selected = model.value || 'Choose a model in Settings';
    el('ai-summary').textContent = selected;
    el('builder-model').textContent = model.value ? `Model · ${model.value}` : 'Choose an AI model';
    el('clear-key').hidden = !hasKey;
    key.placeholder = hasKey ? (secureCredentials ? 'Key saved on this device' : 'Key held for this session') :
      fixedProviders.includes(provider.value) ? 'Enter your provider API key' : 'Optional for most local servers';
  }

  async function saveSettings(clearKey = false) {
    const result = await use(api.settings({
      provider: provider.value, endpoint: endpoint.value, model: model.value, key: key.value, clearKey,
    }));
    profiles = result.profiles;
    endpoint.value = result.settings.endpoint;
    model.value = result.settings.model;
    key.value = '';
    settingsSummary(result.hasKey);
  }

  function option(label, value) {
    return new Option(label, String(value));
  }

  function showModels(models) {
    modelPicker.replaceChildren(...models.map(id => option(id, id)));
    if (models.length) {
      modelPicker.append(option('Enter a model ID manually', ''));
      modelPicker.value = models.includes(model.value) ? model.value : '';
    }
    el('ai-model-picker-label').hidden = !models.length;
    el('ai-model-label').hidden = models.length > 0 && Boolean(modelPicker.value);
  }

  async function loadSections(preferred = null) {
    const request = ++sectionRequest;
    const id = valueOf(course);
    pendingSection = id === null ? null : preferred;
    section.replaceChildren();
    loadingSections = id !== null;
    syncControls();
    if (id === null) {
      reconnect.hidden = Boolean(snapshot);
      return;
    }

    try {
      const result = await api.sections(id);
      if (request !== sectionRequest) return;
      if (!result.ok) {
        reconnect.hidden = !result.login;
        throw new Error(result.message);
      }
      reconnect.hidden = true;
      section.replaceChildren(...result.value.map(item =>
        option(item.number ? `${item.number} · ${item.title}` : item.title, item.number)));
      if (preferred !== null && result.value.some(item => item.number === preferred)) section.value = String(preferred);
    } catch (error) {
      if (request === sectionRequest) message(error.message, true);
    } finally {
      if (request === sectionRequest) {
        loadingSections = false;
        syncControls();
      }
    }
  }

  function loadCourses(preferred = null, preferredSection = null) {
    course.disabled = environment.live;
    section.disabled = environment.live;
    if (environment.live) {
      savedTarget = { courseId: preferred, section: preferredSection };
      sectionRequest++;
      course.replaceChildren();
      section.replaceChildren();
      pendingSection = null;
      loadingSections = false;
      reconnect.hidden = true;
      syncControls();
      return;
    }
    const courses = snapshot?.courses ?? [];
    course.replaceChildren(...courses.map(item => option(item.title, item.id)));
    if (preferred !== null) {
      if (courses.some(item => item.id === preferred)) course.value = String(preferred);
      else {
        course.prepend(option('Choose a course', ''));
        course.value = '';
      }
    }
    loadSections(valueOf(course) === preferred ? preferredSection : null);
  }

  function renderSavedDrafts(drafts) {
    const list = el('saved-draft-list');
    el('draft-count').textContent = drafts.length ? numberFormat.format(drafts.length) : '';
    list.replaceChildren(...drafts.map(item => {
      const name = item.title.trim() || 'Untitled assignment';
      const row = node('div', 'saved-draft-row');
      const open = button(name, 'tree-link', () => run(async () => {
        if (editRevision !== savedRevision && !window.confirm('Open this saved draft and discard unsaved edits?')) return;
        const result = await use(api.openDraft(item.id));
        applyDraft(result.draft);
        updateDraftList(result.drafts);
        closeNavigation();
        setView('builder');
        message('Saved draft opened.');
        title.focus();
      }));
      open.dataset.draftId = item.id;
      if (item.id === draftId) {
        open.classList.add('selected');
        open.setAttribute('aria-current', 'true');
      }
      const remove = button('', 'draft-delete', () => {
        if (working) return;
        deleteId = item.id;
        const unsaved = item.id === draftId && editRevision !== savedRevision;
        el('delete-draft-description').textContent = `“${name}” will be removed from Saved Drafts.` +
          (unsaved ? ' Unsaved edits to this draft will also be discarded.' : '');
        el('delete-draft-error').textContent = '';
        deleteDialog.showModal();
      });
      remove.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
      remove.setAttribute('aria-label', 'Delete ' + name);
      row.append(open, remove);
      return row;
    }));
    if (!drafts.length) list.append(node('p', 'tree-empty', 'No saved drafts yet.'));
  }

  let savedDrafts = [];

  function applyDraft(draft) {
    draftId = draft.id ?? null;
    title.value = draft.title ?? '';
    instructions.value = draft.instructions ?? '';
    prompt.value = draft.notes ?? '';
    due.value = draft.due ?? '';
    cutoff.value = draft.cutoff ?? '';
    cutoffEnabled.checked = draft.cutoffEnabled === true;
    cutoff.disabled = !cutoffEnabled.checked;
    savedRevision = editRevision;
    el('builder-log').replaceChildren();
    status.textContent = 'Leave the title blank to have AI suggest one.';
    status.dataset.error = 'false';
    savedTarget = { courseId: draft.courseId ?? null, section: draft.section ?? null };
    refreshCourses();
  }

  function updateDraftList(drafts) {
    savedDrafts = drafts;
    renderSavedDrafts(savedDrafts);
  }

  async function saveDraft(draft) {
    const revision = editRevision;
    const saved = await use(api.save(draft));
    draftId = saved.draft.id;
    savedRevision = revision;
    updateDraftList(saved.drafts);
  }

  function showProvider(settings) {
    endpoint.value = settings.endpoint;
    endpoint.readOnly = fixedProviders.includes(settings.provider);
    model.value = settings.model;
    key.value = '';
    showModels([]);
    settingsSummary(settings.hasKey);
  }

  async function initialize() {
    try {
      const result = await use(api.load());
      darkMode.checked = result.theme === 'dark';
      darkMode.disabled = false;
      profiles = result.profiles;
      fixedProviders = result.fixedProviders;
      secureCredentials = result.secureStorage;
      el('credential-storage-status').hidden = secureCredentials;
      provider.value = result.settings.provider;
      showProvider(profiles[provider.value]);
      applyDraft(result.draft);
      updateDraftList(result.drafts);
      initialized = true;
      showGoogle(await use(window.workspace.google.status()));
    } catch (error) {
      message(error.message, true);
    }
  }

  function openSettings() {
    if (!settingsDialog.open) settingsDialog.showModal();
  }

  function refreshCourses() {
    const selected = savedTarget ?? { courseId: valueOf(course), section: valueOf(section) ?? pendingSection };
    loadCourses(selected.courseId, selected.section);
    if (snapshot && !environment.live) savedTarget = hiddenCourseIds.has(selected.courseId) ? selected : null;
  }

  function appendActivity(role, text) {
    const entry = node('article', 'activity-entry');
    entry.append(node('span', 'eyebrow', role), node('p', '', text));
    const log = el('builder-log');
    log.append(entry);
    log.scrollTop = log.scrollHeight;
  }

  function renderChat(turns = chatTurns) {
    chatLog.replaceChildren(...turns.map(turn => {
      const entry = node('article', 'chat-entry ' + turn.role);
      entry.append(node('p', 'eyebrow', turn.role === 'user' ? 'You' : 'MoodleBOSS'));
      if (turn.presentation) {
        entry.classList.add('presentation-plan');
        entry.append(renderPresentation(turn.presentation));
      } else entry.append(node('p', 'chat-text', turn.content));
      return entry;
    }));
    if (!turns.length) chatLog.append(node('p', 'chat-empty', 'Ask for a studio exercise, lecture outline, or feedback on an idea.'));
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function showGoogle(state) {
    googleState = state;
    el('google-status').textContent = state.connected ?
      (state.remembered ? 'Google connected. MoodleBOSS will remember this account.' : 'Google connected for this app session.') :
      state.configured ? 'Credentials imported. Connect your Google account.' : 'Import Google Desktop app credentials to connect.';
    el('google-disconnect').hidden = !state.connected;
    syncControls();
  }

  function openPresentationLink(plan, kind, id) {
    use(window.workspace.presentations.open(plan.id, kind, id)).catch(error => {
      el('chat-status').textContent = error.message;
    });
  }

  function renderPresentation(plan) {
    const content = node('div');
    content.append(node('h2', '', plan.title), node('p', 'chat-text', plan.summary));
    const slides = node('div', 'presentation-slides');
    slides.dataset.deckTheme = plan.theme ?? 'studio';
    const imageIds = slide => slide.imageIds ?? (slide.imageId ? [slide.imageId] : []);
    for (const slide of plan.slides) {
      const card = node('article', 'presentation-slide');
      card.append(node('h3', '', slide.title));
      const bullets = node('ul');
      bullets.append(...slide.bullets.map(value => node('li', '', value)));
      card.append(bullets);
      const gallery = node('div', 'presentation-thumbnails');
      for (const id of imageIds(slide)) {
        const image = plan.images.find(item => item.id === id);
        if (!image) continue;
        const figure = node('div');
        const thumbnail = node('img');
        thumbnail.src = image.url;
        thumbnail.alt = image.title;
        thumbnail.loading = 'lazy';
        thumbnail.referrerPolicy = 'no-referrer';
        figure.append(thumbnail, node('small', '', `${image.artist || 'See source for creator'} · ${image.license}`));
        gallery.append(figure);
      }
      if (gallery.childElementCount) card.append(gallery);
      slides.append(card);
    }
    content.append(slides);
    for (const warning of plan.warnings) content.append(node('p', 'presentation-warning', warning));
    const sources = node('details', 'presentation-sources');
    sources.append(node('summary', '', 'Research sources and image credits'));
    for (const source of plan.sources) {
      sources.append(button(source.title, 'row-button', () => openPresentationLink(plan, 'source', source.id)));
    }
    for (const image of plan.images.filter(item => plan.slides.some(slide => imageIds(slide).includes(item.id)))) {
      sources.append(button(`${image.title} · ${image.license}`, 'row-button', () => openPresentationLink(plan, 'image', image.id)));
    }
    content.append(sources);
    const controls = node('div', 'composer-actions');
    const include = node('input', 'presentation-images');
    include.type = 'checkbox';
    include.checked = plan.includeImages !== false;
    include.disabled = working;
    include.addEventListener('change', () => { plan.includeImages = include.checked; });
    const label = node('label', 'theme-toggle');
    label.hidden = Boolean(plan.deck);
    label.append(include, document.createTextNode('Include images'));
    const create = button(plan.deck ? 'Open in Google Slides' : 'Create in Google Slides', 'primary presentation-create', () => {
      if (plan.deck) { openPresentationLink(plan, 'deck'); return; }
      run(async () => {
        showGoogle(await use(window.workspace.google.status()));
        if (!googleState.connected) {
          openSettings();
          (googleState.configured ? el('google-connect') : el('google-import')).focus();
          el('chat-status').textContent = 'Connect Google in Settings, then create this presentation.';
          return;
        }
        el('chat-status').textContent = 'Creating Google Slides…';
        try {
          plan.deck = await use(window.workspace.presentations.create(plan.id, include.checked));
        } catch (error) {
          showGoogle(await use(window.workspace.google.status()));
          throw error;
        }
        el('chat-status').textContent = 'Presentation created in your Google Drive.';
        renderChat();
      }, el('chat-status'));
    });
    create.disabled = working;
    controls.append(label, create);
    content.append(controls);
    return content;
  }

  function changeChatSkill() {
    const research = chatSkill.value === 'research-slides';
    el('chat-skill-hint').textContent = research ? 'Wikipedia research · DuckDuckGo and Wikimedia images' : '';
    chatInput.placeholder = research ? 'Describe the topic, audience, and presentation you want…' : 'Ask about a teaching idea…';
    el('send-chat').textContent = research ? 'Research & plan' : 'Send';
  }
  chatSkill.addEventListener('change', changeChatSkill);
  window.workspace.presentations.onProgress(message => {
    if (working) el('chat-status').textContent = message;
  });
  for (const [id, action] of [['google-import', 'importClient'], ['google-connect', 'connect'], ['google-disconnect', 'disconnect']]) {
    el(id).addEventListener('click', () => run(async () => {
      el('google-status').textContent = action === 'connect' ? 'Complete Google sign-in in your browser…' : 'Updating Google connection…';
      el('google-cancel').hidden = action !== 'connect';
      try {
        showGoogle(await use(window.workspace.google[action]()));
      } catch (error) {
        showGoogle(await use(window.workspace.google.status()));
        el('google-status').textContent = error.message;
      } finally {
        el('google-cancel').hidden = true;
      }
    }));
  }
  el('google-cancel').addEventListener('click', () => window.workspace.google.cancel());
  el('google-setup').addEventListener('click', () => window.workspace.google.setup());

  el('open-settings').addEventListener('click', openSettings);
  el('builder-model').addEventListener('click', openSettings);
  el('focus-prompt').addEventListener('click', () => prompt.focus());
  el('close-settings').addEventListener('click', () => settingsDialog.close());
  darkMode.addEventListener('change', async () => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    const theme = darkMode.checked ? 'dark' : 'light';
    darkMode.disabled = true;
    root.dataset.theme = theme;
    el('theme-status').textContent = '';
    try {
      await use(api.theme(theme));
    } catch (error) {
      root.dataset.theme = previous;
      darkMode.checked = previous === 'dark';
      el('theme-status').textContent = error.message;
    } finally {
      darkMode.disabled = false;
    }
  });
  reconnect.addEventListener('click', () => window.workspace.connect());
  cutoffEnabled.addEventListener('change', () => { cutoff.disabled = !cutoffEnabled.checked; });
  course.addEventListener('change', () => {
    savedTarget = null;
    message('Ready to build an assignment.');
    loadSections();
  });
  window.addEventListener('workspace:synced', () => {
    if (initialized) refreshCourses();
  });
  function startBlank(courseId) {
    if (working || !initialized) return;
    if (editRevision !== savedRevision && !window.confirm('Start a blank assignment and discard unsaved edits?')) return;
    applyDraft({ courseId });
    renderSavedDrafts(savedDrafts);
    closeNavigation();
    setView('builder');
    message('Ready to build an assignment.');
    prompt.focus();
  }

  window.addEventListener('workspace:new-draft', event => startBlank(event.detail));
  el('blank-draft').addEventListener('click', () => startBlank(valueOf(course)));
  for (const field of [title, instructions, prompt, due, cutoff, cutoffEnabled, course, section]) {
    field.addEventListener('input', () => {
      editRevision++;
      syncControls();
    });
  }
  el('cancel-delete-draft').addEventListener('click', () => deleteDialog.close());
  deleteDialog.addEventListener('cancel', event => {
    if (working) event.preventDefault();
  });
  el('confirm-delete-draft').addEventListener('click', () => run(async () => {
    const id = deleteId;
    const result = await use(api.deleteDraft(id));
    if (draftId === id) applyDraft({ courseId: valueOf(course) });
    deleteDialog.close();
    updateDraftList(result.drafts);
    el('blank-draft').focus();
    message('Saved draft deleted.');
  }));

  for (const [field, action] of [[prompt, 'generate-draft'], [chatInput, 'send-chat']]) {
    field.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        el(action).click();
      }
    });
  }
  el('clear-chat').addEventListener('click', () => {
    chatTurns = [];
    el('chat-status').textContent = '';
    renderChat();
    chatInput.focus();
  });
  el('send-chat').addEventListener('click', () => run(async () => {
    const content = chatInput.value.trim();
    if (!content) return;
    if (!model.value.trim()) {
      el('chat-status').textContent = 'Choose a model in Settings to start chatting.';
      openSettings();
      return;
    }
    const turns = [...chatTurns, { role: 'user', content }];
    chatInput.value = '';
    const chatStatus = el('chat-status');
    chatStatus.textContent = 'MoodleBOSS is responding…';
    renderChat(turns);
    try {
      await saveSettings();
      const history = turns.map(({ role, content }) => ({ role, content }));
      let answer;
      if (chatSkill.value === 'research-slides') {
        const plan = await use(window.workspace.presentations.prepare(history));
        answer = { role: 'assistant', presentation: plan, content: plan.title + '\n' + plan.summary +
          '\n' + plan.slides.map(slide => slide.title).join('\n') };
      } else {
        answer = { role: 'assistant', content: await use(api.chat(history)) };
      }
      chatTurns = [...turns, answer].slice(-60);
      chatStatus.textContent = '';
    } catch (error) {
      if (!chatInput.value) chatInput.value = content;
      else chatTurns = turns.slice(-60);
      chatStatus.textContent = error.message;
    }
    renderChat();
  }));
  renderChat();
  changeChatSkill();
  initialize();

  provider.addEventListener('change', () => {
    if (profiles[provider.value]) showProvider(profiles[provider.value]);
  });
  endpoint.addEventListener('input', () => showModels([]));
  modelPicker.addEventListener('change', () => {
    if (modelPicker.value) model.value = modelPicker.value;
    el('ai-model-label').hidden = Boolean(modelPicker.value);
    if (!modelPicker.value) model.focus();
  });
  el('save-ai').addEventListener('click', () => run(async () => {
    await saveSettings();
    message('AI settings saved.');
  }));
  el('clear-key').addEventListener('click', () => run(async () => {
    await saveSettings(true);
    message('API key cleared.');
  }));
  el('find-models').addEventListener('click', () => run(async () => {
    await saveSettings();
    const checkedProvider = provider.value;
    const checkedEndpoint = endpoint.value;
    message('Checking for models…');
    const models = await use(api.models());
    if (provider.value !== checkedProvider || endpoint.value !== checkedEndpoint) {
      message('AI settings changed. Click Find models to check the new endpoint.');
      return;
    }
    if (!model.value && models.length) {
      model.value = models[0];
      await saveSettings();
    }
    showModels(models);
    message(models.length ? `${models.length} model${models.length === 1 ? '' : 's'} found. Choose one from the Model menu.` : 'The server returned no models.');
  }));
  el('generate-draft').addEventListener('click', () => run(async () => {
    const original = readDraft();
    if (!original.notes.trim()) throw new Error('Enter an assignment prompt first.');
    if (!model.value.trim()) {
      openSettings();
      model.focus();
      throw new Error('Choose or enter a model in AI settings.');
    }
    await saveSettings();
    appendActivity('You', original.notes.trim());
    message('Generating the assignment draft…', false, status);
    const generated = await use(api.generate(original));
    const current = readDraft();
    if (current.title !== original.title || current.instructions !== original.instructions ||
        current.notes !== original.notes) {
      throw new Error('The draft changed while AI was working. Your edits are still here.');
    }
    title.value = generated.title;
    instructions.value = generated.instructions;
    await saveDraft(readDraft());
    appendActivity('MoodleBOSS', 'Drafted “' + title.value + '”.');
    message('Draft saved locally. Review the handout before opening Moodle.', false, status);
  }, status));
  el('save-draft').addEventListener('click', () => run(async () => {
    await saveDraft(readDraft());
    message('Draft saved on this device.');
  }));
  el('review-draft').addEventListener('click', () => run(async () => {
    const draft = readDraft();
    await saveDraft(draft);
    message('Opening Moodle’s assignment form…');
    await use(api.review(draft));
    message('Review the fields in Moodle and use Moodle’s Save button when ready.');
  }));
}
