// A self-signed certificate for "localhost", made at run time (no key in the repository): EC P-256, X.509 v1, valid for a
// day. For the smoke check and the unit test of #517: a server that a correct TLS client must refuse.
import crypto from 'node:crypto';

const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  let len;
  if (body.length < 0x80) len = Buffer.from([body.length]);
  else if (body.length < 0x100) len = Buffer.from([0x81, body.length]);
  else len = Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const seq = (...p) => der(0x30, ...p);
const oid = (s) => {
  const n = s.split('.').map(Number);
  const out = [40 * n[0] + n[1]];
  for (const v of n.slice(2)) {
    const b = [v & 0x7f];
    for (let x = v >> 7; x; x >>= 7) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return der(0x06, Buffer.from(out));
};
const utcTime = (d) => der(0x17, Buffer.from(`${d.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
const name = (cn) => seq(der(0x31, seq(oid('2.5.4.3'), der(0x0c, Buffer.from(cn)))));

/** { key, cert } in PEM, for https.createServer / tls.createServer. */
export function selfSignedCert(cn = 'localhost') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const now = Date.now();
  const tbs = seq(
    der(0x02, Buffer.from([0x01, ...crypto.randomBytes(8)])),
    ecdsaSha256,
    name(cn),
    seq(utcTime(new Date(now - 3600_000)), utcTime(new Date(now + 86_400_000))),
    name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const cert = seq(tbs, ecdsaSha256, der(0x03, Buffer.from([0]), sig));
  const pem = `-----BEGIN CERTIFICATE-----\n${cert.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem };
}
