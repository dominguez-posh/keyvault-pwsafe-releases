#!/usr/bin/env bash
# Test certificates for desktop/hello-attest.js (#537, Live-Test 14.11.2026): a TPM chain whose AIK names an Authority
# Key Identifier that does not match the intermediate's Subject Key Identifier – as Microsoft's AIK certificates do –
# plus intermediates that must not count. Self-made with OpenSSL; no certificate of a real device (device identifiers,
# and tests go into the public export). Run in this folder: bash make.sh  (OpenSSL 3.4 or newer)
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: keep "/CN=…" as it is
cd "$(dirname "$0")"
T=.tmp-make # relative: Windows OpenSSL reads no MSYS /tmp paths
mkdir -p "$T"
trap 'rm -rf "$T"' EXIT
FROM=20250101000000Z
TO=20350101000000Z

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$T/root.key" 2>/dev/null
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$T/inter.key" 2>/dev/null
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$T/other.key" 2>/dev/null
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$T/aik.key" 2>/dev/null

cat > "$T/ext.cnf" <<'EOF'
[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[inter]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = EF:C4:C7:98:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF
authorityKeyIdentifier = keyid
[inter_noca]
basicConstraints = critical, CA:FALSE
keyUsage = critical, keyCertSign
subjectKeyIdentifier = EF:C4:C7:98:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF
[inter_nosign]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, digitalSignature
subjectKeyIdentifier = EF:C4:C7:98:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF
[akidsrc]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign
subjectKeyIdentifier = 08:A8:01:5A:10:20:30:40:50:60:70:80:90:A0:B0:C0:D0:E0:F0:01
[aik]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = 2.23.133.8.3
subjectAltName = critical, DNS:tpm.test.invalid
authorityKeyIdentifier = keyid:always
EOF

openssl req -new -key "$T/root.key" -subj "/CN=Test TPM Root CA" -out "$T/root.csr"
openssl x509 -req -in "$T/root.csr" -key "$T/root.key" -not_before $FROM -not_after $TO -extfile "$T/ext.cnf" -extensions root -outform DER -out root.der

inter() { # name, key, extensions, from, to, subject
  openssl req -new -key "$T/$2.key" -subj "$6" -out "$T/$1.csr"
  openssl x509 -req -in "$T/$1.csr" -CA root.der -CAform DER -CAkey "$T/root.key" -set_serial "0x$(openssl rand -hex 8)" \
    -not_before "$4" -not_after "$5" -extfile "$T/ext.cnf" -extensions "$3" -outform DER -out "$1.der"
}
inter inter inter inter $FROM $TO "/CN=STM-KEYID-TEST"
inter inter-noca inter inter_noca $FROM $TO "/CN=STM-KEYID-TEST"
inter inter-nosign inter inter_nosign $FROM $TO "/CN=STM-KEYID-TEST"
inter inter-expired inter inter 20200101000000Z 20210101000000Z "/CN=STM-KEYID-TEST"
inter inter-otherkey other inter $FROM $TO "/CN=STM-KEYID-TEST"
inter inter-otherdn inter inter $FROM $TO "/CN=STM-KEYID-OTHER"

# The AIK: empty subject, signed with the intermediate's key under the intermediate's name, but its Authority Key
# Identifier comes from a second certificate of that key with another Subject Key Identifier (08:A8:01:5A…) – it does not
# match the intermediate's (EF:C4:C7:98…), as with Microsoft's AIK certificates.
openssl req -new -key "$T/inter.key" -subj "/CN=STM-KEYID-TEST" -out "$T/akid.csr"
openssl x509 -req -in "$T/akid.csr" -key "$T/inter.key" -not_before $FROM -not_after $TO -extfile "$T/ext.cnf" -extensions akidsrc -out "$T/akid.pem"
openssl req -new -key "$T/aik.key" -subj "/" -out "$T/aik.csr"
openssl x509 -req -in "$T/aik.csr" -CA "$T/akid.pem" -CAkey "$T/inter.key" -set_serial "0x$(openssl rand -hex 8)"   -not_before $FROM -not_after $TO -extfile "$T/ext.cnf" -extensions aik -outform DER -out aik.der
echo "built: $(ls *.der | tr '\n' ' ')"
