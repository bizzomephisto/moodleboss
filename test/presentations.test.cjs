const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { preparePresentation } = require('../src/presentation.cjs');
const { loadGoogle } = require('../src/google-slides.cjs');

test('research, images with different rights, OAuth return, and retrying a deck after a lost create response', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'moodleboss-slides-'));
  const originalFetch = global.fetch;
  let modelCalls = 0;
  let fileCreated = false;
  let fileCreates = 0;
  let loseCreateResponse = true;
  let slides = [];
  const batches = [];
  const authCalls = [];
  const saved = new Map();
  const storage = { available: true, read: async name => saved.get(name),
    write: async (name, value) => saved.set(name, value), remove: async name => saved.delete(name) };
  let verifierChallenge;
  global.fetch = async (value, options = {}) => {
    const url = new URL(value);
    if (url.hostname === '127.0.0.1') return originalFetch(value, options);
    if (url.hostname === 'model.test') {
      modelCalls++;
      const plan = modelCalls === 1 ? { queries: ['Ergonomics'], imageQueries: ['Chair'], slideCount: 3 } :
        { title: 'Ergonomics lesson', summary: 'A lesson using researched examples.', theme: 'blueprint', slides: [
          { title: 'Ergonomics', bullets: ['Design for a comfortable grip'], notes: 'Discuss grip.', sourceIds: ['source_1'],
            layout: 'gallery', imageIds: ['image_en_11', 'image_10', 'image_en_11', 'unknown'] },
          { title: 'Observe the user', bullets: ['Study posture'], notes: 'Observe an everyday task.', sourceIds: ['source_1'], imageId: 'image_web_0' },
          { title: 'Try it', bullets: ['Sketch a comfortable handle'], notes: 'Ask students to explain their choices.', sourceIds: ['source_1'], imageId: null },
        ] };
      return Response.json({ choices: [{ message: { content: JSON.stringify(plan) } }] });
    }
    if (url.hostname === 'duckduckgo.com') {
      if (url.pathname === '/') return new Response('vqd="4-12345"');
      assert.equal(url.searchParams.get('vqd'), '4-12345');
      return Response.json({ results: [{ title: 'Chair reference', width: 800, height: 500,
        thumbnail: 'https://tse1.mm.bing.net/th/id/fixture', url: 'https://design.example/chair' }] });
    }
    if (url.hostname === 'en.wikipedia.org') {
      if (url.searchParams.get('gsrnamespace') === '6') {
        return Response.json({ query: { pages: [{ pageid: 11, title: 'File:Product photograph.jpg',
          imageinfo: [{ url: 'https://upload.wikimedia.org/product.jpg',
            descriptionurl: 'https://en.wikipedia.org/wiki/File:Product_photograph.jpg', mime: 'image/jpeg',
            width: 220, height: 150, extmetadata: { LicenseShortName: { value: 'All rights reserved' } } }] }] } });
      }
      return Response.json({ query: { pages: [{ pageid: 1, title: 'Ergonomics',
        fullurl: 'https://en.wikipedia.org/wiki/Ergonomics', extract: 'Ergonomics studies people and the systems they use.' }] } });
    }
    if (url.hostname === 'commons.wikimedia.org') {
      const image = { pageid: 10, title: 'File:Chair.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/chair.jpg',
        descriptionurl: 'https://commons.wikimedia.org/wiki/File:Chair.jpg', mime: 'image/jpeg', width: 1000, height: 600,
        extmetadata: { LicenseShortName: { value: 'CC BY-SA 4.0' }, Artist: { value: '<a>Fixture Artist</a>' } } }] };
      return Response.json({ query: { pages: [image] } });
    }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      authCalls.push(options.body);
      if (options.body.get('grant_type') === 'refresh_token') {
        assert.equal(options.body.get('refresh_token'), 'test-refresh');
        return Response.json({ access_token: 'test-access', expires_in: 3600 });
      }
      const challenge = createHash('sha256').update(options.body.get('code_verifier')).digest('base64url');
      assert.equal(challenge, verifierChallenge);
      return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600,
        scope: 'https://www.googleapis.com/auth/drive.file' });
    }
    assert.equal(options.headers.Authorization, 'Bearer test-access');
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/drive/v3/files') {
      if (options.method === 'POST') {
        fileCreates++;
        fileCreated = true;
        slides = [{ objectId: 'google_starter', pageElements: [
          { shape: { placeholder: { type: 'TITLE' }, text: { textElements: [{ textRun: { content: '\n' } }] } } },
        ] }];
        if (loseCreateResponse) { loseCreateResponse = false; throw new Error('Lost response'); }
        return Response.json({ id: 'fixtureDeck' });
      }
      return Response.json({ files: fileCreated ? [{ id: 'fixtureDeck' }] : [] });
    }
    if (url.hostname === 'slides.googleapis.com' && url.pathname.endsWith(':batchUpdate')) {
      const batch = JSON.parse(options.body).requests;
      const findNotes = id => slides.map(slide => slide.slideProperties?.notesPage)
        .find(page => page?.notesProperties.speakerNotesObjectId === id);
      for (const [index, request] of batch.entries()) {
        if (request.deleteText && !findNotes(request.deleteText.objectId)?.pageElements?.[0]?.shape.text.textElements[0].textRun.content.trim()) {
          return Response.json({ error: { message: `Invalid requests[${index}].deleteText: The startIndex 0 must be less than the endIndex 0` } }, { status: 400 });
        }
      }
      batches.push(batch);
      for (const request of batch) {
        if (request.deleteObject) slides = slides.filter(slide => slide.objectId !== request.deleteObject.objectId);
        if (request.createSlide) slides.push({ objectId: request.createSlide.objectId,
          slideProperties: { notesPage: { notesProperties: { speakerNotesObjectId: request.createSlide.objectId + '_notes' } } } });
        const edit = request.insertText ?? request.deleteText;
        const notes = edit && findNotes(edit.objectId);
        if (notes) {
          const content = request.insertText ? request.insertText.text + '\n' : '\n';
          notes.pageElements = [{ objectId: edit.objectId, shape: { text: { textElements: [{ textRun: { content } }] } } }];
        }
      }
      return Response.json({});
    }
    if (url.hostname === 'slides.googleapis.com') {
      return Response.json({ presentationId: 'fixtureDeck',
        pageSize: { width: { magnitude: 9144000, unit: 'EMU' }, height: { magnitude: 5143500, unit: 'EMU' } }, slides });
    }
    throw new Error('Unexpected request to ' + url.origin);
  };
  let google;
  try {
    const plan = await preparePresentation({ provider: 'lmstudio', endpoint: 'https://model.test/v1', model: 'fixture' }, '',
      [{ role: 'user', content: 'Create a three-slide ergonomics lesson.' }]);
    assert.equal(plan.images.length, 3);
    assert.equal(plan.images[0].pageUrl, 'https://design.example/chair');
    assert.equal(plan.images[1].artist, 'Fixture Artist');
    assert.equal(plan.images[2].license, 'All rights reserved');
    assert.equal(plan.slides.length, 3);
    assert.deepEqual(plan.slides[0].imageIds, ['image_en_11', 'image_10']);
    assert.deepEqual(plan.slides[1].imageIds, ['image_web_0']);
    google = await loadGoogle(directory, async value => {
      const auth = new URL(value);
      verifierChallenge = auth.searchParams.get('code_challenge');
      const callback = new URL(auth.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1');
      callback.search = new URLSearchParams({ state: 'incorrect', code: 'fixture' });
      assert.equal((await originalFetch(callback)).status, 400);
      callback.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'fixture' });
      assert.equal((await originalFetch(callback)).status, 200);
    }, storage);
    await google.importClient({ installed: { client_id: 'test.apps.googleusercontent.com', client_secret: 'fixture' } });
    await google.connect();
    assert.equal(authCalls.length, 1);
    google = await loadGoogle(directory, async () => assert.fail('Restart should not open a browser'), storage);
    assert.equal(google.status().remembered, true);
    await assert.rejects(google.create(plan, true), /Could not reach Google/);
    assert.equal(authCalls.length, 2);
    slides[0].pageElements[0].shape.text.textElements[0].textRun.content = 'Tester edited the starter';
    await assert.rejects(google.create(plan, true), /changed while it was being built/);
    assert.equal(batches.length, 0);
    slides[0].pageElements[0].shape.text.textElements[0].textRun.content = '\n';
    const deck = await google.create(plan, true);
    assert.equal(deck.url, 'https://docs.google.com/presentation/d/fixtureDeck/edit');
    assert.equal(fileCreates, 1);
    const images = batches.flat().filter(request => request.createImage);
    assert.deepEqual(images.map(request => request.createImage.url), [plan.images[2].url, plan.images[1].url, plan.images[0].url]);
    assert.equal(images.filter(request => request.createImage.elementProperties.pageObjectId === 'mb_slide_0').length, 2);
    assert.match(slides[0].slideProperties.notesPage.pageElements[0].shape.text.textElements[0].textRun.content, /Chair.jpg/);
    assert.ok(batches.flat().some(request => request.deleteObject?.objectId === 'google_starter'));
    assert.ok(batches.flat().some(request => request.updateTextStyle?.style.link?.url === plan.images[0].pageUrl));
    assert.ok(batches.flat().some(request => request.updateTextStyle?.style.link?.url === plan.sources[0].url));
    const pageCount = slides.length;
    const batchCount = batches.length;
    await google.create(plan, true);
    assert.equal(fileCreates, 1);
    assert.equal(slides.length, pageCount);
    assert.equal(batches.length, batchCount, 'Retry should leave already-written speaker notes alone');
    const note = slides[0].slideProperties.notesPage.pageElements[0];
    note.shape.text.textElements[0].textRun.content = 'Partial notes\n';
    await google.create(plan, true);
    assert.ok(batches.at(-1).some(request => request.deleteText?.objectId === note.objectId));
    await google.disconnect();
    google = await loadGoogle(directory, async () => {}, storage);
    await assert.rejects(google.create(plan, true), /Connect Google/);
  } finally {
    google?.close();
    global.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
