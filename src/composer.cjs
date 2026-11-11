const { readFile, writeFile, rename } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { complete, endpoints, hosted, listModels } = require('./ai-provider.cjs');
const { preparePresentation } = require('./presentation.cjs');

const defaults = {
  provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234/v1', model: '',
};
const emptyDraft = {
  title: '', instructions: '', notes: '', courseId: null, section: null,
  due: '', cutoff: '', cutoffEnabled: false,
};

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  if (value.length > limit) throw new Error('One of the fields is too long.');
  return value;
}

function draftDate(value, label) {
  const text = clean(value, 16);
  if (text) {
    const date = new Date(text + 'Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 16) !== text) {
      throw new Error(`Enter a valid ${label} date and time.`);
    }
  }
  return text;
}

function draftFrom(value = {}) {
  return {
    title: clean(value.title, 255),
    instructions: clean(value.instructions, 30000),
    notes: clean(value.notes, 12000),
    courseId: Number.isSafeInteger(value.courseId) && value.courseId > 0 ? value.courseId : null,
    section: Number.isSafeInteger(value.section) && value.section >= 0 ? value.section : null,
    due: draftDate(value.due, 'due'),
    cutoff: draftDate(value.cutoff, 'cutoff'),
    cutoffEnabled: value.cutoffEnabled === true,
  };
}

function settingsFrom(value) {
  if (!Object.hasOwn(endpoints, value.provider)) throw new Error('Choose an AI provider.');
  if (Object.hasOwn(hosted, value.provider)) {
    return { provider: value.provider, endpoint: hosted[value.provider], model: clean(value.model, 240).trim() };
  }
  let url;
  try {
    url = new URL(clean(value.endpoint, 500).trim());
  } catch {
    throw new Error('Enter the AI server’s API base URL, such as http://127.0.0.1:1234/v1.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      (value.provider !== 'compatible' && !loopback)) {
    throw new Error('Use a loopback URL for local AI or an HTTPS URL for a compatible cloud service. Enter any key separately.');
  }
  return {
    provider: value.provider,
    endpoint: url.href.replace(/\/+$/, ''),
    model: clean(value.model, 240).trim(),
  };
}

async function generate(settings, key, draft) {
  if (!settings.model) throw new Error('Choose or enter a model in AI settings.');
  if (!draft.notes.trim()) throw new Error('Enter an assignment prompt before generating.');
  const content = await complete(settings, key, [
    {
      role: 'system',
      content: [
        'You help an instructor design assignments. Follow the instructor’s prompt and write a complete handout addressed directly to students.',
        'When the instructor gives only a topic or learning goal, design a concrete exercise. Decide what students do, give them a useful process, and define what they turn in.',
        'When the instructor specifies deliverables, put them in a “What to submit” section. Carry over every quantity and format detail, including any per-page requirement. Keep exactly those deliverables. Present any extra activities as optional approaches.',
        'When the instructor requests a brief, explanation, or examples, write that teaching material into the handout. For “three posters, one per page, include a brief on visual hierarchy,” the handout requires three posters, one per page, and explains how size, contrast, and placement guide the viewer’s attention.',
        'Include dates, point values, grading weights, policies, and links only when supplied. Qualitative success criteria are fine. Use class context supplied in the prompt.',
        'Start with TITLE: followed by a short title on the same line. On the next line write HANDOUT: and then the handout in plain text with actual line breaks. Use short headings. Aim for 250–450 words unless the instructor specifies a length.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: draft.title.trim()
        ? `Current draft title for context: ${draft.title.trim()}\n\nAssignment prompt:\n${draft.notes.trim()}`
        : draft.notes.trim(),
    },
  ], 0.3);
  if (typeof content === 'string') {
    try {
      const text = content.trim().replace(/^\x60{3}(?:json|text)?\s*|\s*\x60{3}$/gi, '');
      const handout = text.match(/^TITLE:[ \t]*(.+)\r?\n\s*HANDOUT:[ \t]*([\s\S]+)$/i);
      const generated = handout ? { title: handout[1], instructions: handout[2] } : JSON.parse(text);
      const { title, instructions } = draftFrom(generated);
      if ((draft.title.trim() || title.trim()) && instructions.trim()) {
        return { title: draft.title.trim() || title.trim(), instructions: instructions.trim() };
      }
    } catch {
      // The draft is left intact when a model returns malformed output.
    }
  }
  throw new Error('The model did not return a usable assignment. Try again or choose another model.');
}

async function chat(settings, key, history) {
  if (!settings.model) throw new Error('Choose or enter a model in AI settings.');
  if (!Array.isArray(history)) throw new Error('Enter a message first.');
  const turns = history.slice(-11).flatMap(turn => {
    if (!['user', 'assistant'].includes(turn?.role)) return [];
    const content = clean(turn.content, turn.role === 'user' ? 12000 : 30000).trim();
    return content ? [{ role: turn.role, content }] : [];
  });
  if (turns.at(-1)?.role !== 'user') throw new Error('Enter a message first.');
  const reply = clean(await complete(settings, key, [
    { role: 'system', content: 'You are MoodleBOSS, an instructor’s assistant. Help brainstorm lessons, assignments, and classroom activities. Give practical examples and concise feedback. You can discuss drafts and ideas in this chat.' },
    ...turns,
  ]), 30000).trim();
  if (!reply) throw new Error('The model returned an empty reply.');
  return reply;
}

function draftSelection(state) {
  const selected = state.drafts.find(entry => entry.id === state.activeDraftId);
  return {
    draft: selected ?? { ...emptyDraft, id: null },
    drafts: state.drafts.map(({ id, title }) => ({ id, title })),
  };
}

async function loadComposer(directory) {
  const file = path.join(directory, 'composer.json');
  let state = { settings: defaults, profiles: {}, drafts: [], activeDraftId: null, theme: 'light', hiddenCourses: {} };
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const settings = settingsFrom(saved.settings);
    const drafts = Array.isArray(saved.drafts)
      ? saved.drafts.filter(draft => typeof draft?.id === 'string').map(draft => ({ ...draftFrom(draft), id: draft.id }))
      : saved.draft ? [{ ...draftFrom(saved.draft), id: 'legacy' }] : [];
    state = {
      settings,
      profiles: { ...saved.profiles, [settings.provider]: settings },
      drafts,
      activeDraftId: saved.activeDraftId ?? (saved.drafts ? null : drafts[0]?.id ?? null),
      theme: saved.theme === 'dark' ? 'dark' : 'light',
      hiddenCourses: { ...saved.hiddenCourses },
    };
  } catch {
    // Use defaults for a new or unreadable profile.
  }
  const credentials = new Map();
  let writes = Promise.resolve();

  function activeKey(settings = state.settings) {
    const credential = credentials.get(settings.provider);
    return credential?.endpoint === settings.endpoint ? credential.key : '';
  }

  function providerSelection() {
    const profiles = {};
    for (const [provider, endpoint] of Object.entries(endpoints)) {
      const settings = settingsFrom({ endpoint, ...state.profiles[provider], provider });
      profiles[provider] = { ...settings, hasKey: Boolean(activeKey(settings)) };
    }
    return { settings: state.settings, profiles, hasKey: Boolean(activeKey()), fixedProviders: Object.keys(hosted) };
  }

  function persist(changes) {
    const write = writes.then(async () => {
      const next = { ...state, ...(typeof changes === 'function' ? changes(state) : changes) };
      await writeFile(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
      await rename(file + '.tmp', file);
      state = next;
      return next;
    });
    writes = write.catch(() => {});
    return write;
  }

  function requireDraft(state, id) {
    if (!state.drafts.some(entry => entry.id === id)) throw new Error('This saved draft is no longer available.');
  }

  function hiddenCourses(scope, current = state) {
    const saved = current.hiddenCourses[scope];
    return Array.isArray(saved) ? saved.filter(id => Number.isSafeInteger(id) && id > 0) : [];
  }

  return {
    get: () => ({ ...providerSelection(), ...draftSelection(state), theme: state.theme }),
    hiddenCourses,
    async saveCourseVisibility(scope, id, visible) {
      const next = await persist(current => {
        const ids = new Set(hiddenCourses(scope, current));
        if (visible) ids.delete(id);
        else ids.add(id);
        return { hiddenCourses: { ...current.hiddenCourses, [scope]: [...ids] } };
      });
      return hiddenCourses(scope, next);
    },
    async saveTheme(theme) {
      if (theme !== 'light' && theme !== 'dark') throw new Error('Choose a light or dark theme.');
      await persist({ theme });
      return theme;
    },
    async saveDraft(value) {
      const id = value.id ?? randomUUID();
      const draft = { ...draftFrom(value), id };
      return draftSelection(await persist(current => {
        if (value.id != null) requireDraft(current, id);
        return { drafts: [draft, ...current.drafts.filter(entry => entry.id !== id)], activeDraftId: id };
      }));
    },
    async openDraft(id) {
      return draftSelection(await persist(current => {
        requireDraft(current, id);
        return { activeDraftId: id };
      }));
    },
    async deleteDraft(id) {
      return draftSelection(await persist(current => {
        requireDraft(current, id);
        return {
          drafts: current.drafts.filter(entry => entry.id !== id),
          activeDraftId: current.activeDraftId === id ? null : current.activeDraftId,
        };
      }));
    },
    async saveSettings(value) {
      const settings = settingsFrom(value);
      const suppliedKey = clean(value.key, 4096).trim();
      if (/\s/.test(suppliedKey)) throw new Error('An API key cannot contain spaces or line breaks.');
      await persist(current => ({ settings, profiles: { ...current.profiles, [settings.provider]: settings } }));
      if (value.clearKey) credentials.delete(settings.provider);
      else if (suppliedKey) credentials.set(settings.provider, { endpoint: settings.endpoint, key: suppliedKey });
      return providerSelection();
    },
    models: () => listModels(state.settings, activeKey()),
    generate: value => generate(state.settings, activeKey(), draftFrom(value)),
    chat: history => chat(state.settings, activeKey(), history),
    presentation: (history, progress) => preparePresentation(state.settings, activeKey(), history, progress),
  };
}

module.exports = { loadComposer, draftFrom };
