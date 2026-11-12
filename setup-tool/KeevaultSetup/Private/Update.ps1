# Updater of the portable tool (#501 part e). The tool is a release asset (Keevault-Einrichtungstool-<version>.zip,
# scripts/pack-setup-tool.mjs) and so listed in SHA256SUMS.txt, whose hash is a line of latest.yml (kvSha256Sums). The
# updater accepts a version only when latest.yml verifies against the embedded keys like in the app (Crypto.ps1), the
# list matches the manifest and the ZIP matches the list. It never overwrites itself: the new version goes into a new
# folder next to the current one (first into a temporary folder, checked, then renamed); the old one stays.
# Authenticode signing of the scripts follows with 1.0.

$script:KsReleaseBase = 'https://github.com/dominguez-posh/keyvault-pwsafe-releases/releases/latest/download/'
$script:KsPackagePrefix = 'Keevault-Einrichtungstool-'
$script:KsMaxDownload = 52428800
$script:KsMaxUnpacked = 104857600
$script:KsMaxEntries = 3000
$script:KsUpdateKeys = $null
$script:KsFetch = {
    # -> byte[] or $null for 404. Only https; the size is capped.
    param([string] $Url)
    if ($Url -notlike 'https://*') { throw (KsT 'update.https') }
    if ($PSVersionTable.PSVersion.Major -lt 6) { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 }
    $tmp = [System.IO.Path]::GetTempFileName()
    try {
        try { Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 60 | Out-Null }
        catch {
            $code = 0
            if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) { $code = [int] $_.Exception.Response.StatusCode }
            if ($code -eq 404) { return $null }
            throw (KsT 'update.download' ($Url -replace '^.*/', '') $_.Exception.Message)
        }
        if ((Get-Item -LiteralPath $tmp).Length -gt $script:KsMaxDownload) { throw (KsT 'update.tooBig') }
        return , [System.IO.File]::ReadAllBytes($tmp)
    }
    finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
}

function Get-KsPackageRoot { return (Split-Path (Get-KsToolRoot) -Parent) }

function Get-KeevaultSetupVersion {
    <#
    .SYNOPSIS
        Version des Tools: aus setup-tool\version.json (Paket) oder „Entwicklungsstand“ (Repository).
    #>
    [CmdletBinding()]
    param()
    $file = Join-Path (Get-KsToolRoot) 'version.json'
    if (Test-Path -LiteralPath $file) {
        $v = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8).TrimStart([char] 0xFEFF) | ConvertFrom-Json
        if ([string] $v.version -match '^\d+\.\d+\.\d+$') {
            return [pscustomobject]@{ Version = [string] $v.version; Commit = [string] $v.commit; Packaged = $true; Root = (Get-KsPackageRoot) }
        }
    }
    return [pscustomobject]@{ Version = ''; Commit = ''; Packaged = $false; Root = (Get-KsPackageRoot) }
}

function Get-KsLine([string] $Text, [string] $Key) {
    $m = [regex]::Match($Text, "(?m)^$([regex]::Escape($Key)):\s*['""]?([^'""\r\n]+?)['""]?\s*$")
    if ($m.Success) { return $m.Groups[1].Value }
    return ''
}

function Get-KeevaultSetupUpdate {
    <#
    .SYNOPSIS
        Prüft, ob eine neuere Version des Tools veröffentlicht ist. Liest nur; jede Antwort ist gegen die eingebetteten
        Schlüssel geprüft (wie die App), sonst Fehler.
    #>
    [CmdletBinding()]
    param()
    $cur = Get-KeevaultSetupVersion
    $yml = & $script:KsFetch "$($script:KsReleaseBase)latest.yml"
    if (-not $yml -or $yml.Length -gt 65536) { throw (KsT 'update.noManifest') }
    $ok = $false
    foreach ($name in 'latest.yml.sig2', 'latest.yml.sig') {
        $sig = & $script:KsFetch "$($script:KsReleaseBase)$name"
        if ($sig -and $sig.Length -lt 16384 -and (Test-KsManifestSignature $yml ([System.Text.Encoding]::UTF8.GetString($sig)))) { $ok = $true; break }
    }
    if (-not $ok) { throw (KsT 'update.badSignature') }
    $text = [System.Text.Encoding]::UTF8.GetString($yml)
    $version = Get-KsLine $text 'version'
    $sumsHash = (Get-KsLine $text 'kvSha256Sums').ToLowerInvariant()
    if ($version -notmatch '^\d+\.\d+\.\d+$' -or $sumsHash -notmatch '^[0-9a-f]{64}$') { throw (KsT 'update.badManifest') }
    $sums = & $script:KsFetch "$($script:KsReleaseBase)SHA256SUMS.txt"
    if (-not $sums -or (ConvertTo-KsHex (Get-KsSha256 $sums)) -ne $sumsHash) { throw (KsT 'update.badSums') }
    $package = "$($script:KsPackagePrefix)$version.zip"
    $m = [regex]::Match([System.Text.Encoding]::UTF8.GetString($sums), "(?m)^([0-9a-f]{64})  $([regex]::Escape($package))\r?$")
    if (-not $m.Success) { throw (KsT 'update.notInRelease' $version) }
    $newer = $cur.Packaged -and ([version] $version -gt [version] $cur.Version)
    return [pscustomobject]@{ Current = $cur.Version; Packaged = $cur.Packaged; Latest = $version; Available = [bool] $newer; Package = $package; Sha256 = $m.Groups[1].Value; Verified = $true }
}

function Test-KsZipEntryName([string] $Name) {
    # Only relative paths with / below the two folders of the package: no drive, no root, no . or .., no backslash.
    if (-not $Name -or $Name.Length -gt 400 -or $Name -match '[\\:*?"<>|\x00-\x1f]' -or $Name.StartsWith('/')) { return $false }
    foreach ($part in ($Name.TrimEnd('/') -split '/')) { if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part.EndsWith(' ')) { return $false } }
    return ($Name -like 'setup-tool/*' -or $Name -like 'extension/styles/*')
}

function Expand-KsPackage([byte[]] $Zip, [string] $Target) {
    Add-Type -AssemblyName System.IO.Compression
    $stream = New-Object System.IO.MemoryStream (, $Zip)
    $archive = New-Object System.IO.Compression.ZipArchive ($stream, [System.IO.Compression.ZipArchiveMode]::Read)
    try {
        $entries = @($archive.Entries)
        if ($entries.Count -gt $script:KsMaxEntries) { throw (KsT 'update.badZip' 'count') }
        $total = 0
        foreach ($e in $entries) {
            if (-not (Test-KsZipEntryName $e.FullName)) { throw (KsT 'update.badZip' $e.FullName) }
            $total += $e.Length
        }
        if ($total -gt $script:KsMaxUnpacked) { throw (KsT 'update.badZip' 'size') }
        $root = [System.IO.Path]::GetFullPath($Target).TrimEnd('\') + '\'
        foreach ($e in $entries) {
            $dest = [System.IO.Path]::GetFullPath((Join-Path $Target ($e.FullName -replace '/', '\')))
            if (-not $dest.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { throw (KsT 'update.badZip' $e.FullName) }
            if ($e.FullName.EndsWith('/')) { [void] (New-Item -ItemType Directory -Path $dest -Force); continue }
            [void] (New-Item -ItemType Directory -Path (Split-Path $dest -Parent) -Force)
            $in = $e.Open()
            try {
                $out = [System.IO.File]::Open($dest, [System.IO.FileMode]::CreateNew)
                try { $in.CopyTo($out) } finally { $out.Dispose() }
            }
            finally { $in.Dispose() }
        }
    }
    finally { $archive.Dispose(); $stream.Dispose() }
}

function Install-KeevaultSetupUpdate {
    <#
    .SYNOPSIS
        Lädt die neuere Version, prüft Signatur und Prüfsummen und entpackt sie in einen neuen Ordner neben dem
        aktuellen. Das laufende Tool bleibt unverändert (Rückweg); danach die neue Version aus dem neuen Ordner starten.
    .EXAMPLE
        Install-KeevaultSetupUpdate     # fragt vorher nach
    #>
    [CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
    param([string] $Destination)
    $info = Get-KeevaultSetupUpdate
    if (-not $info.Packaged -and -not $Destination) { throw (KsT 'update.notPackaged') }
    if (-not $info.Available -and $info.Packaged) { return [pscustomobject]@{ Installed = $false; Version = $info.Latest; Path = ''; Start = ''; Reason = (KsT 'update.current' $info.Current) } }
    if (-not $Destination) { $Destination = Split-Path (Get-KsPackageRoot) -Parent }
    $target = Join-Path $Destination "Keevault-Einrichtungstool-$($info.Latest)"
    if (Test-Path -LiteralPath $target) { throw (KsT 'update.exists' $target) }
    if (-not $PSCmdlet.ShouldProcess($target, (KsT 'update.what' $info.Latest))) {
        return [pscustomobject]@{ Installed = $false; Version = $info.Latest; Path = $target; Start = ''; Reason = (KsT 'update.notConfirmed') }
    }
    $zip = & $script:KsFetch "$($script:KsReleaseBase)$($info.Package)"
    if (-not $zip -or (ConvertTo-KsHex (Get-KsSha256 $zip)) -ne $info.Sha256) { throw (KsT 'update.badPackage') }
    $partial = "$target.partial-$(New-KsRandomHex 4)"
    try {
        [void] (New-Item -ItemType Directory -Path $partial)
        Expand-KsPackage $zip $partial
        $vf = Join-Path $partial 'setup-tool\version.json'
        $ver = $null
        if (Test-Path -LiteralPath $vf) { $ver = [System.IO.File]::ReadAllText($vf, [System.Text.Encoding]::UTF8).TrimStart([char] 0xFEFF) | ConvertFrom-Json }
        if (-not $ver -or [string] $ver.version -ne $info.Latest -or -not (Test-Path -LiteralPath (Join-Path $partial 'setup-tool\KeevaultSetup\KeevaultSetup.psd1')) -or -not (Test-Path -LiteralPath (Join-Path $partial 'setup-tool\Keevault-Setup.ps1'))) {
            throw (KsT 'update.badContent')
        }
        # A virus scanner may still hold the new files for a moment: retry the rename briefly.
        for ($i = 0; ; $i++) {
            try { [System.IO.Directory]::Move($partial, $target); break }
            catch { if ($i -ge 20 -or (Test-Path -LiteralPath $target)) { throw }; Start-Sleep -Milliseconds 250 }
        }
    }
    catch {
        Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
        throw
    }
    return [pscustomobject]@{ Installed = $true; Version = $info.Latest; Path = $target; Start = (Join-Path $target 'setup-tool\Keevault-Setup.ps1'); Reason = '' }
}
