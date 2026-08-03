const dns = require('node:dns').promises;
const net = require('node:net');

function extractWebUrls(text) {
  const source = String(text || '');
  const slackLinks = Array.from(
    source.matchAll(/<(https?:\/\/[^>|]+)(?:\|[^>]+)?>/gi),
    (match) => match[1],
  );
  const plainLinks = source
    .replace(/<https?:\/\/[^>]+>/gi, ' ')
    .match(/https?:\/\/[^\s<>]+/gi) || [];
  return Array.from(new Set(
    [...slackLinks, ...plainLinks].map((url) => url.replace(/[),.;!?]+$/, '')),
  ));
}

function isPrivateAddress(address) {
  if (!net.isIP(address)) return false;
  return address === '::1'
    || address.startsWith('fc')
    || address.startsWith('fd')
    || address.startsWith('fe80:')
    || address.startsWith('127.')
    || address.startsWith('10.')
    || address.startsWith('192.168.')
    || address.startsWith('169.254.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address)
    || address === '0.0.0.0';
}

async function assertPublicWebUrl(rawUrl, resolveAddresses = async (hostname) => (
  dns.lookup(hostname, { all: true, verbatim: true })
)) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new Error('Private URLs are not supported');
  }
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await resolveAddresses(hostname);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('Private URLs are not supported');
  }
  return url;
}

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function extractHtmlContext(html, url) {
  const title = decodeHtml(
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      || html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || url,
  ).replace(/\s+/g, ' ').trim();
  const description = decodeHtml(
    html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || '',
  ).replace(/\s+/g, ' ').trim();
  const content = decodeHtml(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 7000);
  return { title, description, content, url };
}

async function fetchWebPageContext(rawUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const resolveAddresses = options.resolveAddresses;
  let url = await assertPublicWebUrl(rawUrl, resolveAddresses);

  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetchImpl(url, {
      headers: { 'User-Agent': 'Edna Social Agent/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = await assertPublicWebUrl(new URL(response.headers.get('location'), url).toString(), resolveAddresses);
      continue;
    }
    if (!response.ok) throw new Error(`Web page returned ${response.status}`);
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error(`Unsupported web content type: ${contentType || 'unknown'}`);
    }
    const html = (await response.text()).slice(0, 500000);
    return extractHtmlContext(html, url.toString());
  }
  throw new Error('Too many redirects');
}

module.exports = {
  assertPublicWebUrl,
  extractHtmlContext,
  extractWebUrls,
  fetchWebPageContext,
  isPrivateAddress,
};
