const assignmentDialog = el('manage-assignment');
const assignmentStatus = el('manage-assignment-status');
const assignmentOperations = el('assignment-operations');
const assignmentConfirmation = el('assignment-delete-confirmation');
const visibilityButton = el('toggle-assignment-visibility');
let managedAssignment;
let managedSettings;
let changingAssignment = false;
const assignmentVisibility = new Map();
const pendingVisibility = new Set();

function updateAssignmentEye(control, id) {
  const state = assignmentVisibility.get(id);
  const action = state?.action;
  const title = action === 'show' ? 'Show to students' : action === 'hide' ? 'Hide from students' :
    state ? 'Visibility controls unavailable' : 'Toggle student visibility';
  control.title = title;
  control.setAttribute('aria-label', `${title} · ${control.dataset.assignmentTitle}`);
  control.disabled = pendingVisibility.has(id) || Boolean(state && !action);
  control.querySelector('.eye-slash').toggleAttribute('hidden', action !== 'show');
}

function updateAssignmentEyes(id) {
  document.querySelectorAll(`[data-assignment-eye="${id}"]`).forEach(control => updateAssignmentEye(control, id));
}

function assignmentEye(assignment) {
  const control = button('', 'assignment-eye', () => toggleAssignmentEye(assignment, control));
  control.dataset.assignmentEye = assignment.id;
  control.dataset.assignmentTitle = assignment.title;
  control.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.5"/><path class="eye-slash" d="M3 3l18 18" hidden/></svg>';
  updateAssignmentEye(control, assignment.id);
  return control;
}

async function toggleAssignmentEye(assignment, control) {
  const id = assignment.id;
  if (pendingVisibility.has(id) || changingAssignment) return;
  const target = environment;
  const scope = visibilityScope;
  const sidebar = Boolean(control.closest('.assignment-tree'));
  const feedback = el(sidebar ? 'course-visibility-feedback' : 'assignment-feedback');
  const stillCurrent = () => target === environment && scope === visibilityScope;
  const showFeedback = (message, error = false) => {
    feedback.textContent = message;
    feedback.dataset.error = String(error);
  };
  pendingVisibility.add(id);
  updateAssignmentEyes(id);
  showFeedback('Checking assignment visibility…');
  try {
    const current = await window.workspace.assignment.settings(id);
    if (!stillCurrent()) return;
    if (!current.ok) throw new Error(current.message);
    const { action, title } = current.value;
    const knownAction = assignmentVisibility.get(id)?.action;
    assignmentVisibility.set(id, current.value);
    if (!action) throw new Error('Your Moodle permissions limit availability controls.');
    if (knownAction && knownAction !== action) {
      showFeedback('Visibility changed in Moodle. Check the eye and click again.');
      return;
    }
    const result = await window.workspace.assignment.change(id, action, title);
    if (!stillCurrent()) return;
    if (!result.ok) throw new Error(result.message);
    assignmentVisibility.set(id, result.value);
    showFeedback(action === 'hide' ? 'Assignment hidden from students.' : 'Assignment set to Show. Course restrictions still apply.');
    await refreshAfterMoodleChange();
  } catch (error) {
    if (stillCurrent()) showFeedback(error.message, true);
  } finally {
    pendingVisibility.delete(id);
    updateAssignmentEyes(id);
    if (stillCurrent() && (document.activeElement === control || document.activeElement === document.body)) {
      const list = sidebar ? el('course-buttons') : el('assignments');
      list.querySelector(`[data-assignment-eye="${id}"]`)?.focus();
    }
  }
}

function assignmentMessage(text, error = false) {
  assignmentStatus.textContent = text;
  assignmentStatus.dataset.error = String(error);
}

function renderAssignmentSettings(settings) {
  managedSettings = settings;
  assignmentVisibility.set(managedAssignment.id, settings);
  updateAssignmentEyes(managedAssignment.id);
  el('manage-assignment-name').textContent = settings.title;
  el('manage-assignment-visibility').textContent = settings.visibility
    ? 'Moodle availability · ' + settings.visibility
    : 'Your Moodle permissions limit availability controls.';
  visibilityButton.hidden = !settings.action;
  visibilityButton.textContent = settings.action === 'hide' ? 'Hide from students' : 'Show to students';
  assignmentOperations.hidden = false;
}

async function openAssignmentControls(assignment) {
  managedAssignment = assignment;
  managedSettings = null;
  assignmentOperations.hidden = true;
  assignmentConfirmation.hidden = true;
  el('manage-assignment-name').textContent = assignment.title;
  el('manage-assignment-course').textContent = snapshot?.courses.find(course => course.id === assignment.courseId)?.title ?? '';
  el('manage-assignment-visibility').textContent = '';
  el('assignment-feedback').textContent = '';
  assignmentMessage('Checking Moodle settings…');
  assignmentDialog.showModal();
  try {
    const result = await window.workspace.assignment.settings(assignment.id);
    if (!assignmentDialog.open || managedAssignment !== assignment) return;
    if (!result.ok) throw new Error(result.message);
    renderAssignmentSettings(result.value);
    assignmentMessage('');
  } catch (error) {
    if (assignmentDialog.open && managedAssignment === assignment) assignmentMessage(error.message, true);
  }
}

async function runAssignmentAction(operation) {
  if (changingAssignment || !managedSettings) return;
  changingAssignment = true;
  const controls = assignmentDialog.querySelectorAll('button');
  controls.forEach(control => { control.disabled = true; });
  try {
    await operation();
  } catch (error) {
    assignmentMessage(error.message, true);
  } finally {
    changingAssignment = false;
    controls.forEach(control => { control.disabled = false; });
  }
}

el('close-assignment-controls').addEventListener('click', () => assignmentDialog.close());
assignmentDialog.addEventListener('cancel', event => {
  if (changingAssignment) event.preventDefault();
});
assignmentDialog.addEventListener('close', () => {
  const id = managedAssignment?.id;
  const trigger = document.querySelector(`[data-manage-assignment="${id}"]`);
  (trigger ?? el('title')).focus();
});
el('edit-assignment').addEventListener('click', () => runAssignmentAction(async () => {
  assignmentMessage('Opening Moodle’s edit form…');
  const result = await window.workspace.assignment.edit(managedAssignment.id);
  if (!result.ok) throw new Error(result.message);
  assignmentDialog.close();
}));
visibilityButton.addEventListener('click', () => runAssignmentAction(async () => {
  const action = managedSettings.action;
  if (!action) return;
  assignmentMessage('Updating visibility in Moodle…');
  const result = await window.workspace.assignment.change(managedAssignment.id, action, managedSettings.title);
  if (!result.ok) throw new Error(result.message);
  renderAssignmentSettings(result.value);
  await refreshAfterMoodleChange();
  assignmentMessage(action === 'hide' ? 'Assignment hidden from students.' : 'Moodle visibility updated. Course and section restrictions still apply.');
  visibilityButton.disabled = false;
  visibilityButton.focus();
}));
el('ask-delete-assignment').addEventListener('click', () => {
  assignmentConfirmation.hidden = false;
  assignmentOperations.hidden = true;
  assignmentMessage('');
  el('cancel-assignment-delete').focus();
});
el('cancel-assignment-delete').addEventListener('click', () => {
  assignmentConfirmation.hidden = true;
  assignmentOperations.hidden = false;
  el('ask-delete-assignment').focus();
});
el('confirm-assignment-delete').addEventListener('click', () => runAssignmentAction(async () => {
  assignmentMessage('Deleting assignment in Moodle…');
  const result = await window.workspace.assignment.change(managedAssignment.id, 'delete', managedSettings.title);
  if (!result.ok) throw new Error(result.message);
  await refreshAfterMoodleChange();
  el('assignment-feedback').textContent = `“${managedSettings.title}” was deleted from Moodle.`;
  assignmentDialog.close();
}));
