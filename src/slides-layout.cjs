const color = hex => ({ red: parseInt(hex.slice(0, 2), 16) / 255,
  green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 });
const themes = new Map([
  ['studio', { paper: 'F6F1E8', ink: '302823', dark: '342A26', accent: 'A74B32', panel: 'E9DED1', light: 'F2B79B', display: 'Georgia' }],
  ['blueprint', { paper: 'EFF4F8', ink: '192E42', dark: '172B40', accent: '285C96', panel: 'DCE8F3', light: 'A9D3FC', display: 'Arial' }],
  ['fieldwork', { paper: 'F2F2E8', ink: '29372C', dark: '25382E', accent: '46684D', panel: 'DFE8D9', light: 'C2DBAA', display: 'Georgia' }],
]);
const imageIds = slide => slide.imageIds ?? (slide.imageId ? [slide.imageId] : []);
function slideImages(plan, slide) {
  const limit = { statement: 0, comparison: 2, process: 3 }[slide.layout] ?? 4;
  return imageIds(slide).slice(0, limit).map(id => plan.images.find(image => image.id === id)).filter(Boolean);
}

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
    ...plan.sources.map((source, index) => ({ label: `[${index + 1}] ${source.title.slice(0, 220)}`, url: source.url })),
    ...plan.images.filter(image => pages.some(slide => slideImages(plan, slide).includes(image))).map(image =>
      ({ label: `${image.title.slice(0, 110)} — ${(image.artist || 'See source for artist').slice(0, 100)}, ${image.license}`,
        url: image.pageUrl })),
  ];
  let referencePage;
  let y = 76;
  for (const credit of credits) {
    const label = credit.label.replace(/\s+/g, ' ').trim();
    const h = 18 * Math.max(1, Math.ceil(label.length / 94)) + 4;
    if (!referencePage || y + h > 481) {
      referencePage = { title: referencePage ? 'Sources and image credits, continued' : 'Sources and image credits',
        bullets: [], links: [], notes: '', references: true, sourceIds: [], imageId: null };
      pages.push(referencePage);
      y = 76;
    }
    referencePage.links.push({ ...credit, label, y, h });
    referencePage.notes += (referencePage.notes ? '\n\n' : '') + label + '\n' + credit.url;
    y += h;
  }
  return pages;
}

function buildSlideRequests(plan, width, height, includeImages, previews) {
  const pages = deckPages(plan);
  const requests = [];
  const scale = Math.min(width / 960, height / 540);
  const theme = themes.get(plan.theme) ?? themes.get('studio');
  const sourceNumbers = new Map(plan.sources.map((source, index) => [source.id, index + 1]));
  let preview;
  const position = (pageId, x, y, w, h) => ({
    pageObjectId: pageId,
    size: { width: { magnitude: w * scale, unit: 'PT' }, height: { magnitude: h * scale, unit: 'PT' } },
    transform: { scaleX: 1, scaleY: 1, translateX: x * scale, translateY: y * scale, unit: 'PT' },
  });
  function panel(pageId, name, x, y, w, h, fill) {
    preview?.layers.push({ type: 'panel', x, y, w, h, fill });
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
    preview?.layers.push({ type: 'text', x, y, w, h, value, size, ink, bold, fontFamily });
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
  function media(pageId, images, x, y, width, height, columns, crop = false) {
    const gap = 12;
    const rows = Math.ceil(images.length / columns);
    const cellWidth = (width - (columns - 1) * gap) / columns;
    const cellHeight = (height - (rows - 1) * gap) / rows;
    images.forEach((image, index) => {
      const left = x + (index % columns) * (cellWidth + gap);
      const top = y + Math.floor(index / columns) * (cellHeight + gap);
      panel(pageId, 'mat_' + index, left, top, cellWidth, cellHeight, theme.panel);
      if (crop) {
        const objectId = pageId + '_mat_' + index;
        const marker = '[' + objectId + ']';
        requests.push({ insertText: { objectId, text: marker } },
          { replaceAllShapesWithImage: { containsText: { text: marker, matchCase: true }, pageObjectIds: [pageId],
            imageUrl: image.url, imageReplaceMethod: 'CENTER_CROP' } });
        preview?.layers.push({ type: 'image', x: left, y: top, w: cellWidth, h: cellHeight,
          url: image.url, title: image.title, crop: true });
        return;
      }
      const fit = Math.min((cellWidth - 12) / image.width, (cellHeight - 12) / image.height);
      const w = image.width * fit;
      const h = image.height * fit;
      preview?.layers.push({ type: 'image', x: left + (cellWidth - w) / 2, y: top + (cellHeight - h) / 2,
        w, h, url: image.url, title: image.title });
      requests.push({ createImage: { objectId: pageId + '_image_' + index, url: image.url,
        elementProperties: position(pageId, left + (cellWidth - w) / 2, top + (cellHeight - h) / 2, w, h) } });
    });
  }
  pages.forEach((slide, index) => {
    const pageId = 'mb_slide_' + index;
    const cover = index === 0;
    const images = includeImages && slide.layout !== 'statement' ? slideImages(plan, slide) : [];
    const detail = images.length && slide.layout === 'detail';
    const paired = images.length > 1 && ['comparison', 'process'].includes(slide.layout);
    const gallery = images.length > 1 && !detail && slide.layout !== 'feature';
    const statement = !images.length && (cover || slide.layout === 'statement');
    const dark = cover || statement;
    const ink = dark ? theme.paper : theme.ink;
    const accent = dark ? theme.light : theme.accent;
    const fill = dark ? theme.dark : theme.paper;
    preview = previews && { title: slide.title, fill, layers: [] };
    if (previews) previews.push(preview);
    requests.push({ createSlide: { objectId: pageId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
      { updatePageProperties: { objectId: pageId, pageProperties: {
        pageBackgroundFill: { solidFill: { color: { rgbColor: color(fill) }, alpha: 1 } },
      }, fields: 'pageBackgroundFill' } });
    panel(pageId, 'rule', 54, 34, 54, 5, accent);
    const titleWidth = cover && images.length && !gallery && !detail ? 420 : 850;
    const titleHeight = titleWidth === 420 ? 172 : 112;
    box(pageId, 'title', slide.title, 48, 50, titleWidth, slide.references ? 24 : titleHeight,
      slide.references ? 10 / scale : fitFont([slide.title], titleWidth, titleHeight, cover ? 54 : 42, 24), ink, true, theme.display);
    if (slide.references) {
      slide.links.forEach((link, linkIndex) => {
        const name = 'reference_' + linkIndex;
        box(pageId, name, link.label, 48, link.y, 858, link.h, 10 / scale, ink);
        requests.push({ updateTextStyle: { objectId: pageId + '_' + name, textRange: { type: 'ALL' },
          style: { link: { url: link.url } }, fields: 'link' } });
      });
    } else if (paired) {
      const count = slide.layout === 'comparison' ? 2 : Math.min(3, images.length);
      const columnWidth = (852 - 12 * (count - 1)) / count;
      media(pageId, images.slice(0, count), 54, 156, 852, 230, count, true);
      slide.bullets.slice(0, count).forEach((bullet, i) => {
        const x = 54 + i * (columnWidth + 12);
        const label = slide.layout === 'process' ? `${i + 1}. ${bullet}` : bullet;
        box(pageId, 'caption_' + i, label, x - 5, 395, columnWidth, 82,
          fitFont([label], columnWidth, 82, 22, 15), ink, true);
      });
    } else if (detail) {
      const mediaWidth = slide.bullets.length ? 545 : 852;
      media(pageId, images, 54, 156, mediaWidth, 317, images.length > 2 ? 2 : 1);
      const row = 310 / Math.max(1, slide.bullets.length);
      slide.bullets.forEach((bullet, i) => {
        const y = 156 + i * row;
        panel(pageId, 'detail_rule_' + i, 624, y + 6, 30, 3, accent);
        box(pageId, 'detail_' + i, bullet, 618, y + 14, 286, row - 16,
          fitFont([bullet], 286, row - 16, 22, 15), ink);
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
      48, 495, 850, 25, slide.references ? 10 / scale : 11, accent);
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

function slidePreviews(plan, includeImages) {
  const previews = [];
  buildSlideRequests(plan, 960, 540, includeImages, previews);
  return previews.slice(0, plan.slides.length);
}

module.exports = { deckPages, buildSlideRequests, noteRequests, slidePreviews };
