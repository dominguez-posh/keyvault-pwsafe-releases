# Updater scenarios (#501 part e) against release folders that test/setup-tool-501e.test.js builds with a test key:
# a/ 99.0.0 (Ed25519), b/ 99.1.0 (hardware key assertion), badsig, otherkey, badsums, badzip, slip. Downloads are
# read from those folders; nothing goes to the network. Prints "PASS <name>" or "FAIL <name> -- <reason>".
param([Parameter(Mandatory)][string] $Root, [Parameter(Mandatory)][string] $Work)
$ErrorActionPreference = 'Stop'
$tool = Split-Path $PSScriptRoot -Parent

function Assert($Cond, [string] $Msg) { if (-not $Cond) { throw $Msg } }
function Throws([scriptblock] $Block, [string] $Pattern, [string] $Msg) {
    try { & $Block | Out-Null } catch { if ($_.Exception.Message -match $Pattern) { return } ; throw "$Msg (andere Meldung: $($_.Exception.Message))" }
    throw "$Msg (kein Fehler)"
}
$keys = [System.IO.File]::ReadAllText((Join-Path $Root 'keys.json')) | ConvertFrom-Json
$vectors = [System.IO.File]::ReadAllText((Join-Path $Root 'vectors.json')) | ConvertFrom-Json

function Use-Module([string] $Psd1) {
    Get-Module KeevaultSetup | Remove-Module -Force
    $script:Mod = Import-Module $Psd1 -Force -PassThru
    & $script:Mod { param($k) $script:KsUpdateKeys = @($k); $script:KsReleaseBase = 'https://release.test/' } $keys
}
function Use-Release([string] $Name) {
    $dir = Join-Path $Root $Name
    & $script:Mod {
        param($d)
        $script:KsFetch = {
            param([string] $Url)
            if ($Url -notlike 'https://release.test/*') { throw "unerwartete Adresse $Url" }
            $f = Join-Path $d ($Url -replace '^https://release\.test/', '')
            if (-not (Test-Path -LiteralPath $f)) { return $null }
            return , [System.IO.File]::ReadAllBytes($f)
        }.GetNewClosure()
    } $dir
}
function Get-Children([string] $Dir = $Work) { return @(Get-ChildItem -LiteralPath $Dir -Force | ForEach-Object { $_.Name }) }

Use-Module (Join-Path $tool 'KeevaultSetup\KeevaultSetup.psd1')
$scenarios = [ordered]@{
    'signature check: Ed25519 and hardware key assertion like the app, refusals' = {
        $m = [Convert]::FromBase64String($vectors.msg)
        $check = { param($sig, $bytes = $m) & $script:Mod { param($b, $s) Test-KsManifestSignature $b $s } $bytes $sig }
        Assert (& $check $vectors.ed) 'Ed25519-Signatur gilt'
        Assert (& $check $vectors.ec) 'Assertion des Sticks gilt'
        $m2 = [byte[]] $m.Clone(); $m2[0] = 0x56
        Assert (-not (& $check $vectors.ed $m2)) 'Ed25519 über geänderte Bytes gilt nicht'
        Assert (-not (& $check $vectors.ec $m2)) 'Assertion über geänderte Bytes gilt nicht'
        Assert (-not (& $check $vectors.ecBackedUp)) 'synchronisierter Passkey (BE/BS) gilt nicht'
        Assert (-not (& $check $vectors.ecNoPin)) 'ohne PIN (UV) gilt nicht'
        Assert (-not (& $check $vectors.ecOrigin)) 'andere Herkunft gilt nicht'
        Assert (-not (& $check '')) 'leere Signatur gilt nicht'
    }
    'Ed25519: RFC 8032 test vectors 1-3 and the non-canonical cases (S+L, y >= p in R and A, x = 0 with sign bit)' = {
        $hex = { param([string] $h) [byte[]] @(for ($i = 0; $i -lt $h.Length; $i += 2) { [Convert]::ToByte($h.Substring($i, 2), 16) }) }
        $ed = { param($pk, $msg, $sig) & $script:Mod { param($a, $b, $c) Test-KsEd25519 $a $b $c } $pk $msg $sig }
        $rfc = @(
            @('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '', 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'),
            @('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72', '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'),
            @('fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82', '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a')
        )
        foreach ($v in $rfc) {
            $pk = & $hex $v[0]; $msg = & $hex $v[1]; $sig = & $hex $v[2]
            Assert (& $ed $pk $msg $sig) "RFC-8032-Vektor gilt nicht: $($v[0])"
            $other = [byte[]] ($msg + [byte] 1)
            Assert (-not (& $ed $pk $other $sig)) "RFC-8032-Vektor gilt für eine andere Nachricht: $($v[0])"
        }
        $pk = & $hex $rfc[0][0]; $sig = & $hex $rfc[0][2]; $msg = [byte[]] @()
        # Empty message vs. the one byte 0x00 (Konrad): neither signature counts for the other message.
        $zero = [byte[]] @(0)
        Assert (-not (& $ed $pk $zero $sig)) 'Signatur über die leere Nachricht gilt für 0x00'
        $zpk = [Convert]::FromBase64String($vectors.zeroPub)
        $zsig = [Convert]::FromBase64String($vectors.zeroSig)
        $esig = [Convert]::FromBase64String($vectors.emptySig)
        Assert (& $ed $zpk $zero $zsig) 'Signatur über 0x00 gilt nicht'
        Assert (-not (& $ed $zpk $msg $zsig)) 'Signatur über 0x00 gilt für die leere Nachricht'
        Assert (& $ed $zpk $msg $esig) 'Signatur über die leere Nachricht gilt nicht'
        Assert (-not (& $ed $zpk $zero $esig)) 'Signatur über die leere Nachricht gilt für 0x00 (zweiter Schlüssel)'
        # S + L: the same point, but not canonical (S must be < L).
        $big = [System.Numerics.BigInteger]
        $l = $big::Pow(2, 252) + $big::Parse('27742317777372353535851937790883648493')
        $sBytes = New-Object byte[] 33; [Array]::Copy($sig, 32, $sBytes, 0, 32)
        $sl = ($big::new($sBytes) + $l).ToByteArray()
        $sig2 = [byte[]] $sig.Clone(); for ($i = 0; $i -lt 32; $i++) { $sig2[32 + $i] = $(if ($i -lt $sl.Length) { $sl[$i] } else { 0 }) }
        Assert (-not (& $ed $pk $msg $sig2)) 'S + L wird angenommen'
        # y = p (not canonical) and y = 1 with sign bit (x = 0, sign 1).
        $yp = & $hex 'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f'
        $x0 = & $hex '0100000000000000000000000000000000000000000000000000000000000080'
        foreach ($bad in @(@($yp, 'y >= p'), @($x0, 'x = 0 mit Vorzeichenbit'))) {
            Assert (-not (& $ed $bad[0] $msg $sig)) "A mit $($bad[1]) wird angenommen"
            $r = [byte[]] $sig.Clone(); [Array]::Copy($bad[0], 0, $r, 0, 32)
            Assert (-not (& $ed $pk $msg $r)) "R mit $($bad[1]) wird angenommen"
            Assert ($null -eq (& $script:Mod { param($b) ConvertFrom-KsEdPoint $b } $bad[0])) "Punkt mit $($bad[1]) wird dekodiert"
        }
    }
    'from the source code: verified, but never "available" and no install without a target' = {
        Use-Release 'a'
        $u = Get-KeevaultSetupUpdate
        Assert ($u.Verified -and $u.Latest -eq '99.0.0' -and -not $u.Packaged -and -not $u.Available) "Prüfung: $($u | ConvertTo-Json -Compress)"
        Throws { Install-KeevaultSetupUpdate -Confirm:$false } 'Quellcode' 'Installation aus dem Repository ohne Ziel'
    }
    'install: new folder next to the old one, checked content, nothing half done' = {
        Use-Release 'a'
        $r = Install-KeevaultSetupUpdate -Destination $Work -Confirm:$false
        Assert ($r.Installed -and (Test-Path -LiteralPath $r.Start)) "installiert: $($r | ConvertTo-Json -Compress)"
        Assert ((Get-Children) -join ',' -eq 'Keevault-Einrichtungstool-99.0.0') "Inhalt von Work: $((Get-Children) -join ',')"
        Assert (Test-Path -LiteralPath (Join-Path $r.Path 'setup-tool\policy\Keevault.admx')) 'installer/policy als setup-tool/policy'
        Assert (Test-Path -LiteralPath (Join-Path $r.Path 'extension\styles\app.css')) 'Stile der App dabei'
        Assert (-not (Test-Path -LiteralPath (Join-Path $r.Path 'setup-tool\tests'))) 'Tests nicht im Paket'
        Throws { Install-KeevaultSetupUpdate -Destination $Work -Confirm:$false } 'existiert schon' 'zweite Installation in denselben Ordner'
        $r2 = Install-KeevaultSetupUpdate -Destination (Join-Path $Work 'x') -WhatIf
        Assert (-not $r2.Installed -and -not (Test-Path -LiteralPath (Join-Path $Work 'x\Keevault-Einrichtungstool-99.0.0'))) '-WhatIf schreibt nichts'
    }
    'installed package: knows its version, takes a newer one (hardware key), refuses the same or an older one' = {
        Use-Module (Join-Path $Work 'Keevault-Einrichtungstool-99.0.0\setup-tool\KeevaultSetup\KeevaultSetup.psd1')
        try {
            $v = Get-KeevaultSetupVersion
            Assert ($v.Packaged -and $v.Version -eq '99.0.0') "Version: $($v | ConvertTo-Json -Compress)"
            Use-Release 'a'
            Assert (-not (Get-KeevaultSetupUpdate).Available) 'gleiche Version ist kein Update'
            $same = Install-KeevaultSetupUpdate -Confirm:$false
            Assert (-not $same.Installed) 'gleiche Version wird nicht installiert'
            Use-Release 'b'
            $u = Get-KeevaultSetupUpdate
            Assert ($u.Available -and $u.Latest -eq '99.1.0') "neuere Version: $($u | ConvertTo-Json -Compress)"
            $r = Install-KeevaultSetupUpdate -Confirm:$false
            Assert ($r.Installed -and (Test-Path -LiteralPath (Join-Path $Work 'Keevault-Einrichtungstool-99.1.0\setup-tool\version.json'))) "neben dem alten: $($r.Path)"
            Assert (Test-Path -LiteralPath (Join-Path $Work 'Keevault-Einrichtungstool-99.0.0\setup-tool\Keevault-Setup.ps1')) 'alte Version bleibt'
        }
        finally { Use-Module (Join-Path $tool 'KeevaultSetup\KeevaultSetup.psd1') }
        Use-Module (Join-Path $Work 'Keevault-Einrichtungstool-99.1.0\setup-tool\KeevaultSetup\KeevaultSetup.psd1')
        try { Use-Release 'a'; Assert (-not (Get-KeevaultSetupUpdate).Available) 'ältere Version ist kein Update' }
        finally { Use-Module (Join-Path $tool 'KeevaultSetup\KeevaultSetup.psd1') }
    }
    'refused: changed manifest, foreign key, changed checksum list, changed package' = {
        $dest = Join-Path $Work 'refused'; [void] (New-Item -ItemType Directory -Path $dest -Force)
        $before = (Get-Children $dest) -join ','
        foreach ($case in @(@('badsig', 'Signatur'), @('otherkey', 'Signatur'), @('badsums', 'Prüfsummenliste'), @('badzip', 'Paket passt nicht'))) {
            Use-Release $case[0]
            Throws { Install-KeevaultSetupUpdate -Destination $dest -Confirm:$false } $case[1] "$($case[0]) abgelehnt"
        }
        Assert (((Get-Children $dest) -join ',') -eq $before) "nach Ablehnung neue Ordner: $((Get-Children $dest) -join ',')"
    }
    'refused: package with a path out of its folder (zip slip), nothing written outside, nothing left' = {
        $dest = Join-Path $Work 'refused'; [void] (New-Item -ItemType Directory -Path $dest -Force)
        $before = (Get-Children $dest) -join ','
        Use-Release 'slip'
        Throws { Install-KeevaultSetupUpdate -Destination $dest -Confirm:$false } 'unzulässigen Eintrag' 'Zip-Slip abgelehnt'
        Assert (-not (Test-Path -LiteralPath (Join-Path (Split-Path $Work -Parent) 'evil.txt'))) 'Datei außerhalb geschrieben'
        Assert (((Get-Children $dest) -join ',') -eq $before) "Reste: $((Get-Children $dest) -join ',')"
    }
    'download only through the fixed https address' = {
        Use-Module (Join-Path $tool 'KeevaultSetup\KeevaultSetup.psd1')   # the module's own download, not the stand-in
        Throws { & $script:Mod { & $script:KsFetch 'http://release.test/latest.yml' } } 'https' 'http abgelehnt'
        $base = & $script:Mod { $script:KsReleaseBase }
        Assert ($base -eq 'https://release.test/') 'Testadresse gesetzt'
    }
}
foreach ($name in $scenarios.Keys) {
    try { & $scenarios[$name]; [Console]::Out.WriteLine("PASS $name") }
    catch { [Console]::Out.WriteLine("FAIL $name -- $($_.Exception.Message) @ $($_.ScriptStackTrace -replace '\r?\n', ' | ')") }
}
