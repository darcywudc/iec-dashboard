// 用服务账号 JSON 生成 Google OAuth2 access token
// 用法: node gcp-token.js <sa.json路径> [scope]
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const SA_PATH = process.argv[2];
const SCOPE = process.argv[3] || 'https://www.googleapis.com/auth/monitoring.read https://www.googleapis.com/auth/cloud-platform';

const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

const now = Math.floor(Date.now() / 1000);
const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
const payload = base64url(Buffer.from(JSON.stringify({
  iss: sa.client_email,
  scope: SCOPE,
  aud: sa.token_uri,
  exp: now + 3600,
  iat: now
})));

const sign = crypto.createSign('RSA-SHA256');
sign.update(`${header}.${payload}`);
const sig = base64url(sign.sign(sa.private_key));
const jwt = `${header}.${payload}.${sig}`;

const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
const req = https.request('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length }
}, res => {
  let data = '';
  res.on('data', d => data += d);
  res.on('end', () => {
    const r = JSON.parse(data);
    if (r.access_token) process.stdout.write(r.access_token);
    else { process.stderr.write(JSON.stringify(r)); process.exit(1); }
  });
});
req.write(body);
req.end();
