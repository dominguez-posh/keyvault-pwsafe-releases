# Signature check of the release manifest (#501 part e), the same check as the app (desktop/update-verify.js): the
# signature of latest.yml must verify against one of the embedded keys (Data/update-keys.json = UPDATE_KEYS).
# ed25519: base64 signature over the bytes (RFC 8032, written here because .NET has no Ed25519); es256: WebAuthn
# assertion of a hardware key over SHA-256("keevault-release-v1" || bytes). Nothing here talks to the network.

Add-Type -AssemblyName System.Numerics

$script:KsBig = [System.Numerics.BigInteger]
$script:KsEdP = [System.Numerics.BigInteger]::Pow(2, 255) - 19
$script:KsEdL = [System.Numerics.BigInteger]::Pow(2, 252) + [System.Numerics.BigInteger]::Parse('27742317777372353535851937790883648493')
$script:KsEdD = [System.Numerics.BigInteger]::Parse('37095705934669439343138083508754565189542113879843219016388785533085940283555')
$script:KsEdD2 = ($script:KsEdD * 2) % $script:KsEdP
$script:KsEdI = [System.Numerics.BigInteger]::Parse('19681161376707505956807079304988542015446066515923890162744021073123829784752')
$script:KsEdB = @(
    [System.Numerics.BigInteger]::Parse('15112221349535400772501151409588531511454012693041857206046113283949847762202'),
    [System.Numerics.BigInteger]::Parse('46316835694926478169428394003475163141307993866256225615783033603165251855960'),
    [System.Numerics.BigInteger]::One
)
$script:KsEdB += @((($script:KsEdB[0] * $script:KsEdB[1]) % $script:KsEdP))
$script:KsSpkiEd25519 = '302a300506032b6570032100'
$script:KsSpkiP256 = '3059301306072a8648ce3d020106082a8648ce3d030107034200'
$script:KsReleaseOrigin = 'http://localhost'
$script:KsReleaseRpId = 'localhost'
$script:KsChallengePrefix = 'keevault-release-v1'

function Get-KsEdMod($A) {
    $r = [System.Numerics.BigInteger]::Remainder($A, $script:KsEdP)
    if ($r.Sign -lt 0) { $r = $r + $script:KsEdP }
    return $r
}

function ConvertFrom-KsLe([byte[]] $Bytes) {
    # Little-endian unsigned: one zero byte at the end keeps the number positive.
    $b = New-Object byte[] ($Bytes.Length + 1)
    [Array]::Copy($Bytes, $b, $Bytes.Length)
    return [System.Numerics.BigInteger]::new($b)
}

function Add-KsEdPoint($P, $Q) {
    # Extended coordinates (X, Y, Z, T), RFC 8032 5.1.4; also right for P = Q.
    $a = Get-KsEdMod (($P[1] - $P[0]) * ($Q[1] - $Q[0]))
    $b = Get-KsEdMod (($P[1] + $P[0]) * ($Q[1] + $Q[0]))
    $c = Get-KsEdMod ($P[3] * $script:KsEdD2 * $Q[3])
    $d = Get-KsEdMod ($P[2] * 2 * $Q[2])
    $e = $b - $a; $f = $d - $c; $g = $d + $c; $h = $b + $a
    return @((Get-KsEdMod ($e * $f)), (Get-KsEdMod ($g * $h)), (Get-KsEdMod ($f * $g)), (Get-KsEdMod ($e * $h)))
}

function Get-KsEdMul($Scalar, $P) {
    $q = @([System.Numerics.BigInteger]::Zero, [System.Numerics.BigInteger]::One, [System.Numerics.BigInteger]::One, [System.Numerics.BigInteger]::Zero)
    $bytes = $Scalar.ToByteArray()
    for ($i = $bytes.Length * 8 - 1; $i -ge 0; $i--) {
        $q = Add-KsEdPoint $q $q
        if (($bytes[$i -shr 3] -shr ($i -band 7)) -band 1) { $q = Add-KsEdPoint $q $P }
    }
    return $q
}

function ConvertFrom-KsEdPoint([byte[]] $Bytes) {
    # Decodes a compressed point; $null when it is not on the curve or not canonical.
    if ($Bytes.Length -ne 32) { return $null }
    $b = [byte[]] $Bytes.Clone()
    $sign = ($b[31] -shr 7) -band 1
    $b[31] = $b[31] -band 0x7f
    $y = ConvertFrom-KsLe $b
    if ($y -ge $script:KsEdP) { return $null }
    $p = $script:KsEdP
    $yy = Get-KsEdMod ($y * $y)
    $u = Get-KsEdMod ($yy - 1)
    $v = Get-KsEdMod ($script:KsEdD * $yy + 1)
    $x2 = Get-KsEdMod ($u * [System.Numerics.BigInteger]::ModPow($v, $p - 2, $p))
    $x = [System.Numerics.BigInteger]::ModPow($x2, [System.Numerics.BigInteger]::Divide($p + 3, 8), $p)
    if (-not (Get-KsEdMod ($x * $x - $x2)).IsZero) { $x = Get-KsEdMod ($x * $script:KsEdI) }
    if (-not (Get-KsEdMod ($x * $x - $x2)).IsZero) { return $null }
    if ($x.IsZero -and $sign -eq 1) { return $null }
    if ([int] (-not $x.IsEven) -ne $sign) { $x = $p - $x }
    return @($x, $y, [System.Numerics.BigInteger]::One, (Get-KsEdMod ($x * $y)))
}

function Test-KsEd25519([byte[]] $PublicKey, [byte[]] $Message, [byte[]] $Signature) {
    if ($PublicKey.Length -ne 32 -or $Signature.Length -ne 64) { return $false }
    $a = ConvertFrom-KsEdPoint $PublicKey
    $rBytes = [byte[]] $Signature[0..31]
    $r = ConvertFrom-KsEdPoint $rBytes
    if (-not $a -or -not $r) { return $false }
    $s = ConvertFrom-KsLe ([byte[]] $Signature[32..63])
    if ($s -ge $script:KsEdL) { return $false }
    $sha = [System.Security.Cryptography.SHA512]::Create()
    # R || A || M without PowerShell array addition: an empty or $null message must not add an element. The length is
    # taken explicitly: "if ($Message)" would judge a one-byte array by its value, so 0x00 would count as empty.
    $len = if ($null -eq $Message) { 0 } else { $Message.Length }
    $buf = New-Object byte[] (64 + $len)
    [Array]::Copy($rBytes, 0, $buf, 0, 32)
    [Array]::Copy($PublicKey, 0, $buf, 32, 32)
    if ($len -gt 0) { [Array]::Copy($Message, 0, $buf, 64, $len) }
    try { $h = $sha.ComputeHash($buf) } finally { $sha.Dispose() }
    $k = [System.Numerics.BigInteger]::Remainder((ConvertFrom-KsLe $h), $script:KsEdL)
    $left = Get-KsEdMul $s $script:KsEdB
    $right = Add-KsEdPoint $r (Get-KsEdMul $k $a)
    # Same point: X1/Z1 = X2/Z2 and Y1/Z1 = Y2/Z2.
    return ((Get-KsEdMod ($left[0] * $right[2] - $right[0] * $left[2])).IsZero -and (Get-KsEdMod ($left[1] * $right[2] - $right[1] * $left[2])).IsZero)
}

function ConvertTo-KsHex([byte[]] $Bytes) { return (($Bytes | ForEach-Object { $_.ToString('x2') }) -join '') }

function Get-KsSha256([byte[]] $Bytes) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return , $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
}

function ConvertTo-KsBase64Url([byte[]] $Bytes) { return ([Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')) }

function ConvertFrom-KsDerSignature([byte[]] $Der) {
    # ECDSA DER (SEQUENCE of two INTEGERs) -> r || s with 32 bytes each; $null when malformed.
    if ($Der.Length -lt 8 -or $Der[0] -ne 0x30 -or $Der[1] -ne $Der.Length - 2) { return $null }
    $out = New-Object byte[] 64
    $pos = 2
    for ($n = 0; $n -lt 2; $n++) {
        if ($pos + 2 -gt $Der.Length -or $Der[$pos] -ne 0x02) { return $null }
        $len = $Der[$pos + 1]; $pos += 2
        if ($len -lt 1 -or $pos + $len -gt $Der.Length) { return $null }
        $int = [byte[]] $Der[$pos..($pos + $len - 1)]; $pos += $len
        while ($int.Length -gt 1 -and $int[0] -eq 0) { $int = [byte[]] $int[1..($int.Length - 1)] }
        if ($int.Length -gt 32) { return $null }
        [Array]::Copy($int, 0, $out, $n * 32 + 32 - $int.Length, $int.Length)
    }
    if ($pos -ne $Der.Length) { return $null }
    return , $out
}

function Test-KsP256([byte[]] $Spki, [byte[]] $Data, [byte[]] $DerSignature) {
    if ($Spki.Length -ne 91 -or (ConvertTo-KsHex ([byte[]] $Spki[0..25])) -ne $script:KsSpkiP256 -or $Spki[26] -ne 4) { return $false }
    $sig = ConvertFrom-KsDerSignature $DerSignature
    if (-not $sig) { return $false }
    $params = New-Object System.Security.Cryptography.ECParameters
    $params.Curve = [System.Security.Cryptography.ECCurve+NamedCurves]::nistP256
    $q = New-Object System.Security.Cryptography.ECPoint
    $q.X = [byte[]] $Spki[27..58]
    $q.Y = [byte[]] $Spki[59..90]
    $params.Q = $q
    $ec = [System.Security.Cryptography.ECDsa]::Create()
    try {
        $ec.ImportParameters($params)
        return $ec.VerifyData($Data, $sig, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
    }
    finally { $ec.Dispose() }
}

function Test-KsReleaseAssertion([byte[]] $Manifest, [string] $Text, [byte[]] $Spki) {
    # Same rules as verifyAssertion in desktop/update-verify.js.
    $a = $Text | ConvertFrom-Json
    if ([string] $a.alg -ne 'es256') { return $false }
    $authData = [Convert]::FromBase64String([string] $a.authData)
    $clientBytes = [Convert]::FromBase64String([string] $a.clientDataJSON)
    if ($authData.Length -lt 37) { return $false }
    $client = [System.Text.Encoding]::UTF8.GetString($clientBytes) | ConvertFrom-Json
    if ([string] $client.type -ne 'webauthn.get' -or ($client.PSObject.Properties['crossOrigin'] -and $client.crossOrigin -eq $true)) { return $false }
    if ([string] $client.origin -ne $script:KsReleaseOrigin) { return $false }
    $challenge = ConvertTo-KsBase64Url (Get-KsSha256 ([byte[]] ([System.Text.Encoding]::UTF8.GetBytes($script:KsChallengePrefix) + $Manifest)))
    if ([string] $client.challenge -cne $challenge) { return $false }
    $rpHash = Get-KsSha256 ([System.Text.Encoding]::UTF8.GetBytes($script:KsReleaseRpId))
    if ((ConvertTo-KsHex ([byte[]] $authData[0..31])) -ne (ConvertTo-KsHex $rpHash)) { return $false }
    $flags = $authData[32]
    if (-not ($flags -band 0x01) -or -not ($flags -band 0x04) -or ($flags -band 0x18)) { return $false }
    $signed = [byte[]] ($authData + (Get-KsSha256 $clientBytes))
    return (Test-KsP256 $Spki $signed ([Convert]::FromBase64String([string] $a.signature)))
}

function Get-KsUpdateKeys {
    if ($script:KsUpdateKeys) { return $script:KsUpdateKeys }
    $file = Join-Path (Join-Path (Split-Path $PSScriptRoot -Parent) 'Data') 'update-keys.json'
    $script:KsUpdateKeys = @([System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8).TrimStart([char] 0xFEFF) | ConvertFrom-Json)
    return $script:KsUpdateKeys
}

function Test-KsManifestSignature([byte[]] $Manifest, [string] $Signature, $Keys = (Get-KsUpdateKeys)) {
    # $true only when the signature belongs to exactly these bytes and one of the keys (like verifyManifest).
    if (-not $Signature) { return $false }
    $text = $Signature.Trim()
    foreach ($k in @($Keys)) {
        try {
            if (-not $k -or -not $k.publicKey) { continue }
            $spki = [Convert]::FromBase64String([string] $k.publicKey)
            if ($k.alg -eq 'ed25519' -and -not $text.StartsWith('{')) {
                if ($spki.Length -ne 44 -or (ConvertTo-KsHex ([byte[]] $spki[0..11])) -ne $script:KsSpkiEd25519) { continue }
                if (Test-KsEd25519 ([byte[]] $spki[12..43]) $Manifest ([Convert]::FromBase64String($text))) { return $true }
            }
            elseif ($k.alg -eq 'es256' -and $text.StartsWith('{')) {
                if (Test-KsReleaseAssertion $Manifest $text $spki) { return $true }
            }
        }
        catch { continue }
    }
    return $false
}
