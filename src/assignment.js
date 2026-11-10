const assignmentDialog = el('manage-assignment');
const assignmentStatus = el('manage-assignment-status');
const assignmentOperations = el('assignment-operations');
const assignmentConfirmation = el('assignment-delete-confirmation');
const visibilityButton = el('toggle-assignment-visibility');
let managedAssignment;
let managedSettings;
let changingAssignment = false;

function assignmentMessage(text, error = false) {
  assignmentStatus.textContent = text;
  assignmentStatus.dataset.error = String(error);
}

function renderAssignmentSettings(settings) {
  managedSettings = settings;
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
