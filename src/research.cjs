const { load } = require('cheerio');

const userAgent = 'MoodleBOSS/0.4 (https://github.com/bizzomephisto/moodleboss)';
const plain = value => load(String(value ?? ''), {}, false).text().replace(/\s+/g, ' ').trim();

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

  progress('Finding images and license information on Wikimedia Commons…');
  const imageResults = await Promise.allSettled(imageQueries.map(query => wiki('commons.wikimedia.org', {
    generator: 'search', gsrsearch: query, gsrnamespace: 6, gsrlimit: 5,
    prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: 1000,
  })));
  const images = new Map();
  for (const result of imageResults) {
    if (result.status !== 'fulfilled') continue;
    for (const page of result.value) {
      const info = page.imageinfo?.[0];
      if (!info) continue;
      const metadata = info.extmetadata ?? {};
      const license = plain(metadata.LicenseShortName?.value);
      const url = URL.parse(info.thumburl ?? info.url);
      const pageUrl = URL.parse(info.descriptionurl);
      const mime = info.thumbmime ?? info.mime;
      if (!/^(CC BY|CC0|Public domain)/i.test(license) || !['image/jpeg', 'image/png', 'image/gif'].includes(mime) ||
          url?.origin !== 'https://upload.wikimedia.org' || url.href.length > 1900 ||
          pageUrl?.origin !== 'https://commons.wikimedia.org' ||
          info.width < 300 || info.height < 200) continue;
      images.set(page.pageid, { id: 'image_' + page.pageid, title: plain(page.title).replace(/^File:/, ''),
        url: url.href, pageUrl: pageUrl.href, artist: plain(metadata.Artist?.value).slice(0, 200),
        license, licenseUrl: URL.parse(metadata.LicenseUrl?.value)?.href ?? '',
        description: plain(metadata.ImageDescription?.value).slice(0, 350),
        width: info.thumbwidth ?? info.width, height: info.thumbheight ?? info.height });
    }
  }
  const warnings = [];
  if (sourceResults.some(result => result.status === 'rejected')) warnings.push('Some research searches were unavailable.');
  if (!images.size) warnings.push('No suitable licensed images were found. The deck will use text layouts.');
  else if (imageResults.some(result => result.status === 'rejected')) warnings.push('Some image searches were unavailable.');
  return { sources: [...sources.values()].slice(0, 8), images: [...images.values()].slice(0, 12), warnings };
}

module.exports = { research };
