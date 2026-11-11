const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSlideRequests, deckPages, slidePreviews } = require('../src/slides-layout.cjs');

test('Comparison preview uses the same crops and caption order as the editable export', () => {
  const images = Array.from({ length: 3 }, (_, i) => ({
    id: 'image_' + i, title: 'Image ' + i, width: 1200, height: 700,
    url: 'https://upload.wikimedia.org/fixture_' + i + '.jpg', pageUrl: 'https://commons.wikimedia.org/wiki/Fixture_' + i,
    license: 'CC BY 4.0',
  }));
  const comparison = { title: 'Handle comparison', bullets: ['Flat grip', 'Angled grip'], notes: '', sourceIds: [],
    imageIds: images.map(image => image.id), layout: 'comparison' };
  const plan = { slides: [comparison], images, sources: [], theme: 'studio' };
  const [preview] = slidePreviews(plan, true);
  const cropLayers = preview.layers.filter(layer => layer.type === 'image');
  assert.equal(cropLayers.length, 2);
  assert.ok(cropLayers.every(layer => layer.crop));
  assert.equal(cropLayers[0].w, cropLayers[1].w);
  const requests = buildSlideRequests(plan, 960, 540, true);
  const crops = requests.flatMap(request => request.replaceAllShapesWithImage ? [request.replaceAllShapesWithImage] : []);
  assert.deepEqual(crops.map(crop => crop.imageUrl), cropLayers.map(layer => layer.url));
  assert.ok(crops.every(crop => crop.imageReplaceMethod === 'CENTER_CROP'));
  const captions = requests.flatMap(({ insertText }) => insertText?.objectId.includes('_caption_') ? [insertText.text] : []);
  assert.deepEqual(captions, comparison.bullets);
  assert.equal(deckPages(plan)[1].links.length, 2);
  assert.ok(slidePreviews(plan, false)[0].layers.every(layer => layer.type !== 'image'));
});

test('Reference slides consolidate linked credits at 10 points on a standard Google deck', () => {
  const sources = Array.from({ length: 12 }, (_, index) =>
    ({ id: 'source_' + index, title: 'Research publication ' + (index + 1), url: 'https://example.test/' + index }));
  const plan = { slides: [], images: [], sources, theme: 'studio' };
  const pages = deckPages(plan);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].links.length, sources.length);
  const requests = buildSlideRequests(plan, 720, 405, true);
  const sizes = requests.flatMap(request => request.updateTextStyle?.style.fontSize?.magnitude ?? []);
  assert.equal(sizes.length, sources.length + 2);
  assert.ok(sizes.every(size => size === 10));
  const links = requests.flatMap(request => request.updateTextStyle?.style.link?.url ?? []);
  assert.deepEqual(links, sources.map(source => source.url));
});
