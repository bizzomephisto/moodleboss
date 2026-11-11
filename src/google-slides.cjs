const { createServer } = require('node:http');
const { randomBytes, createHash } = require('node:crypto');
const { readFile, writeFile, rename } = require('node:fs/promises');
const path = require('node:path');
const { deckPages, buildSlideRequests, noteRequests } = require('./slides-layout.cjs');

const scope = 'https://www.googleapis.com/auth/drive.file';
const tokenUrl = 'https://oauth2.googleapis.com/token';

async function googleResponse(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(45000) });
  } catch {
    throw new Error('Could not reach Google. Check your internet connection and try again.');
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = result.error?.message ?? result.error_description;
    const error = new Error(detail ? `Google: ${String(detail).slice(0, 350)}` : `Google returned HTTP ${response.status}.`);
    if (typeof result.error === 'string') error.googleCode = result.error;
    throw error;
  }
  return result;
}

function desktopClient(value) {
  const client = value?.installed;
  if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(client?.client_id ?? '') ||
      typeof client.client_secret !== 'string' || !client.client_secret || client.client_secret.length > 500) {
    throw new Error('Choose the JSON credentials for a Google OAuth Desktop app.');
  }
  return { client_id: client.client_id, client_secret: client.client_secret };
}

async function loadGoogle(directory, openBrowser, storage) {
  const file = path.join(directory, 'google-client.json');
  let client;
  try { client = desktopClient(JSON.parse(await readFile(file, 'utf8'))); } catch { /* Await imported credentials. */ }
  let tokens;
  const saved = await storage?.read('google-session').catch(() => null);
  if (client && saved?.clientId === client.client_id && typeof saved.refreshToken === 'string' && saved.refreshToken) {
    tokens = { refresh_token: saved.refreshToken, expires: 0 };
  }
  let busy = false;
  let cancelSignIn;
  const status = () => ({ configured: Boolean(client), connected: Boolean(tokens),
    remembered: Boolean(storage?.available && tokens?.refresh_token) });

  async function exclusive(action) {
    if (busy) throw new Error('Wait for the current Google operation to finish.');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }

  async function exchange(parameters) {
    const result = await googleResponse(tokenUrl, { method: 'POST',
      body: new URLSearchParams({ ...client, ...parameters }) });
    if (!result.access_token) throw new Error('Google did not return an access token.');
    if (result.scope && !result.scope.split(' ').includes(scope)) {
      throw new Error('Google Slides access was not granted. Connect again and grant access to files created by MoodleBOSS.');
    }
    const refreshing = parameters.grant_type === 'refresh_token';
    const next = { ...(refreshing ? tokens : {}), ...result, expires: Date.now() + (result.expires_in ?? 3600) * 1000 };
    if (storage?.available && (!refreshing || next.refresh_token !== tokens?.refresh_token)) {
      if (next.refresh_token) await storage.write('google-session', { clientId: client.client_id, refreshToken: next.refresh_token });
      else await storage.remove('google-session');
    }
    tokens = next;
  }

  async function request(url, method = 'GET', body) {
    if (!tokens) throw new Error('Connect Google in Settings before creating a presentation.');
    if (tokens.expires < Date.now() + 60000) {
      if (!tokens.refresh_token) throw new Error('Your Google session expired. Connect again in Settings.');
      try {
        await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
      } catch (error) {
        if (error.googleCode !== 'invalid_grant') throw error;
        await storage?.remove('google-session');
        tokens = undefined;
        throw new Error('Google authorization expired or was revoked. Connect Google again in Settings.');
      }
    }
    return googleResponse(url, { method,
      headers: { Authorization: 'Bearer ' + tokens.access_token, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined });
  }

  return {
    status,
    importClient: value => exclusive(async () => {
      const next = desktopClient(value);
      const sameClient = next.client_id === client?.client_id && next.client_secret === client?.client_secret;
      if (sameClient) return status();
      await storage?.remove('google-session');
      tokens = undefined;
      await writeFile(file + '.tmp', JSON.stringify({ installed: next }), { mode: 0o600 });
      await rename(file + '.tmp', file);
      client = next;
      return status();
    }),
    connect: () => exclusive(async () => {
      if (!client) throw new Error('Import Google Desktop app credentials in Settings first.');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let redirectUri;
      const server = createServer();
      const authorization = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Google sign-in timed out. Connect again to retry.')), 180000);
        timer.unref();
        const cleanup = () => { clearTimeout(timer); server.close(); cancelSignIn = undefined; };
        cancelSignIn = () => { cleanup(); reject(new Error('Google sign-in was cancelled.')); };
        server.on('error', reject);
        server.on('request', (req, res) => {
          const url = new URL(req.url, redirectUri);
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          if (req.method !== 'GET' || url.pathname !== '/oauth2/callback' || url.searchParams.get('state') !== state) {
            res.writeHead(400).end('Invalid sign-in response.');
            return;
          }
          res.end('Return to MoodleBOSS to finish connecting Google.');
          cleanup();
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.has('error')) reject(new Error('Google sign-in was declined. Connect again to retry.'));
          else resolve(code);
        });
        server.once('close', () => clearTimeout(timer));
      });
      // Attach the rejection handler before opening the browser.
      authorization.catch(() => {});
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        redirectUri = `http://127.0.0.1:${server.address().port}/oauth2/callback`;
        const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri,
          response_type: 'code', scope, state, code_challenge: challenge, code_challenge_method: 'S256',
          access_type: 'offline', prompt: 'consent select_account' });
        await openBrowser(url.href);
        const code = await authorization;
        await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
        return status();
      } finally {
        cancelSignIn?.();
        server.close();
      }
    }),
    disconnect: () => exclusive(async () => {
      await storage?.remove('google-session');
      tokens = undefined;
      return status();
    }),
    close: () => cancelSignIn?.(),
    create: (plan, includeImages, progress = () => {}) => exclusive(async () => {
      progress('Creating your Google Slides presentation…');
      const query = new URLSearchParams({ q: `trashed = false and appProperties has { key='moodlebossPlan' and value='${plan.id}' }`,
        fields: 'files(id)', pageSize: '2' });
      const existing = await request('https://www.googleapis.com/drive/v3/files?' + query);
      let id = existing.files?.[0]?.id;
      if (!id) {
        const created = await request('https://www.googleapis.com/drive/v3/files?fields=id', 'POST', {
          name: plan.title, mimeType: 'application/vnd.google-apps.presentation', appProperties: { moodlebossPlan: plan.id },
        });
        id = created.id;
      }
      if (!/^[\w-]+$/.test(id ?? '')) throw new Error('Google did not return a presentation ID.');
      const endpoint = 'https://slides.googleapis.com/v1/presentations/' + id;
      const fields = '?fields=presentationId,pageSize,slides(objectId,slideProperties(notesPage(notesProperties(speakerNotesObjectId))))';
      let deck = await request(endpoint + fields);
      const pages = deckPages(plan);
      const completed = new Set((deck.slides ?? []).map(slide => slide.objectId));
      if (!pages.every((_slide, index) => completed.has('mb_slide_' + index))) {
        if (completed.size) throw new Error('The presentation was changed while it was being built. Start a new presentation plan.');
        const toPoints = value => value.unit === 'EMU' ? value.magnitude / 12700 : value.magnitude;
        const width = toPoints(deck.pageSize.width);
        const height = toPoints(deck.pageSize.height);
        progress('Laying out text, images, citations, and credits…');
        try {
          await request(endpoint + ':batchUpdate', 'POST', { requests: buildSlideRequests(plan, width, height, includeImages) });
        } catch (error) {
          throw new Error(error.message + (includeImages ? ' If Google could not load an image, turn off Include images and retry.' : ''));
        }
        deck = await request(endpoint + fields);
      }
      const notes = noteRequests(plan, deck);
      if (notes.length) await request(endpoint + ':batchUpdate', 'POST', { requests: notes });
      return { id, url: `https://docs.google.com/presentation/d/${id}/edit`, title: plan.title };
    }),
  };
}

module.exports = { loadGoogle };
