// #537 (Konrad): Windows Hello becomes a way to unlock only for a key the TPM holds. KeyCredential.GetAttestationAsync
// gives the certificate chain of the TPM's attestation identity key (AIK) and the attestation blob. Checked here: status
// success, an AIK certificate (EKU 2.23.133.8.3, no CA) that chains through CA certificates of the same buffer to the
// pinned Microsoft TPM Root Certificate Authority 2014, every certificate within its validity. Without that: no Hello.
// Limit (named in #537): the blob is passed along but not parsed (its format is not documented), so the binding of the
// AIK to exactly this key is Windows' word. The attestation keeps a software-only Hello key out; it does not defend
// against code running as the same user, which can do more anyway (risk 2 of the plan). No Electron (unit tests).

import crypto from 'node:crypto';

const AIK_EKU = '2.23.133.8.3';
const MAX_DEPTH = 6;

/** Microsoft TPM Root Certificate Authority 2014 (SHA-256 870C7A35CEAB3D59979F2C6A524042D404CB71518004350925FB2CED79A999DA). */
const MICROSOFT_TPM_ROOT_2014 = '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';

/** The roots a TPM attestation must chain to (production: only Microsoft's). */
export const TPM_ROOTS = Object.freeze([MICROSOFT_TPM_ROOT_2014]);

/** One DER element at off: { tag, off (header), start (content), end } – throws on a truncated or indefinite length. */
function tlv(buf, off) {
  if (off + 2 > buf.length) throw new Error('DER truncated');
  const tag = buf[off];
  let len = buf[off + 1];
  let start = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > buf.length) throw new Error('DER length');
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[start + i];
    start += n;
  }
  const end = start + len;
  if (end > buf.length) throw new Error('DER truncated');
  return { tag, off, start, end };
}

function children(buf, { start, end }) {
  const out = [];
  for (let off = start; off < end;) {
    const c = tlv(buf, off);
    out.push(c);
    off = c.end;
  }
  return out;
}

const SIGNED_DATA_OID = Buffer.from('06092a864886f70d010702', 'hex'); // 1.2.840.113549.1.7.2

/** The certificates of the chain buffer: DER certificates one after the other, or a PKCS#7 SignedData holding them. */
export function chainCertificates(buf) {
  const top = children(buf, { start: 0, end: buf.length });
  const first = top[0];
  if (top.length === 1 && first.tag === 0x30) {
    const inner = children(buf, first);
    if (inner[0]?.tag === 0x06 && buf.subarray(inner[0].off, inner[0].end).equals(SIGNED_DATA_OID)) {
      const explicit = inner[1];
      if (explicit?.tag !== 0xa0) throw new Error('PKCS#7 without content');
      const signedData = children(buf, explicit)[0];
      const set = children(buf, signedData).find((c) => c.tag === 0xa0); // certificates [0] IMPLICIT
      if (!set) return [];
      return children(buf, set).map((c) => buf.subarray(c.off, c.end));
    }
  }
  return top.map((c) => buf.subarray(c.off, c.end));
}

const within = (cert, now) => now >= Date.parse(cert.validFrom) && now <= Date.parse(cert.validTo);

const KEY_USAGE_OID = Buffer.from('0603551d0f', 'hex'); // 2.5.29.15

/**
 * The KeyUsage bits of a certificate as the first byte of the BIT STRING (digitalSignature 0x80 … keyCertSign 0x04), or
 * null without the extension. Read from the DER: Node's X509Certificate.keyUsage holds the extended key usage only.
 */
export function keyUsageByte(cert) {
  const raw = cert.raw;
  const tbs = children(raw, tlv(raw, 0))[0];
  const box = children(raw, tbs).find((c) => c.tag === 0xa3); // extensions [3] EXPLICIT
  if (!box) return null;
  for (const ext of children(raw, children(raw, box)[0])) {
    const parts = children(raw, ext);
    if (!raw.subarray(parts[0].off, parts[0].end).equals(KEY_USAGE_OID)) continue;
    const value = parts[parts.length - 1]; // OCTET STRING holding the BIT STRING
    const bits = tlv(raw, value.start);
    return bits.end - bits.start >= 2 ? raw[bits.start + 1] : 0;
  }
  return null;
}

/**
 * Did candidate issue cert? Live test 14.11.2026: Microsoft's AIK certificates name an Authority Key Identifier that does
 * not match the Subject Key Identifier of their (valid) issuer, so OpenSSL's checkIssued refuses them. Counted instead:
 * the issuer name equals the candidate's subject, the signature verifies with the candidate's key, the candidate is a CA
 * (and may sign certificates, where it says how it may be used) and is valid now.
 */
function issuedBy(cert, candidate, now) {
  if (cert.issuer !== candidate.subject || !candidate.ca || !within(candidate, now)) return false;
  let usage;
  try {
    usage = keyUsageByte(candidate);
  } catch {
    return false; // a KeyUsage that cannot be read counts as none allowed
  }
  if (usage !== null && !(usage & 0x04)) return false;
  try {
    return cert.verify(candidate.publicKey);
  } catch {
    return false;
  }
}

/**
 * attestation: { status, chain (base64), blob (base64) } as the helper reports it. → { ok: true } or { ok: false, reason }.
 * roots: base64 DER certificates (default: Microsoft's TPM root); now: ms.
 */
export function verifyAttestation(attestation, { roots = TPM_ROOTS, now = Date.now() } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!attestation || attestation.status !== 0) return no(`status ${attestation?.status ?? 'missing'}`);
  if (typeof attestation.chain !== 'string' || typeof attestation.blob !== 'string' || !attestation.blob) return no('no chain or blob');
  let certs;
  let anchors;
  try {
    certs = chainCertificates(Buffer.from(attestation.chain, 'base64')).map((der) => new crypto.X509Certificate(der));
    anchors = roots.map((r) => new crypto.X509Certificate(Buffer.from(r, 'base64')));
  } catch (e) {
    return no(`chain: ${e.message}`);
  }
  const aiks = certs.filter((c) => !c.ca && (c.keyUsage || []).includes(AIK_EKU));
  if (aiks.length !== 1) return no('no AIK certificate');
  let cert = aiks[0];
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (!within(cert, now)) return no('certificate not valid now');
    // The anchor only from the pinned roots, by the same rules; a root of the buffer is never one.
    if (anchors.some((a) => issuedBy(cert, a, now))) return { ok: true };
    if (anchors.some((a) => cert.issuer === a.subject && !within(a, now))) return no('root not valid now');
    const issuer = certs.find((c) => c !== cert && issuedBy(cert, c, now));
    if (!issuer) return no('chain does not reach the TPM root');
    cert = issuer;
  }
  return no('chain too long');
}
