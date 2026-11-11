const color = hex => ({ red: parseInt(hex.slice(0, 2), 16) / 255,
  green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 });

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
    ...plan.images.filter(image => pages.some(slide => slide.imageId === image.id)).map(image =>
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
  const sourceNumbers = new Map(plan.sources.map((source, index) => [source.id, index + 1]));
  function box(pageId, name, value, x, y, w, h, size, ink, bold = false) {
    if (!value) return;
    const id = pageId + '_' + name;
    requests.push(
      { createShape: { objectId: id, shapeType: 'TEXT_BOX', elementProperties: { pageObjectId: pageId,
        size: { width: { magnitude: w * scale, unit: 'PT' }, height: { magnitude: h * scale, unit: 'PT' } },
        transform: { scaleX: 1, scaleY: 1, translateX: x * scale, translateY: y * scale, unit: 'PT' } } } },
      { insertText: { objectId: id, text: value, insertionIndex: 0 } },
      { updateTextStyle: { objectId: id, textRange: { type: 'ALL' },
        style: { fontFamily: 'Arial', fontSize: { magnitude: size * scale, unit: 'PT' }, bold,
          foregroundColor: { opaqueColor: { rgbColor: color(ink) } } },
        fields: 'fontFamily,fontSize,bold,foregroundColor' } },
      { updateParagraphStyle: { objectId: id, textRange: { type: 'ALL' },
        style: { spaceAbove: { magnitude: 0, unit: 'PT' }, spaceBelow: { magnitude: (size <= 12 ? 0 : 14) * scale, unit: 'PT' } },
        fields: 'spaceAbove,spaceBelow' } },
    );
  }
  pages.forEach((slide, index) => {
    const pageId = 'mb_slide_' + index;
    const cover = index === 0;
    const image = includeImages && plan.images.find(item => item.id === slide.imageId);
    const ink = cover ? 'F6F5EF' : '203C3F';
    requests.push({ createSlide: { objectId: pageId, slideLayoutReference: { predefinedLayout: 'BLANK' } } },
      { updatePageProperties: { objectId: pageId, pageProperties: {
        pageBackgroundFill: { solidFill: { color: { rgbColor: color(cover ? '203C3F' : 'F6F5EF') }, alpha: 1 } },
      }, fields: 'pageBackgroundFill' } });
    box(pageId, 'title', slide.title, 55, 45, 850, 110, fitFont([slide.title], 850, 110, cover ? 43 : 36, 27), ink, true);
    if (slide.references) {
      slide.links.forEach((link, linkIndex) => {
        const name = 'reference_' + linkIndex;
        box(pageId, name, link.label, 55, 165 + linkIndex * 95, 845, 85,
          fitFont([link.label], 845, 85, 19, 13), ink);
        requests.push({ updateTextStyle: { objectId: pageId + '_' + name, textRange: { type: 'ALL' },
          style: { link: { url: link.url } }, fields: 'link' } });
      });
    } else {
      const bodyWidth = image ? 455 : 845;
      box(pageId, 'body', slide.bullets.join('\n'), 55, 165, bodyWidth, 285,
        fitFont(slide.bullets, bodyWidth, 285, 26, 16), ink);
    }
    if (image) {
      const fit = Math.min(345 / image.width, 270 / image.height);
      const w = image.width * fit;
      const h = image.height * fit;
      requests.push({ createImage: { objectId: pageId + '_image', url: image.url,
        elementProperties: { pageObjectId: pageId,
          size: { width: { magnitude: w * scale, unit: 'PT' }, height: { magnitude: h * scale, unit: 'PT' } },
          transform: { scaleX: 1, scaleY: 1, translateX: (555 + (345 - w) / 2) * scale,
            translateY: (165 + (270 - h) / 2) * scale, unit: 'PT' } } } });
      box(pageId, 'credit', `${(image.artist || 'Wikimedia Commons').slice(0, 45)} · ${image.license}`,
        550, 445, 350, 38, 11, cover ? 'CDDAD7' : '536766');
    }
    const citations = slide.sourceIds.map(id => '[' + sourceNumbers.get(id) + ']').join(' ');
    box(pageId, 'footer', `${citations}${citations ? '   ·   ' : ''}${index + 1} / ${pages.length}`,
      55, 492, 850, 25, 12, cover ? 'CDDAD7' : '536766');
  });
  return requests;
}

function noteRequests(plan, presentation) {
  const pages = deckPages(plan);
  return pages.flatMap((slide, index) => {
    const page = presentation.slides.find(item => item.objectId === 'mb_slide_' + index);
    const id = page?.slideProperties?.notesPage?.notesProperties?.speakerNotesObjectId;
    if (!id) return [];
    const sources = plan.sources.filter(source => slide.sourceIds.includes(source.id))
      .map(source => source.title + '\n' + source.url);
    const image = plan.images.find(item => item.id === slide.imageId);
    const credit = image ? `Image: ${image.title}\n${image.artist}\n${image.license}\n${image.pageUrl}\n${image.licenseUrl}` : '';
    const value = [slide.notes, ...sources, credit].filter(Boolean).join('\n\n');
    return value ? [{ deleteText: { objectId: id, textRange: { type: 'ALL' } } },
      { insertText: { objectId: id, text: value, insertionIndex: 0 } }] : [];
  });
}

module.exports = { deckPages, buildSlideRequests, noteRequests };
