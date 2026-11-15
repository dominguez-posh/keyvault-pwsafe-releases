import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chainCertificates, TPM_ROOTS, verifyAttestation } from '../desktop/hello-attest.js';

// #537 stage 3: the helper (windows/Setup/HelloKey.cs) talks to KeyCredentialManager through raw interface tables. The
// plain interface ids and method order were read from Windows.Security.winmd (13.11.2026, PowerShell reflection); the
// parameterized ones are recomputed here, so that a typo can never reach a real Windows Hello call.

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

function pinterfaceIid(signature) {
  const ns = Buffer.from('11f47ad57b7342c0abae878b1e16adee', 'hex');
  const d = createHash('sha1').update(Buffer.concat([ns, Buffer.from(signature, 'utf8')])).digest().subarray(0, 16);
  d[6] = (d[6] & 0x0f) | 0x50;
  d[8] = (d[8] & 0x3f) | 0x80;
  const x = d.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

test('#537: the Hello key helper uses the right interface ids', () => {
  const cs = read('windows/Setup/HelloKey.cs');
  const op = '{9fc2b0bb-e446-44e2-aa61-9cab8f636af2}'; // IAsyncOperation`1
  const rc = (cls, iid) => `rc(Windows.Security.Credentials.${cls};{${iid}})`;
  const expected = {
    IidOpBool: pinterfaceIid(`pinterface(${op};b1)`),
    IidOpRetrieval: pinterfaceIid(`pinterface(${op};${rc('KeyCredentialRetrievalResult', '58cd7703-8d87-4249-9b58-f6598cc9644e')})`),
    IidOpOperation: pinterfaceIid(`pinterface(${op};${rc('KeyCredentialOperationResult', 'f53786c1-5261-4cdd-976d-cc909ac71620')})`),
    IidOpAttestation: pinterfaceIid(`pinterface(${op};${rc('KeyCredentialAttestationResult', '78aab3a1-a3c1-4103-b6cc-472c44171cbb')})`),
  };
  for (const [name, iid] of Object.entries(expected)) assert.match(cs, new RegExp(`${name} = new Guid\\("${iid}"\\)`), name);
  // From the winmd: plain ids.
  assert.match(cs, /IidManagerStatics = new Guid\("6aac468b-0ef1-4ce0-8290-4106da6a63b5"\)/);
  assert.match(cs, /IidCredential = new Guid\("9585ef8d-457b-4847-b11a-fa960bbdb138"\)/);
  assert.match(cs, /IidBufferStatics = new Guid\("320b7e22-3cb0-4cdf-8663-1d28910065eb"\)/);
});

test('#537: the helper takes the challenge on stdin, only Keevault- key names, and is wired in Program.cs', () => {
  const cs = read('windows/Setup/HelloKey.cs');
  assert.match(cs, /Console\.OpenStandardInput\(\)/);
  assert.match(cs, /name\.StartsWith\("Keevault-", StringComparison\.Ordinal\)/);
  const program = read('windows/Setup/Program.cs');
  for (const flag of ['hello-key-status', 'hello-key-create', 'hello-key-sign', 'hello-key-delete']) assert.match(program, new RegExp(`args\\.Has\\("${flag}"\\)`));
});

// ---------------------------------------------------------------- TPM attestation (Konrad: Hello only with it)

const fixture = (n) => readFileSync(new URL(`./fixtures/hello-aik/${n}.der`, import.meta.url));
const testRoot = fixture('root').toString('base64');
const b64 = (...parts) => Buffer.concat(parts).toString('base64');
const derLen = (n) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const der = (tag, ...body) => { const b = Buffer.concat(body); return Buffer.concat([Buffer.from([tag]), derLen(b.length), b]); };
/** A PKCS#7 SignedData holding the certificates (the other form Windows may hand out). */
const pkcs7 = (...certs) => der(0x30, Buffer.from('06092a864886f70d010702', 'hex'), der(0xa0, der(0x30,
  der(0x02, Buffer.from([1])), der(0x31), der(0x30, Buffer.from('06092a864886f70d010701', 'hex')), der(0xa0, ...certs), der(0x31))));
const at = (chain, extra = {}) => ({ status: 0, chain, blob: Buffer.from('blob').toString('base64'), ...extra });
const now = Date.parse('2027-01-01T00:00:00Z');

test('#537: an AIK certificate chaining to the pinned root counts – as DER sequence and as PKCS#7', () => {
  assert.deepEqual(verifyAttestation(at(b64(fixture('aik'), fixture('root'))), { roots: [testRoot], now }), { ok: true });
  assert.deepEqual(verifyAttestation(at(b64(fixture('aik'))), { roots: [testRoot], now }), { ok: true }, 'the root itself need not be in the buffer');
  assert.equal(chainCertificates(pkcs7(fixture('aik'), fixture('root'))).length, 2);
  assert.deepEqual(verifyAttestation(at(b64(pkcs7(fixture('aik'), fixture('root')))), { roots: [testRoot], now }), { ok: true });
});

test('#537: no Hello without a real TPM attestation', () => {
  const opts = { roots: [testRoot], now };
  assert.equal(verifyAttestation(at(b64(fixture('aik')), { status: 2 }), opts).ok, false, 'NotSupported (software key)');
  assert.equal(verifyAttestation(null, opts).ok, false);
  assert.equal(verifyAttestation(at(b64(fixture('aik')), { blob: '' }), opts).ok, false, 'no blob');
  assert.equal(verifyAttestation(at(b64(fixture('other'))), opts).ok, false, 'a certificate without the AIK usage');
  assert.equal(verifyAttestation(at(b64(fixture('aik'), fixture('root')))).ok, false, 'the test root is not Microsoft\'s TPM root');
  assert.equal(verifyAttestation(at(b64(fixture('aik'))), { roots: [testRoot], now: Date.parse('2001-01-01') }).ok, false, 'outside the validity');
  assert.equal(verifyAttestation(at('AAAA'), opts).ok, false, 'garbage');
  assert.equal(TPM_ROOTS.length, 1);
  const root = new X509Certificate(Buffer.from(TPM_ROOTS[0], 'base64'));
  assert.match(root.subject, /CN=Microsoft TPM Root Certificate Authority 2014/);
  assert.equal(root.fingerprint256.replaceAll(':', ''), '870C7A35CEAB3D59979F2C6A524042D404CB71518004350925FB2CED79A999DA');
});

// ---------------------------------------------------------------- live test 14.11.2026: AKID ≠ SKID (Microsoft's AIKs)
// test/fixtures/hello-aik-akid (make.sh): self-made, no certificate of a real device. The AIK's Authority Key Identifier
// (08:A8:01:5A…) does not match its intermediate's Subject Key Identifier (EF:C4:C7:98…) – OpenSSL's checkIssued refuses
// that; the name, the signature, the CA flag, the KeyUsage and the validity decide.
const akid = (n) => readFileSync(new URL(`./fixtures/hello-aik-akid/${n}.der`, import.meta.url));
const akidRoot = akid('root').toString('base64');
const akidOpts = { roots: [akidRoot], now };

test('live test: an AIK whose Authority Key Identifier does not match its issuer still chains (name + signature + CA)', () => {
  const aik = new X509Certificate(akid('aik'));
  const inter = new X509Certificate(akid('inter'));
  assert.equal(aik.checkIssued(inter), false, 'the fixture reproduces the mismatch OpenSSL refuses');
  assert.equal(aik.verify(inter.publicKey), true);
  assert.deepEqual(verifyAttestation(at(b64(akid('aik'), akid('inter'))), akidOpts), { ok: true });
  assert.deepEqual(verifyAttestation(at(b64(akid('aik'), akid('inter'), akid('root'))), akidOpts), { ok: true });
  assert.deepEqual(verifyAttestation(at(b64(pkcs7(akid('aik'), akid('inter'), akid('root')))), akidOpts), { ok: true });
});

test('live test: an intermediate that may not issue does not count – no CA, no keyCertSign, expired, other key, other name', () => {
  const reason = (inter) => verifyAttestation(at(b64(akid('aik'), akid(inter))), akidOpts);
  for (const bad of ['inter-noca', 'inter-nosign', 'inter-expired', 'inter-otherkey', 'inter-otherdn']) {
    assert.equal(reason(bad).ok, false, bad);
  }
  assert.equal(verifyAttestation(at(b64(akid('aik'))), akidOpts).ok, false, 'without the intermediate');
  assert.equal(verifyAttestation(at(b64(akid('aik'), akid('inter'))), { roots: TPM_ROOTS, now }).ok, false, 'only the pinned root anchors');
  assert.equal(verifyAttestation(at(b64(akid('aik'), akid('inter'))), { ...akidOpts, now: Date.parse('2036-01-01') }).ok, false, 'all expired');
  // A good intermediate next to a bad one of the same name: the good one is found, the bad one never helps alone.
  assert.equal(verifyAttestation(at(b64(akid('aik'), akid('inter-otherkey'), akid('inter'))), akidOpts).ok, true);
});

test('live test: the Windows Hello dialog of the key requests is brought to the front (create and sign), only the broker\'s', () => {
  const cs = read('windows/Setup/HelloKey.cs');
  assert.match(cs, /DialogClass = "Credential Dialog Xaml Host"/);
  assert.match(cs, /DialogProcess = "CredentialUIBroker"/);
  assert.match(cs, /\/\/ RequestCreateAsync\s+DialogToFront\(\);/, 'after the create request');
  assert.match(cs, /\/\/ RequestSignAsync\s+DialogToFront\(\);/, 'after the sign request');
  assert.match(cs, /IsWindowVisible\(dialog\) && IsBroker\(dialog\)/, 'never another window');
  assert.match(cs, /DialogSearch = TimeSpan\.FromSeconds\(3\)/, 'a short search, not for the whole wait');
  assert.match(cs, /IsBackground = true/, 'the search never keeps the helper alive');
  assert.match(cs, /AttachThreadInput\(me, target, false\)/, 'the input is always detached again');
  // #512 (window lock) has an owner window: its dialog opens over Keevault by itself.
  assert.match(read('windows/Setup/Hello.cs'), /RequestForWindowFn>\(factory, 6\)\(factory, new IntPtr\(hwnd\)/);
});
