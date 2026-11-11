function slidePreview(scene, decorative = false) {
  const preview = node('div', 'review-slide');
  if (decorative) preview.setAttribute('aria-hidden', 'true');
  if (!scene) return preview;
  preview.style.backgroundColor = '#' + scene.fill;
  for (const layer of scene.layers) {
    const element = node(layer.type === 'image' ? 'img' : 'div', 'review-layer');
    element.style.left = layer.x / 9.6 + '%';
    element.style.top = layer.y / 5.4 + '%';
    element.style.width = layer.w / 9.6 + '%';
    element.style.height = layer.h / 5.4 + '%';
    if (layer.type === 'panel') element.style.backgroundColor = '#' + layer.fill;
    if (layer.type === 'text') {
      element.classList.add('review-layer-text');
      element.textContent = layer.value;
      element.style.font = (layer.bold ? '700 ' : '400 ') + layer.size / 9.6 + 'cqw/1.25 ' + layer.fontFamily;
      element.style.color = '#' + layer.ink;
    }
    if (layer.type === 'image') {
      element.src = layer.url;
      element.alt = decorative ? '' : layer.title;
      element.loading = decorative ? 'lazy' : 'eager';
      element.referrerPolicy = 'no-referrer';
      element.style.objectFit = layer.crop ? 'cover' : 'contain';
    }
    preview.append(element);
  }
  return preview;
}

async function openPresentationReview(original, { use, saveSettings, onClose, onExport }) {
  const dialog = el('presentation-review');
  const api = window.workspace.presentations;
  let { plan, previews } = await use(api.review(original.id, original.includeImages !== false));
  let selected = 0;
  let proposal;
  let proposalIndex;
  let editing = false;
  let swapping = false;
  let searchResults;
  let dragging;
  let busy = false;
  let exporting = false;
  const includeImages = () => original.includeImages !== false;
  const status = node('p', 'review-status');
  status.setAttribute('role', 'status');
  const heading = node('div', 'review-heading');
  const title = node('h2', '', plan.title);
  title.id = 'presentation-review-title';
  const close = button('Close', 'secondary', () => dialog.close());
  const exportButton = button(plan.deck ? 'Open in Google Slides' : 'Create in Google Slides', 'primary', () => {
    exporting = true;
    dialog.close();
  });
  const toggleLabel = node('label', 'theme-toggle');
  const include = node('input');
  include.type = 'checkbox';
  include.checked = includeImages();
  toggleLabel.hidden = Boolean(plan.deck);
  toggleLabel.append(include, document.createTextNode('Include images'));
  const headingActions = node('div', 'review-actions');
  headingActions.append(toggleLabel, exportButton, close);
  heading.append(title, headingActions);
  const rail = node('nav', 'review-rail');
  rail.setAttribute('aria-label', 'Slides');
  const work = node('div', 'review-work');
  const body = node('div', 'review-body');
  body.append(rail, work);
  dialog.replaceChildren(heading, status, body);

  function acceptView(view) {
    ({ plan, previews } = view);
    Object.assign(original, plan);
    selected = Math.min(selected, plan.slides.length - 1);
    title.textContent = plan.title;
  }

  async function perform(action, message) {
    if (busy) return;
    busy = true;
    body.inert = true;
    close.disabled = exportButton.disabled = include.disabled = true;
    status.textContent = message ?? '';
    status.dataset.error = 'false';
    try {
      await action();
      status.textContent = '';
    } catch (error) {
      status.dataset.error = 'true';
      status.textContent = error.message;
    } finally {
      busy = false;
      body.inert = false;
      close.disabled = false;
      exportButton.disabled = include.disabled = Boolean(proposal);
    }
  }

  async function update(operation) {
    acceptView(await use(api.update(plan.id, plan.revision, operation, includeImages())));
  }

  function pick(index) {
    selected = index;
    editing = swapping = false;
    searchResults = undefined;
    render();
    rail.querySelector('[aria-current="true"]')?.focus();
  }

  function move(from, to) {
    if (from === to || !plan.slides[to]) return;
    perform(async () => {
      await update({ type: 'move', from, to });
      pick(to);
    });
  }

  function renderRail() {
    const list = proposal && proposalIndex === null ? proposal.plan.slides : plan.slides;
    const scenes = proposal && proposalIndex === null ? proposal.previews : previews;
    rail.replaceChildren(...list.map((slide, index) => {
      const thumb = button('', 'review-thumb', () => pick(index));
      const label = (index + 1) + '. ' + slide.title;
      thumb.append(slidePreview(scenes[index], true), node('span', '', label));
      thumb.setAttribute('aria-label', label);
      if (index === selected) thumb.setAttribute('aria-current', 'true');
      thumb.disabled = Boolean(proposal && proposalIndex !== null && index !== proposalIndex);
      if (!plan.deck && !proposal) {
        thumb.draggable = true;
        thumb.addEventListener('dragstart', event => {
          dragging = index;
          event.dataTransfer.setData('text/plain', String(index));
          event.dataTransfer.effectAllowed = 'move';
        });
        thumb.addEventListener('dragend', () => { dragging = undefined; });
        thumb.addEventListener('dragover', event => { if (dragging !== undefined) event.preventDefault(); });
        thumb.addEventListener('drop', event => {
          if (dragging === undefined) return;
          event.preventDefault();
          move(dragging, index);
        });
      }
      return thumb;
    }));
  }

  function field(label, input) {
    const wrapper = node('label', 'review-field', label);
    wrapper.append(input);
    return wrapper;
  }

  function editPanel(slide) {
    const section = node('section', 'review-panel');
    const slideTitle = node('input');
    slideTitle.value = slide.title;
    slideTitle.maxLength = 100;
    const lines = node('textarea');
    lines.rows = 3;
    lines.value = slide.bullets.join('\n');
    const notes = node('textarea');
    notes.rows = 3;
    notes.maxLength = 1000;
    notes.value = slide.notes;
    const layout = node('select');
    for (const [value, label] of [
      ['', 'Automatic'], ['feature', 'Feature'], ['gallery', 'Gallery'], ['comparison', 'Side-by-side comparison'],
      ['detail', 'Detail with callouts'], ['process', 'Process sequence'], ['statement', 'Text statement'],
    ]) {
      const option = node('option', '', label);
      option.value = value;
      layout.append(option);
    }
    layout.value = slide.layout ?? '';
    const save = button('Apply slide edits', 'primary', () => perform(async () => {
      const bullets = lines.value.split('\n').map(line => line.trim()).filter(Boolean);
      if (bullets.length > 3 || bullets.some(line => line.length > 150)) throw new Error('Use up to three lines of 150 characters each.');
      await update({ type: 'edit', index: selected,
        slide: { ...slide, title: slideTitle.value, bullets, notes: notes.value, layout: layout.value } });
      editing = false;
      render();
      work.querySelector('.review-edit')?.focus();
    }));
    section.append(field('Slide title', slideTitle), field('Slide text · one line per point', lines),
      field('Speaker notes', notes), field('Layout', layout), save);
    return section;
  }

  function imagePanel(slide) {
    const section = node('section', 'review-panel');
    const query = node('input');
    query.value = slide.title;
    query.maxLength = 160;
    const find = button('Find alternatives', 'secondary', () => perform(async () => {
      searchResults = await use(api.findImages(plan.id, plan.revision, selected, query.value));
      if (!searchResults.length) throw new Error('No images found. Try a more specific subject or viewpoint.');
      section.replaceChild(candidates(), section.lastElementChild);
    }, 'Finding alternatives for this slide…'));
    const slot = node('select');
    const capacity = { comparison: 2, process: 3, statement: 0 }[slide.layout] ?? 4;
    const used = slide.imageIds.slice(0, capacity);
    for (let index = 0; index <= used.length && index < capacity; index++) {
      const image = plan.images.find(item => item.id === used[index]);
      const option = node('option', '', image ? (index + 1) + '. ' + image.title : 'Add image');
      option.value = String(index);
      slot.append(option);
    }
    const remove = button('Remove image', 'secondary', () => perform(async () => {
      const index = Number(slot.value);
      if (!used[index]) throw new Error('Select an image to remove.');
      await update({ type: 'edit', index: selected, slide: { ...slide, imageIds: used.filter((_id, i) => i !== index) } });
      render();
    }));
    const syncSlot = () => { remove.disabled = !used[Number(slot.value)]; };
    syncSlot();
    slot.addEventListener('change', syncSlot);

    function candidates() {
      const gallery = node('div', 'review-candidates');
      const images = (searchResults ?? plan.images).filter(image => !used.includes(image.id)).slice(0, 9);
      if (!images.length) gallery.append(node('p', '', 'Search for more images for this slide.'));
      for (const image of images) {
        const card = node('div', 'review-candidate');
        const picture = node('img');
        picture.alt = image.title;
        picture.referrerPolicy = 'no-referrer';
        const cropped = ['comparison', 'process'].includes(slide.layout);
        const imageLayer = previews[selected]?.layers.find(layer => layer.type === 'image' && layer.crop);
        picture.style.objectFit = cropped ? 'cover' : 'contain';
        if (cropped) picture.style.aspectRatio = imageLayer ? imageLayer.w / imageLayer.h :
          slide.layout === 'process' ? '276 / 230' : '420 / 230';
        const quality = node('small', '', image.license);
        const select = button('Use image', 'row-button', () => perform(async () => {
          const imageIds = [...used];
          imageIds[Number(slot.value)] = image.id;
          await update({ type: 'edit', index: selected, slide: { ...slide, imageIds },
            dimensions: { id: image.id, width: picture.naturalWidth, height: picture.naturalHeight } });
          swapping = false;
          searchResults = undefined;
          render();
        }));
        select.disabled = true;
        picture.addEventListener('load', () => {
          const width = picture.naturalWidth;
          const height = picture.naturalHeight;
          const oversized = width * height > 25_000_000;
          select.disabled = oversized;
          quality.textContent = width + ' × ' + height + ' px' +
            (oversized ? ' · Too large for Google Slides' : width < 600 || height < 320 ? ' · Low resolution' : '') +
            ' · ' + image.license;
        });
        picture.addEventListener('error', () => { quality.textContent = 'Image unavailable'; });
        picture.src = image.url;
        const source = button('Source', 'text-button', () => perform(() => use(api.open(plan.id, 'image', image.id))));
        const actions = node('div', 'review-actions');
        actions.append(select, source);
        card.append(picture, node('p', '', image.title), quality, actions);
        gallery.append(card);
      }
      return gallery;
    }

    const search = node('div', 'review-actions');
    search.append(field('Image search', query), find);
    section.append(search, field('Image slot', slot), remove, candidates());
    return section;
  }

  function render() {
    renderRail();
    const slide = plan.slides[selected];
    const display = node('div', proposal ? 'review-compare' : 'review-preview');
    const current = node('div');
    if (proposal) current.append(node('h3', '', 'Current'));
    current.append(previews[selected] ? slidePreview(previews[selected]) : node('p', '', 'New slide'));
    display.append(current);
    work.replaceChildren(display);
    if (proposal) {
      const next = node('div');
      const candidate = proposalIndex === null ? proposal.previews[selected] : proposal.previews[proposalIndex];
      next.append(node('h3', '', 'Proposed'));
      if (candidate) next.append(slidePreview(candidate));
      display.append(next);
      const actions = node('div', 'review-actions');
      actions.append(
        button('Keep current', 'secondary', () => { proposal = undefined; selected = Math.min(selected, plan.slides.length - 1); exportButton.disabled = include.disabled = false; render(); }),
        button(proposalIndex === null ? 'Apply deck revision' : 'Apply slide revision', 'primary', () => perform(async () => {
          await update({ type: 'accept', token: proposal.token });
          proposal = undefined;
          render();
        })),
      );
      work.append(actions);
      return;
    }
    if (plan.deck || !slide) return;
    const actions = node('div', 'review-actions');
    const edit = button(editing ? 'Close text editor' : 'Edit text & layout', 'secondary review-edit', () => {
      editing = !editing;
      swapping = false;
      render();
      work.querySelector(editing ? '.review-panel input' : '.review-edit')?.focus();
    });
    const swap = button(swapping ? 'Close image search' : 'Swap or add image', 'secondary review-swap', () => {
      swapping = !swapping;
      editing = false;
      render();
      work.querySelector(swapping ? '.review-panel input' : '.review-swap')?.focus();
    });
    swap.disabled = slide.layout === 'statement' || !includeImages();
    const earlier = button('Move earlier', 'row-button', () => move(selected, selected - 1));
    const later = button('Move later', 'row-button', () => move(selected, selected + 1));
    earlier.disabled = selected === 0;
    later.disabled = selected === plan.slides.length - 1;
    actions.append(edit, swap, earlier, later);
    work.append(actions);
    if (editing) work.append(editPanel(slide));
    if (swapping) work.append(imagePanel(slide));
    const instruction = node('textarea');
    instruction.rows = 2;
    instruction.maxLength = 3000;
    instruction.placeholder = 'Compare two views of the handle and explain where the grip changes…';
    const revisions = node('div', 'review-panel');
    const revisionActions = node('div', 'review-actions');
    const revise = index => perform(async () => {
      if (!instruction.value.trim()) throw new Error('Describe what you want to change.');
      await saveSettings();
      proposal = await use(api.revise(plan.id, plan.revision, index, instruction.value, includeImages()));
      proposalIndex = index;
      render();
    }, index === null ? 'Revising the deck…' : 'Revising this slide…');
    revisionActions.append(button('Revise this slide', 'primary', () => revise(selected)),
      button('Revise whole deck', 'secondary', () => revise(null)));
    revisions.append(field('Ask MoodleBOSS to revise', instruction), revisionActions);
    work.append(revisions);
  }

  include.addEventListener('change', () => perform(async () => {
    try {
      acceptView(await use(api.review(plan.id, include.checked)));
      original.includeImages = include.checked;
      swapping = false;
      render();
    } catch (error) {
      include.checked = includeImages();
      throw error;
    }
  }));
  const preventCancel = event => { if (busy) event.preventDefault(); };
  dialog.addEventListener('cancel', preventCancel);
  dialog.addEventListener('close', () => {
    dialog.removeEventListener('cancel', preventCancel);
    dialog.replaceChildren();
    onClose();
    if (exporting) onExport();
  }, { once: true });
  render();
  dialog.showModal();
}
