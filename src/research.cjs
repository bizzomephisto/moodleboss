const { load } = require('cheerio');

const userAgent = 'MoodleBOSS/0.4 (https://github.com/bizzomephisto/moodleboss)';
const plain = value => load(String(value ?? ''), {}, false).text().replace(/\s+/g, ' ').trim();

async function webImages(query) {
  const search = new URL('https://duckduckgo.com/');
  search.searchParams.set('q', query);
  const signal = AbortSignal.timeout(12000);
  const page = await fetch(search, { signal, redirect: 'error' });
  if (!page.ok) throw new Error('DuckDuckGo image search was unavailable.');
  const token = (await page.text()).match(/\bvqd[=:]\s*['"]?(\d[\d-]*)/)?.[1];
  if (!token) throw new Error('DuckDuckGo image search did not return a search token.');
  const endpoint = new URL('/i.js', search);
  endpoint.search = new URLSearchParams({ q: query, vqd: token, o: 'json', p: '1' });
  const response = await fetch(endpoint, { signal, redirect: 'error', headers: { Referer: search.href, Accept: 'application/json' } });
  if (!response.ok) throw new Error('DuckDuckGo image results were unavailable.');
  const { results } = await response.json();
  return (results ?? []).flatMap(item => {
    const thumbnail = URL.parse(item.thumbnail);
    const source = URL.parse(item.url);
    if (thumbnail?.protocol !== 'https:' || !/^tse[1-4]\.mm\.bing\.net$/.test(thumbnail.hostname) ||
        thumbnail.username || thumbnail.password || thumbnail.port || thumbnail.href.length > 1900 ||
        source?.protocol !== 'https:' || source.username || source.password ||
        !Number.isFinite(item.width) || !Number.isFinite(item.height) || item.width <= 0 || item.height <= 0) return [];
    return [{ title: plain(item.title).slice(0, 200) || 'Web image', url: thumbnail.href,
      pageUrl: source.href, artist: '', license: 'Rights not specified', licenseUrl: '',
      description: source.hostname, width: item.width, height: item.height }];
  }).slice(0, 4);
}

async function wiki(host, parameters) {
  const url = new URL('/w/api.php', 'https://' + host);
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: 2, ...parameters });
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${host} returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.error) throw new Error(`${host} could not complete the search.`);
  return result.query?.pages ?? [];
}

async function research(queries, imageQueries, progress) {
  progress('Researching the topic on Wikipedia…');
  const sourceResults = await Promise.allSettled(queries.map(query => wiki('en.wikipedia.org', {
    generator: 'search', gsrsearch: query, gsrnamespace: 0, gsrlimit: 3,
    prop: 'extracts|info', exintro: 1, explaintext: 1, exchars: 3500, inprop: 'url',
  })));
  const sources = new Map();
  for (const result of sourceResults) {
    if (result.status !== 'fulfilled') continue;
    for (const page of result.value) {
      const url = URL.parse(page.fullurl);
      if (!page.extract || url?.origin !== 'https://en.wikipedia.org') continue;
      sources.set(page.pageid, { id: 'source_' + page.pageid, title: plain(page.title),
        url: url.href, text: plain(page.extract).slice(0, 3500) });
    }
  }
  if (!sources.size) throw new Error('Research returned no usable sources. Try a more specific topic or check your connection.');

  progress('Finding images on DuckDuckGo and Wikimedia…');
  const [webResults, imageResults] = await Promise.all([
    Promise.allSettled(imageQueries.map(webImages)),
    Promise.allSettled(imageQueries.flatMap(query =>
    ['commons.wikimedia.org', 'en.wikipedia.org'].map(host => wiki(host, {
      generator: 'search', gsrsearch: query, gsrnamespace: 6, gsrlimit: 3,
      prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: 1000,
    })))),
  ]);
  const images = new Map();
  for (const result of imageResults) {
    if (result.status !== 'fulfilled') continue;
    for (const page of result.value) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      const metadata = info.extmetadata ?? {};
      const license = plain(metadata.LicenseShortName?.value || metadata.UsageTerms?.value) || 'Rights not specified';
      const url = URL.parse(info.thumburl ?? info.url);
      const pageUrl = URL.parse(info.descriptionurl);
      const mime = info.thumbmime ?? info.mime;
      if (!['image/jpeg', 'image/png', 'image/gif'].includes(mime) ||
          url?.origin !== 'https://upload.wikimedia.org' || url.href.length > 1900 ||
          !['https://commons.wikimedia.org', 'https://en.wikipedia.org'].includes(pageUrl?.origin) ||
          !(info.width > 0 && info.height > 0)) continue;
      const id = (pageUrl.hostname === 'en.wikipedia.org' ? 'image_en_' : 'image_') + page.pageid;
      const originalUrl = info.url ?? url.href;
      if (images.has(originalUrl)) continue;
      images.set(originalUrl, { id, title: plain(page.title).replace(/^File:/, ''),
        url: url.href, pageUrl: pageUrl.href, artist: plain(metadata.Artist?.value).slice(0, 200),
        license, licenseUrl: URL.parse(metadata.LicenseUrl?.value)?.href ?? '',
        description: plain(metadata.ImageDescription?.value).slice(0, 350),
        width: info.thumbwidth ?? info.width, height: info.thumbheight ?? info.height });
    }
  }
  const warnings = [];
  const web = new Map();
  for (const result of webResults) {
    if (result.status !== 'fulfilled') continue;
    for (const image of result.value) if (!web.has(image.url)) web.set(image.url, image);
  }
  const candidates = [
    ...[...web.values()].slice(0, 9).map((image, index) => ({ ...image, id: 'image_web_' + index })),
    ...images.values(),
  ].slice(0, 12);
  if (sourceResults.some(result => result.status === 'rejected')) warnings.push('Some research searches were unavailable.');
  if (!candidates.length) warnings.push('No usable images were found. The deck will use text layouts.');
  else if (!web.size) warnings.push('DuckDuckGo returned no usable images. Showing Wikimedia results.');
  else if (imageResults.some(result => result.status === 'rejected')) warnings.push('Some image searches were unavailable.');
  return { sources: [...sources.values()].slice(0, 8), images: candidates, warnings };
}

module.exports = { research };
