const color = hex => ({ red: parseInt(hex.slice(0, 2), 16) / 255,
  green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 });
const themes = new Map([
  ['studio', { paper: 'F6F1E8', ink: '302823', dark: '342A26', accent: 'A74B32', panel: 'E9DED1', light: 'F2B79B', display: 'Georgia' }],
  ['blueprint', { paper: 'EFF4F8', ink: '192E42', dark: '172B40', accent: '285C96', panel: 'DCE8F3', light: 'A9D3FC', display: 'Arial' }],
  ['fieldwork', { paper: 'F2F2E8', ink: '29372C', dark: '25382E', accent: '46684D', panel: 'DFE8D9', light: 'C2DBAA', display: 'Georgia' }],
]);
const imageIds = slide => slide.imageIds ?? (slide.imageId ? [slide.imageId] : []);
const slideImages = (plan, slide) => imageIds(slide).map(id => plan.images.find(image => image.id === id)).filter(Boolean);

function fitFont(paragraphs, width, height, maximum, minimum) {
  for (let size = maximum; size >= minimum; size -= 2) {
    const charactersPerLine = Math.max(1, Math.floor((width - 16) / (size * 0.58)));
    const lines = paragraphs.reduce((count, paragraph) => count + Math.ceil(paragraph.length / charactersPerLine), 0);
    if (lines * size * 1.25 + paragraphs.length * 14 <= height - 12) return size;
  }
  return minimum;
}

function deckPages(plan) {
  const pages = plan.slides.map(slide => ({ ...slide }));
  const credits = [
    ...plan.sources.map((source, index) => ({ label: `[${index + 1}] ${source.title}`, url: source.url })),
    ...plan.images.filter(image => pages.some(slide => imageIds(slide).includes(image.id))).map(image =>
      ({ label: `${image.title.slice(0, 110)} — ${(image.artist || 'See source for artist').slice(0, 100)}, ${image.license}`,
        url: image.pageUrl })),
  ];
  for (let index = 0; index < credits.length; index += 3) {
    const links = credits.slice(index, index + 3);
    pages.push({ title: index ? 'Sources and image credits, continued' : 'Sources and image credits',
      bullets: links.map(link => link.label), links, notes: links.map(link => link.label + '\n' + link.url).join('\n\n'), references: true,
      sourceIds: [], imageId: null });
  }
  return pages;
}

function buildSlideRequests(plan, width, height, includeImages) {
  const pages = deckPages(plan);
  const requests = [];
  const scale = Math.min(width / 960, height / 540);
  const theme = themes.get(plan.theme) ?? themes.get('studio');
  const sourceNumbers = new Map(plan.sources.map((source, index) => [source.id, index + 1]));
  const position = (pageId, x, y, w, h) => ({
    pageObjectId: pageId,
    size: { width: { magnitude: w * scale, unit: 'PT' }, height: { magnitude: h * scale, unit: 'PT' } },
    transform: { scaleX: 1, scaleY: 1, translateX: x * scale, translateY: y * scale, unit: 'PT' },
  });
  function panel(pageId, name, x, y, w, h, fill) {
    const objectId = pageId + '_' + name;
    requests.push(
      { createShape: { objectId, shapeType: 'RECTANGLE', elementProperties: position(pageId, x, y, w, h) } },
      { updateShapeProperties: { objectId, shapeProperties: {
        shapeBackgroundFill: { solidFill: { color: { rgbColor: color(fill) }, alpha: 1 } },
        outline: { propertyState: 'NOT_RENDERED' },
      }, fields: 'shapeBackgroundFill,outline' } },
    );
  }
  function box(pageId, name, value, x, y, w, h, size, ink, bold = false, fontFamily = 'Arial') {
    if (!value) return;
    const id = pageId + '_' + name;
    requests.push(
      { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: position(pageId, x, y, w, h) } },
      { insertText: { objectId: id, text: value, insertionIndex: 0 } },
      { updateTextStyle: { objectId: id, textRange: { type: 'ALL' },
        style: { fontFamily, fontSize: { magnitude: size * scale, unit: 'PT' }, bold,
          foregroundColor: { opaqueColor: { rgbColor: color(ink) } } },
        fields: 'fontFamily,fontSize,bold,foregroundColor' } },
      { updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' },
        style: { spaceAbove: { magnitude: 0, unit: 'PT' }, spaceBelow: { magnitude: (size <= 12 ? 0 : 14) * scale, unit: 'PT' } },
        fields: 'spaceAbove,spaceBelow' } },
    );
  }
  function media(pageId, images, x, y, width, height, columns) {
    const gap = 12;
    const rows = Math.ceil(images.length / columns);
    const cellWidth = (width - (columns - 1) * gap) / columns;
    const cellHeight = (height - (rows - 1) * gap) / rows;
    images.forEach((image, index) => {
      const left = x + (index % columns) * (cellWidth + gap);
      const top = y + Math.floor(index / columns) * (cellHeight + gap);
      panel(pageId, 'mat_' + index, left, top, cellWidth, cellHeight, theme.panel);
      const fit = Math.min((cellWidth - 12) / image.width, (cellHeight - 12) / image.height);
      const w = image.width * fit;
      const h = image.height * fit;
      requests.push({ createImage: { objectId: pageId + '_image_' + index, url: image.url,
        elementProperties: position(pageId, left + (cellWidth - w) / 2, top + (cellHeight - h) / 2, w, h) } });
    });
  }
  pages.forEach((slide, index) => {
    const pageId = 'mb_slide_' + index;
    const cover = index === 0;
    const images = includeImages ? slideImages(plan, slide) : [];
    const gallery = images.length > 1 && slide.layout !== 'feature';
    const statement = !images.length && (cover || slide.layout === 'statement');
    const dark = cover || statement;
    const ink = dark ? theme.paper : theme.ink;
    const accent = dark ? theme.light : theme.accent;
    requests.push({ createSlide: { objectId: pageId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
      { updatePageProperties: { objectId: pageId, pageProperties: {
        pageBackgroundFill: { solidFill: { color: { rgbColor: color(dark ? theme.dark : theme.paper) }, alpha: 1 } },
      }, fields: 'pageBackgroundFill' } });
    panel(pageId, 'rule', 54, 34, 54, 5, accent);
    const titleWidth = cover && images.length && !gallery ? 420 : 850;
    const titleHeight = titleWidth === 420 ? 172 : 112;
    box(pageId, 'title', slide.title, 48, 50, titleWidth, titleHeight,
      fitFont([slide.title], titleWidth, titleHeight, cover ? 54 : 42, 24), ink, true, theme.display);
    if (slide.references) {
      slide.links.forEach((link, linkIndex) => {
        const name = 'reference_' + linkIndex;
        box(pageId, name, link.label, 55, 165 + linkIndex * 95, 845, 85,
          fitFont([link.label], 845, 85, 19, 13), ink);
        requests.push({ updateTextStyle: { objectId: pageId + '_' + name, textRange: { type: 'ALL' },
          style: { link: { url: link.url } }, fields: 'link' } });
      });
    } else if (gallery) {
      media(pageId, images, 54, 158, 852, slide.bullets.length ? 182 : 310, images.length);
      const columnWidth = 852 / Math.max(1, slide.bullets.length);
      slide.bullets.forEach((bullet, i) => {
        const left = 54 + i * columnWidth;
        panel(pageId, 'caption_rule_' + i, left, 356, 27, 3, accent);
        box(pageId, 'caption_' + i, bullet, left - 6, 365, columnWidth - 12, 116,
          fitFont([bullet], columnWidth - 12, 116, 21, 14), ink);
      });
    } else if (images.length) {
      const top = cover ? 221 : 170;
      box(pageId, 'body', slide.bullets.join('\n'), 48, top, 416, 477 - top,
        fitFont(slide.bullets, 416, 477 - top, 28, 16), ink);
      media(pageId, images, 496, cover ? 60 : 160, 410, cover ? 412 : 312, images.length > 2 ? 2 : 1);
    } else if (statement) {
      box(pageId, 'body', slide.bullets.join('\n'), 48, 181, 785, 290,
        fitFont(slide.bullets, 785, 290, 33, 19), ink, false, theme.display);
    } else {
      const rowHeight = 288 / Math.max(1, slide.bullets.length);
      slide.bullets.forEach((bullet, i) => {
        const top = 163 + i * rowHeight;
        panel(pageId, 'point_' + i, 54, top, 852, rowHeight - 9, theme.panel);
        panel(pageId, 'point_rule_' + i, 54, top, 4, rowHeight - 9, accent);
        box(pageId, 'body_' + i, bullet, 70, top + 9, 814, rowHeight - 18,
          fitFont([bullet], 814, rowHeight - 18, 28, 15), ink);
      });
    }
    const citations = slide.sourceIds.map(id => '[' + sourceNumbers.get(id) + ']').join(' ');
    panel(pageId, 'footer_rule', 54, 486, 852, 1, accent);
    box(pageId, 'footer', `${citations}${citations ? '   ·   ' : ''}${index + 1} / ${pages.length}`,
      48, 495, 850, 25, 11, accent);
  });
  return requests;
}

function noteRequests(plan, presentation) {
  const pages = deckPages(plan);
  return pages.flatMap((slide, index) => {
    const page = presentation.slides.find(item => item.objectId === 'mb_slide_' + index);
    const notesPage = page?.slideProperties?.notesPage;
    const id = notesPage?.notesProperties?.speakerNotesObjectId;
    if (!id) return [];
    const sources = plan.sources.filter(source => slide.sourceIds.includes(source.id))
      .map(source => source.title + '\n' + source.url);
    const credits = slideImages(plan, slide).map(image =>
      `Image: ${image.title}\n${image.artist}\n${image.license}\n${image.pageUrl}\n${image.licenseUrl}`);
    const value = [slide.notes, ...sources, ...credits].filter(Boolean).join('\n\n');
    const shape = notesPage.pageElements?.find(element => element.objectId === id)?.shape;
    const existing = (shape?.text?.textElements ?? []).map(element => element.textRun?.content ?? '').join('').replace(/\n$/, '');
    if (!value || existing === value) return [];
    const insert = { insertText: { objectId: id, text: value, insertionIndex: 0 } };
    return existing ? [{ deleteText: { objectId: id, textRange: { type: 'ALL' } } }, insert] : [insert];
  });
}

module.exports = { deckPages, buildSlideRequests, noteRequests };
