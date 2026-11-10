const site = 'https://moodle.louisiana.edu';
const authority = 'https://login.microsoftonline.com';
const tenantPath = '/13b3b0ce-cd75-49a4-bfea-0a03b01ff1ab/saml2';
const callbackPath = '/auth/saml2/sp/saml2-acs.php/moodle.louisiana.edu';
const assetOrigins = new Set([
  'https://aadcdn.msauth.net',
  'https://aadcdn.msftauth.net',
  'https://aadcdn.msauthimages.net',
  'https://aadcdn.msftauthimages.net',
]);

function authUrl(value) {
  const url = URL.parse(value);
  return url?.protocol === 'https:' && !url.username && !url.password ? url : null;
}

function isSignInRedirect(value) {
  const url = authUrl(value);
  return url?.origin === authority && url.pathname === tenantPath && url.searchParams.has('SAMLRequest');
}

function microsoftSignIn() {
  let started = false;
  let returned = false;
  return {
    allowsNavigation(value) {
      return !returned && (started ? authUrl(value)?.origin === authority : isSignInRedirect(value));
    },
    allowsRequest(details) {
      const url = authUrl(details.url);
      if (!url || returned) return false;
      if (details.resourceType === 'mainFrame' && details.method === 'GET' && isSignInRedirect(details.url)) {
        started = true;
      }
      if (!started) return false;
      if (url.origin === authority) return details.method === 'GET' || details.method === 'POST';
      return details.method === 'GET' && assetOrigins.has(url.origin) &&
        ['script', 'stylesheet', 'image', 'font'].includes(details.resourceType);
    },
    acceptsCallback(details, url) {
      if (!started || returned || details.method !== 'POST' || details.resourceType !== 'mainFrame' ||
          details.initiatorOrigin !== authority || url.pathname !== callbackPath || url.search) return false;
      returned = true;
      return true;
    },
    get returned() { return returned; },
  };
}

module.exports = { site, isSignInRedirect, microsoftSignIn };
