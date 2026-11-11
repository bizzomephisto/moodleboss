const { load } = require('cheerio');

const userAgent = 'MoodleBOSS/0.4 (https://github.com/bizzomephisto/moodleboss)';
let crossrefQueue = Promise.resolve();
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

async function wikipediaSources(query) {
  const pages = await wiki('en.wikipedia.org', {
    generator: 'search', gsrsearch: query, gsrnamespace: 0, gsrlimit: 3,
    prop: 'extracts|info', exintro: 1, explaintext: 1, exchars: 3500, inprop: 'url',
  });
  return pages.flatMap(page => {
    const url = URL.parse(page.fullurl);
    const text = plain(page.extract).slice(0, 3500);
    return text && url?.origin === 'https://en.wikipedia.org' ? [{
      id: 'source_' + page.pageid, title: plain(page.title), url: url.href, text, evidence: 'Wikipedia extract',
    }] : [];
  });
}

function doiUrl(value) {
  if (typeof value !== 'string' || !/^10\.\d{4,}\/\S+$/.test(value)) return null;
  const parts = value.toLowerCase().split('/');
  if (parts.some(part => part === '.' || part === '..')) return null;
  return 'https://doi.org/' + parts.map(encodeURIComponent).join('/');
}

async function crossrefSources(query) {
  const search = new URL('https://api.crossref.org/works');
  search.search = new URLSearchParams({
    'query.bibliographic': query, rows: '3', filter: 'has-abstract:true',
    select: 'DOI,title,abstract,container-title,published',
  });
  const response = await fetch(search, {
    headers: { Accept: 'application/json', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`Crossref returned HTTP ${response.status}.`);
  const { message } = await response.json();
  return (message?.items ?? []).flatMap(item => {
    const url = doiUrl(item.DOI);
    const title = plain(item.title?.[0]).slice(0, 300);
    const text = plain(item.abstract).slice(0, 3500);
    if (!url || !title || !text) return [];
    const publication = plain(item['container-title']?.[0]).slice(0, 200);
    const year = item.published?.['date-parts']?.[0]?.[0];
    return [{ title, url, text, evidence: 'Publication abstract via Crossref',
      publication, ...(Number.isInteger(year) && { year }) }];
  });
}

function queueCrossref(query) {
  // Crossref's public API allows one concurrent request.
  const result = crossrefQueue.then(() => crossrefSources(query));
  crossrefQueue = result.catch(() => {});
  return result;
}

async function dataCiteSources(query) {
  const search = new URL('https://api.datacite.org/dois');
  search.search = new URLSearchParams({
    query, 'page[size]': '8', 'fields[dois]': 'doi,titles,descriptions,publisher,publicationYear',
    'resource-type-id': 'dataset,dissertation,report,journal-article,conference-paper,book,book-chapter,preprint',
  });
  const response = await fetch(search, {
    headers: { Accept: 'application/vnd.api+json', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(10000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`DataCite returned HTTP ${response.status}.`);
  const { data } = await response.json();
  return (data ?? []).flatMap(({ attributes: item }) => {
    if (!item) return [];
    const url = doiUrl(item.doi);
    const title = plain(item.titles?.[0]?.title).slice(0, 300);
    const abstract = item.descriptions?.find(description => description.descriptionType === 'Abstract');
    const description = abstract ?? item.descriptions?.find(description => description.descriptionType === 'Other');
    const text = plain(description?.description).slice(0, 3500);
    if (!url || !title || !text) return [];
    return [{ title, url, text, evidence: abstract ? 'Abstract via DataCite' : 'Repository description via DataCite',
      publication: plain(item.publisher?.name ?? item.publisher).slice(0, 200),
      ...(Number.isInteger(item.publicationYear) && { year: item.publicationYear }) }];
  }).slice(0, 3);
}

async function research(queries, imageQueries, progress) {
  progress('Searching Wikipedia, Crossref, and DataCite…');
  const searches = queries.flatMap(query => [wikipediaSources(query), queueCrossref(query), dataCiteSources(query)]);
  const sourceResults = await Promise.allSettled(searches);
  const sources = new Map();
  // Take the top results from each query and provider before considering lower ranks.
  for (let rank = 0; rank < 3 && sources.size < 8; rank++) {
    for (const result of sourceResults) {
      const source = result.status === 'fulfilled' ? result.value[rank] : null;
      if (!source || sources.has(source.url)) continue;
      sources.set(source.url, { ...source, id: source.id ?? 'source_external_' + sources.size });
      if (sources.size === 8) break;
    }
  }
  if (!sources.size) throw new Error('Research returned no usable sources. Try a more specific topic or check your connection.');

  const pictures = await findImages(imageQueries, progress);
  if (sourceResults.some(result => result.status === 'rejected')) pictures.warnings.unshift('Some research searches were unavailable.');
  return { sources: [...sources.values()], ...pictures };
}

async function findImages(imageQueries, progress = () => {}) {
  progress('Finding images on DuckDuckGo and Wikimedia…');
  const [webResults, imageResults] = await Promise.all([
    Promise.allSettled(imageQueries.map(webImages)),
    Promise.allSettled(imageQueries.flatMap(query =>
    ['commons.wikimedia.org', 'en.wikipedia.org'].map(host => wiki(host, {
      generator: 'search', gsrsearch: query, gsrnamespace: 6, gsrlimit: 3,
      prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: 1600,
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
  if (!candidates.length) warnings.push('No usable images were found. The deck will use text layouts.');
  else if (!web.size) warnings.push('DuckDuckGo returned no usable images. Showing Wikimedia results.');
  else if (imageResults.some(result => result.status === 'rejected')) warnings.push('Some image searches were unavailable.');
  return { images: candidates, warnings };
}

module.exports = { research, findImages };
