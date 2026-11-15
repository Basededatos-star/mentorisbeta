'use strict';
/* Almacenamiento de objetos: Cloudflare R2 (API compatible con S3, firma SigV4 sin dependencias)
   o carpeta local ./data cuando no hay credenciales (solo para pruebas en tu computadora). */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256 = d => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/* Firma AWS Signature V4. Exportada para poder probarla con los vectores oficiales de AWS. */
function sign({ method, host, path: p, query = {}, headers = {}, payloadHash, region, service = 's3', accessKey, secretKey, amzDate }) {
  const date = amzDate.slice(0, 8);
  const h = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(h).map(k => k.toLowerCase()).sort();
  const lower = {}; Object.keys(h).forEach(k => { lower[k.toLowerCase()] = String(h[k]).trim().replace(/\s+/g, ' '); });
  const canonHeaders = names.map(n => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonQuery = Object.keys(query).sort().map(k => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonUri = p.split('/').map(s => enc(decodeURIComponent(s))).join('/');
  const canonical = [method, canonUri, canonQuery, canonHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { signature, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, canonQuery, canonUri };
}

function r2Storage({ accountId, accessKeyId, secretAccessKey, bucket, endpoint }) {
  const base = (endpoint || `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');
  const host = new URL(base).host;
  async function call(method, key, { query = {}, body, headers = {} } = {}) {
    const p = '/' + bucket + (key ? '/' + key : '');
    const payload = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const s = sign({ method, host, path: p, query, headers, payloadHash: sha256(payload), region: 'auto', accessKey: accessKeyId, secretKey: secretAccessKey, amzDate });
    const url = base + s.canonUri + (s.canonQuery ? '?' + s.canonQuery : '');
    return fetch(url, {
      method,
      headers: { ...headers, 'x-amz-content-sha256': sha256(payload), 'x-amz-date': amzDate, authorization: s.authorization },
      body: method === 'PUT' ? payload : undefined
    });
  }
  const fail = async (what, res) => { throw new Error(`R2 ${what} falló (${res.status}): ${(await res.text()).slice(0, 300)}`); };
  return {
    kind: 'r2',
    async get(key) {
      const res = await call('GET', key);
      if (res.status === 404) return null;
      if (!res.ok) await fail('GET ' + key, res);
      return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'application/octet-stream', contentEncoding: res.headers.get('content-encoding') || '' };
    },
    async put(key, body, { contentType = 'application/octet-stream', contentEncoding = '' } = {}) {
      const headers = { 'content-type': contentType };
      if (contentEncoding) headers['content-encoding'] = contentEncoding;
      const res = await call('PUT', key, { body, headers });
      if (!res.ok) await fail('PUT ' + key, res);
    },
    async del(key) {
      const res = await call('DELETE', key);
      if (!res.ok && res.status !== 404) await fail('DELETE ' + key, res);
    },
    async list(prefix) {
      const out = []; let token;
      do {
        const q = { 'list-type': '2', prefix }; if (token) q['continuation-token'] = token;
        const res = await call('GET', '', { query: q });
        if (!res.ok) await fail('LIST ' + prefix, res);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const g = t => (m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1];
          out.push({ key: g('Key'), lastModified: new Date(g('LastModified')).getTime(), size: +g('Size') });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? (xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/) || [])[1] : null;
      } while (token);
      return out;
    }
  };
}

function localStorage(dir) {
  const root = path.resolve(dir);
  const file = k => { const f = path.join(root, ...k.split('/')); if (!f.startsWith(root)) throw new Error('ruta inválida'); return f; };
  return {
    kind: 'local',
    async get(key) {
      try {
        const f = file(key);
        const body = fs.readFileSync(f);
        let meta = {}; try { meta = JSON.parse(fs.readFileSync(f + '.meta', 'utf8')); } catch (e) { }
        return { body, contentType: meta.contentType || 'application/octet-stream', contentEncoding: meta.contentEncoding || '' };
      } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async put(key, body, { contentType = 'application/octet-stream', contentEncoding = '' } = {}) {
      const f = file(key); fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, body); fs.writeFileSync(f + '.meta', JSON.stringify({ contentType, contentEncoding }));
    },
    async del(key) { for (const f of [file(key), file(key) + '.meta']) { try { fs.unlinkSync(f); } catch (e) { } } },
    async list(prefix) {
      const out = [];
      const walk = d => { if (!fs.existsSync(d)) return; for (const n of fs.readdirSync(d)) { const f = path.join(d, n); const st = fs.statSync(f); if (st.isDirectory()) walk(f); else if (!n.endsWith('.meta')) { const key = path.relative(root, f).split(path.sep).join('/'); if (key.startsWith(prefix)) out.push({ key, lastModified: st.mtimeMs, size: st.size }); } } };
      walk(root); return out;
    }
  };
}

function createStorage(env) {
  const { R2_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket, R2_ENDPOINT: endpoint } = env;
  if ((accountId || endpoint) && accessKeyId && secretAccessKey && bucket) return r2Storage({ accountId, accessKeyId, secretAccessKey, bucket, endpoint });
  return localStorage(env.DATA_DIR || './data');
}

module.exports = { createStorage, sign, sha256 };
