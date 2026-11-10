// Runs only inside the new-assignment form on the sandbox origin.
async function fillAssignment(draft) {
  const title = document.querySelector('input#id_name[name="name"]');
  const form = title?.form;
  const field = name => form?.elements.namedItem(name);
  const intro = field('introeditor[text]');
  const visible = field('visible');
  if (!form || field('course')?.value !== String(draft.courseId) ||
      field('section')?.value !== String(draft.section) || field('add')?.value !== 'assign' ||
      (field('update')?.value && field('update').value !== '0') ||
      !intro || !visible) {
    return { error: 'Moodle did not open the expected new assignment form.' };
  }

  const set = (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value === value;
  };

  const setDate = (name, date) => {
    const enabled = field(`${name}[enabled]`);
    if (!enabled) return false;
    if (enabled.checked !== Boolean(date)) enabled.click();
    if (enabled.checked !== Boolean(date)) return false;
    if (!date) return true;
    const parts = date.split(/[-T:]/).map(Number);
    return ['year', 'month', 'day', 'hour', 'minute'].every((part, index) => {
      const select = field(`${name}[${part}]`);
      const option = Array.from(select?.options ?? []).find(item => Number(item.value) === parts[index]);
      return option && set(select, option.value);
    });
  };
  if (!setDate('duedate', draft.due) || !setDate('cutoffdate', draft.cutoffEnabled ? draft.cutoff : '')) {
    return { error: 'Could not set the due date or cutoff in Moodle. Check the dates.' };
  }
  if (!set(visible, '0')) return { error: 'Could not set the assignment to Hidden in Moodle.' };
  set(title, draft.title.trim());

  // Build formatting from plain text, so generated markup stays literal.
  const container = document.createElement('div');
  for (const paragraph of draft.instructions.trim().split(/\n[ \t]*\n+/)) {
    const element = document.createElement('p');
    paragraph.split('\n').forEach((line, index) => {
      if (index) element.append(document.createElement('br'));
      element.append(document.createTextNode(line));
    });
    container.append(element);
  }
  const richText = field('introeditor[format]')?.value === '1';
  const content = richText ? container.innerHTML : draft.instructions.trim();
  set(intro, content);
  const editor = window.tinymce?.get(intro.id);
  if (editor?.initialized) {
    editor.setContent(content);
    editor.save();
  } else if (editor) {
    editor.on('init', () => {
      editor.setContent(content);
      editor.save();
    });
  }
  return { ok: true };
}

module.exports = { fillAssignment };
