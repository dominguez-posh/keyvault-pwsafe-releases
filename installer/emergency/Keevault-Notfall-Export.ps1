<#
.SYNOPSIS
    Keevault emergency export: reads every entry of Keevault vaults straight from Azure Key Vault – without the app.

.DESCRIPTION
    For the emergency plan: if Keevault cannot be used (app missing, broken, blocked), this script signs in to
    Azure, reads the entries of one or more Key Vaults and writes them UNENCRYPTED to a folder:
      - Keevault-Export.csv   (Bitwarden-compatible columns – also imports into Keevault, 1Password, KeePassXC …)
      - Keevault-Export.json  (complete, including additional fields, passkeys and server details)
      - Keevault-KeePass.xml  (KeePass 2 XML: KeePass → File → Import → KeePass XML (2.x))
      - Dateien\              (certificate files and file attachments)

    Requirements: PowerShell 7.2 or newer and read access to the secrets of the vault
    (Azure role "Key Vault Secrets User" or higher, also via PIM). Nothing else needs to be installed: the script
    uses Az PowerShell or the Azure CLI when present, otherwise a Microsoft device code sign-in.

    Vaults with extra protection (client-side encryption) need the master password or the recovery key (RK-…).
    Vaults protected with passkeys only cannot be opened by a script – keep a recovery key for the emergency.

    The output is not encrypted: store it only on an encrypted drive, import it, then delete it.

.PARAMETER Vault
    One or more Key Vaults: name (kv-team) or URL (https://kv-team.vault.azure.net).

.PARAMETER OutputFolder
    Target folder (created). Default: Desktop\Keevault-Notfall-<date>.

.PARAMETER Format
    All (default), Csv, Json or KeePass.

.PARAMETER TenantId
    Tenant of the vaults (ID or domain) when they are not in your home tenant.

.PARAMETER RecoveryKey
    Recovery key (RK-…) for vaults with extra protection; without it the script asks for the master password.

.EXAMPLE
    ./Keevault-Notfall-Export.ps1 -Vault kv-team-infrastruktur

.EXAMPLE
    ./Keevault-Notfall-Export.ps1 -Vault kv-team, kv-marketing -TenantId contoso.com -Format KeePass

.NOTES
    Keevault – https://keevault.de/wissen/notfall-export.html
    Read-only: the script never changes anything in Azure.
#>
#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)][string[]]$Vault,
    # Desktop, or the home folder where there is none (servers, Linux/macOS with PowerShell 7).
    [string]$OutputFolder = (Join-Path $(if ([Environment]::GetFolderPath('Desktop')) { [Environment]::GetFolderPath('Desktop') } else { $HOME }) ("Keevault-Notfall-" + (Get-Date -Format 'yyyyMMdd-HHmm'))),
    [ValidateSet('All', 'Csv', 'Json', 'KeePass')][string]$Format = 'All',
    [string]$TenantId = 'organizations',
    [string]$RecoveryKey
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$KvResource = 'https://vault.azure.net'
$ApiVersion = '7.4'
$SealedMarker = '{"kvpwsafe-sealed"'
$German = (Get-UICulture).TwoLetterISOLanguageName -eq 'de'
function Say([string]$de, [string]$en) { if ($German) { $de } else { $en } }

# ---------------------------------------------------------------- crypto (same format as extension/core/protect.js)

function ConvertFrom-Base64Url([string]$Text) {
    $s = $Text.Replace('-', '+').Replace('_', '/')
    switch ($s.Length % 4) { 2 { $s += '==' } 3 { $s += '=' } }
    return [Convert]::FromBase64String($s)
}

function Get-HkdfKey([byte[]]$Ikm, [string]$Info) {
    return [Security.Cryptography.HKDF]::DeriveKey([Security.Cryptography.HashAlgorithmName]::SHA256, $Ikm, 32, [byte[]]::new(32), [Text.Encoding]::UTF8.GetBytes($Info))
}

# AES-256-GCM: base64url(nonce 12 | ciphertext | tag 16), additional data = UTF-8 string.
function Unprotect-Sealed([byte[]]$Key, [string]$Sealed, [string]$Aad) {
    $data = ConvertFrom-Base64Url $Sealed
    if ($data.Length -lt 28) { throw (Say 'Verschlüsselte Daten sind zu kurz' 'Encrypted data too short') }
    $nonce = [byte[]]::new(12); [Array]::Copy($data, 0, $nonce, 0, 12)
    $tag = [byte[]]::new(16); [Array]::Copy($data, $data.Length - 16, $tag, 0, 16)
    $cipher = [byte[]]::new($data.Length - 28); [Array]::Copy($data, 12, $cipher, 0, $cipher.Length)
    $plain = [byte[]]::new($cipher.Length)
    $gcm = [Security.Cryptography.AesGcm]::new($Key, 16)
    try { $gcm.Decrypt($nonce, $cipher, $tag, $plain, [Text.Encoding]::UTF8.GetBytes($Aad)) } finally { $gcm.Dispose() }
    return $plain
}

function Get-PasswordKey([string]$Password, [byte[]]$Salt, [int]$Iterations) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Password.Normalize([Text.NormalizationForm]::FormC))
    $bits = [Security.Cryptography.Rfc2898DeriveBytes]::Pbkdf2($bytes, $Salt, $Iterations, [Security.Cryptography.HashAlgorithmName]::SHA256, 32)
    return Get-HkdfKey $bits 'kvpwsafe/password/v1'
}

# Recovery key "RK-XXXX-…": Base32 (RFC 4648) of 20 random bytes.
function ConvertFrom-RecoveryKey([string]$Code) {
    $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    $clean = ($Code.ToUpperInvariant() -replace '^\s*(RK|IN)[-\s]*', '') -replace '[^A-Z2-7]', ''
    $bits = 0; $value = 0; $out = [Collections.Generic.List[byte]]::new()
    foreach ($ch in $clean.ToCharArray()) {
        $value = (($value -shl 5) -bor $alphabet.IndexOf($ch)) -band 0xFFFF
        $bits += 5
        if ($bits -ge 8) { $out.Add([byte](($value -shr ($bits - 8)) -band 0xFF)); $bits -= 8 }
    }
    return $out.ToArray()
}

# Keyring (secret "pws-keyring"): the container key wrapped per unlock method; a script can use password and recovery key.
function Unlock-Keyring($Keyring, [string]$Password, [string]$Code) {
    foreach ($entry in $Keyring.entries) {
        $kek = $null
        if ($entry.type -eq 'password' -and $Password) {
            $kek = Get-PasswordKey $Password (ConvertFrom-Base64Url $entry.salt) ([int]$entry.iterations)
        } elseif ($entry.type -eq 'recovery' -and $Code) {
            $secret = ConvertFrom-RecoveryKey $Code
            if ($secret.Length -eq 20) { $kek = Get-HkdfKey $secret 'kvpwsafe/recovery/v1' }
        }
        if (-not $kek) { continue }
        try {
            return Unprotect-Sealed $kek $entry.wrapped "kvpwsafe/keyring/$($Keyring.scope)/$($entry.id)/$($entry.type)"
        } catch {
            # wrong password / key for this entry
        }
    }
    return $null
}

# ---------------------------------------------------------------- Azure sign-in and Key Vault

function Get-KeyVaultToken {
    if (Get-Command Get-AzAccessToken -ErrorAction SilentlyContinue) {
        try {
            if (-not (Get-AzContext -ErrorAction SilentlyContinue)) {
                if ($TenantId -ne 'organizations') { Connect-AzAccount -Tenant $TenantId | Out-Null } else { Connect-AzAccount | Out-Null }
            }
            $t = Get-AzAccessToken -ResourceUrl $KvResource
            if ($t.Token -is [securestring]) { return [Net.NetworkCredential]::new('', $t.Token).Password }
            return $t.Token
        } catch {
            Write-Verbose "Az PowerShell: $($_.Exception.Message)"
        }
    }
    if (Get-Command az -ErrorAction SilentlyContinue) {
        $azArgs = @('account', 'get-access-token', '--resource', $KvResource, '--query', 'accessToken', '-o', 'tsv')
        if ($TenantId -ne 'organizations') { $azArgs += @('--tenant', $TenantId) }
        $token = & az @azArgs 2>$null
        if ($LASTEXITCODE -eq 0 -and $token) { return ([string]$token).Trim() }
    }
    # Device code sign-in with Microsoft's public Azure CLI client – nothing to install.
    $client = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'
    $base = "https://login.microsoftonline.com/$TenantId/oauth2/v2.0"
    $dc = Invoke-RestMethod -Method Post -Uri "$base/devicecode" -Body @{ client_id = $client; scope = "$KvResource/.default offline_access" }
    Write-Host ''
    Write-Host $dc.message -ForegroundColor Yellow
    $deadline = (Get-Date).AddSeconds([int]$dc.expires_in)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds ([int]$dc.interval)
        try {
            $r = Invoke-RestMethod -Method Post -Uri "$base/token" -Body @{ grant_type = 'urn:ietf:params:oauth:grant-type:device_code'; client_id = $client; device_code = $dc.device_code }
            return $r.access_token
        } catch {
            $code = try { ($_.ErrorDetails.Message | ConvertFrom-Json).error } catch { '' }
            if ($code -in 'authorization_pending', 'slow_down') { continue }
            throw
        }
    }
    throw (Say 'Die Anmeldung ist abgelaufen.' 'The sign-in expired.')
}

function Invoke-KeyVault([string]$Uri) {
    try {
        return Invoke-RestMethod -Uri $Uri -Headers @{ Authorization = "Bearer $script:Token" }
    } catch {
        $status = try { [int]$_.Exception.Response.StatusCode } catch { 0 }
        if ($status -eq 401) { throw (Say "Kein Zugriff (401) – liegt der Tresor in einem anderen Tenant? Dann mit -TenantId <Tenant> starten." "No access (401) – is the vault in another tenant? Then run with -TenantId <tenant>.") }
        if ($status -eq 403) { throw (Say "Keine Berechtigung (403) – nötig ist die Rolle „Key Vault Secrets User“ (ggf. per PIM aktivieren) und Netzwerkzugriff auf den Tresor." "Forbidden (403) – the role ""Key Vault Secrets User"" is needed (activate via PIM if eligible) and network access to the vault.") }
        throw
    }
}

function Get-VaultSecrets([string]$BaseUrl) {
    $uri = "$BaseUrl/secrets?api-version=$ApiVersion&maxresults=25"
    while ($uri) {
        $page = Invoke-KeyVault $uri
        foreach ($s in $page.value) { $s }
        $uri = Get-Prop $page 'nextLink' $null
    }
}

function Get-SecretValue([string]$BaseUrl, [string]$Name) {
    return (Invoke-KeyVault "$BaseUrl/secrets/$([Uri]::EscapeDataString($Name))?api-version=$ApiVersion").value
}

function Read-PlainSecret([string]$Prompt) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    return [Net.NetworkCredential]::new('', $secure).Password
}

# ---------------------------------------------------------------- output

function Get-Prop($Object, [string]$Name, $Default = '') {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $v = $Object.$Name; if ($null -ne $v) { return $v } }
    return $Default
}

function Get-SafeFileName([string]$Name) {
    $clean = ($Name -replace '[\\/:*?"<>|\x00-\x1f]', '_').Trim()
    if (-not $clean) { $clean = 'datei' }
    return $clean.Substring(0, [Math]::Min(120, $clean.Length))
}

# Extra lines for the notes in CSV/KeePass: card, server and additional fields (JSON keeps everything structured).
function Get-ExtraLines($Doc) {
    $lines = [Collections.Generic.List[string]]::new()
    $card = Get-Prop $Doc 'card' $null
    if ($card) {
        foreach ($p in 'holder', 'number', 'expiry', 'cvc', 'pin') { $v = Get-Prop $card $p; if ($v) { $lines.Add("card.$p`: $v") } }
    }
    $server = Get-Prop $Doc 'server' $null
    if ($server) {
        foreach ($p in 'host', 'port', 'tvId', 'tvPassword', 'bastionUrl') { $v = Get-Prop $server $p; if ($v) { $lines.Add("server.$p`: $v") } }
        foreach ($p in 'rdpLink', 'tvLink', 'bastionLoginLink', 'bastionVmLink') { $v = Get-Prop $server $p; if ($v) { $lines.Add("server.$p (Eintrag): $v") } }
    }
    foreach ($f in @(Get-Prop $Doc 'fields' @())) {
        if ((Get-Prop $f 'type') -eq 'file') { $lines.Add("$(Get-Prop $f 'name'): [Datei $(Get-Prop $f 'fileName')]") } else { $lines.Add("$(Get-Prop $f 'name'): $(Get-Prop $f 'value')") }
    }
    return $lines
}

# KeePass 2 XML as UTF-8 bytes (KeePass → File → Import → KeePass XML (2.x)).
function ConvertTo-KeePassXml([object[]]$Entries) {
    $settings = [Xml.XmlWriterSettings]::new()
    $settings.Indent = $true
    $settings.Encoding = [Text.UTF8Encoding]::new($false)
    $stream = [IO.MemoryStream]::new()
    $w = [Xml.XmlWriter]::Create($stream, $settings)
    $uuid = { [Convert]::ToBase64String([guid]::NewGuid().ToByteArray()) }
    $string = {
        param($key, $value, [bool]$protect)
        $w.WriteStartElement('String'); $w.WriteElementString('Key', $key)
        $w.WriteStartElement('Value'); if ($protect) { $w.WriteAttributeString('ProtectInMemory', 'True') }; $w.WriteString([string]$value); $w.WriteEndElement()
        $w.WriteEndElement()
    }
    # Tree: vault → folder path → entries.
    $tree = [ordered]@{ '__entries' = [Collections.Generic.List[object]]::new() }
    foreach ($e in $Entries) {
        $groupPath = @($e.VaultName) + @(([string](Get-Prop $e.Doc 'folder')).Split('/', [StringSplitOptions]::RemoveEmptyEntries))
        $node = $tree
        foreach ($part in $groupPath) { if (-not $node.Contains($part)) { $node[$part] = [ordered]@{ '__entries' = [Collections.Generic.List[object]]::new() } }; $node = $node[$part] }
        $node['__entries'].Add($e)
    }
    $writeGroup = $null
    $writeGroup = {
        param($name, $node)
        $w.WriteStartElement('Group'); $w.WriteElementString('UUID', (& $uuid)); $w.WriteElementString('Name', $name)
        foreach ($e in $node['__entries']) {
            $d = $e.Doc
            $w.WriteStartElement('Entry'); $w.WriteElementString('UUID', (& $uuid))
            & $string 'Title' (Get-Prop $d 'title') $false
            & $string 'UserName' (Get-Prop $d 'username') $false
            & $string 'Password' (Get-Prop $d 'password') $true
            & $string 'URL' (@(Get-Prop $d 'urls' @()) | Select-Object -First 1) $false
            $notes = (@([string](Get-Prop $d 'notes')) + @(Get-ExtraLines $d)) -join "`n"
            & $string 'Notes' $notes.Trim() $false
            $totp = [string](Get-Prop $d 'totp')
            if ($totp) { & $string 'otp' ($(if ($totp -like 'otpauth://*') { $totp } else { "otpauth://totp/Keevault?secret=$($totp -replace '\s', '')" })) $true }
            $more = @(Get-Prop $d 'urls' @()) | Select-Object -Skip 1
            $i = 1; foreach ($u in $more) { & $string "URL$i" $u $false; $i++ }
            $w.WriteEndElement()
        }
        foreach ($key in @($node.Keys)) { if ($key -ne '__entries') { & $writeGroup $key $node[$key] } }
        $w.WriteEndElement()
    }
    $w.WriteStartDocument()
    $w.WriteStartElement('KeePassFile')
    $w.WriteStartElement('Meta'); $w.WriteElementString('Generator', 'Keevault-Notfall-Export'); $w.WriteEndElement()
    $w.WriteStartElement('Root')
    & $writeGroup 'Keevault' $tree
    $w.WriteEndElement(); $w.WriteEndElement(); $w.WriteEndDocument()
    $w.Close()
    return , $stream.ToArray()
}

# A dot-sourced script (tests) only loads the functions above.
if ($MyInvocation.InvocationName -eq '.') { return }

# ---------------------------------------------------------------- main

Write-Host ''
Write-Host (Say 'Keevault Notfall-Export – liest die Einträge direkt aus Azure Key Vault (nur lesend).' 'Keevault emergency export – reads the entries straight from Azure Key Vault (read-only).') -ForegroundColor Cyan
Write-Host (Say 'ACHTUNG: Die Ausgabe ist UNVERSCHLÜSSELT. Nur auf verschlüsselten Laufwerken speichern und nach dem Import löschen.' 'WARNING: the output is NOT ENCRYPTED. Store it only on encrypted drives and delete it after importing.') -ForegroundColor Yellow
Write-Host ''

$script:Token = Get-KeyVaultToken
$all = [Collections.Generic.List[object]]::new()
$failed = 0

foreach ($v in $Vault) {
    $url = if ($v -match '^https://') { $v.TrimEnd('/') } else { "https://$($v.Trim()).vault.azure.net" }
    $vaultHost = ([Uri]$url).Host.ToLowerInvariant()
    $vaultName = $vaultHost.Split('.')[0]
    Write-Host (Say "Tresor $vaultHost …" "Vault $vaultHost …")
    try {
        $secrets = @(Get-VaultSecrets $url)
        $names = $secrets | ForEach-Object { ($_.id -split '/')[-1] }
        $containerKey = $null
        if ($names -contains 'pws-keyring') {
            $keyring = (Get-SecretValue $url 'pws-keyring') | ConvertFrom-Json
            $password = if ($RecoveryKey) { '' } else { Read-PlainSecret (Say "  Zusätzlich geschützt – Masterpasswort (leer = Wiederherstellungsschlüssel)" "  Extra protection – master password (empty = recovery key)") }
            $code = $RecoveryKey
            if (-not $password -and -not $code) { $code = Read-PlainSecret (Say '  Wiederherstellungsschlüssel (RK-…)' '  Recovery key (RK-…)') }
            $containerKey = Unlock-Keyring $keyring $password $code
            if (-not $containerKey) { throw (Say 'Masterpasswort bzw. Wiederherstellungsschlüssel passt nicht.' 'Master password or recovery key does not match.') }
        }
        $count = 0
        foreach ($s in $secrets) {
            $name = ($s.id -split '/')[-1]
            $tags = Get-Prop $s 'tags' $null
            $isItem = (Get-Prop $tags 'kvpwsafe') -eq 'item' -or ([string](Get-Prop $s 'contentType')) -like 'application/vnd.kvpwsafe.item+json*'
            if (-not $isItem -or (Get-Prop $s 'managed' $false)) { continue }
            $value = Get-SecretValue $url $name
            if ($value.StartsWith($SealedMarker)) {
                if (-not $containerKey) { throw (Say "„$name“ ist verschlüsselt, der Tresor hat aber keinen Schlüsselbund." """$name"" is encrypted but the vault has no keyring.") }
                $value = [Text.Encoding]::UTF8.GetString((Unprotect-Sealed $containerKey ($value | ConvertFrom-Json).data "$vaultHost/$name"))
            }
            $doc = try { $value | ConvertFrom-Json } catch { [pscustomobject]@{ type = 'note'; title = $name; notes = $value } }
            $all.Add([pscustomobject]@{ VaultName = $vaultName; VaultHost = $vaultHost; Id = $name; Doc = $doc })
            $count++
        }
        Write-Host (Say "  $count Einträge gelesen" "  $count entries read") -ForegroundColor Green
    } catch {
        $failed++
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    }
}

if (-not $all.Count) { Write-Host (Say 'Keine Einträge gefunden – nichts geschrieben.' 'No entries found – nothing written.') -ForegroundColor Yellow; exit 1 }

New-Item -ItemType Directory -Force -Path $OutputFolder | Out-Null
$filesDir = Join-Path $OutputFolder 'Dateien'

# Certificates and file attachments as real files.
foreach ($e in $all) {
    $d = $e.Doc
    $cert = Get-Prop $d 'cert' $null
    $attachments = @(@(Get-Prop $d 'fields' @()) | Where-Object { (Get-Prop $_ 'type') -eq 'file' -and (Get-Prop $_ 'value') })
    if ($cert -and (Get-Prop $cert 'data')) { $attachments += [pscustomobject]@{ fileName = (Get-Prop $cert 'fileName' 'zertifikat.pfx'); value = $cert.data } }
    foreach ($a in $attachments) {
        New-Item -ItemType Directory -Force -Path $filesDir | Out-Null
        $file = Join-Path $filesDir (Get-SafeFileName "$($e.VaultName) - $(Get-Prop $d 'title') - $(Get-Prop $a 'fileName' 'datei')")
        [IO.File]::WriteAllBytes($file, [Convert]::FromBase64String($a.value))
    }
}

if ($Format -in 'All', 'Json') {
    $json = $all | ForEach-Object { [ordered]@{ vault = $_.VaultHost; id = $_.Id; item = $_.Doc } }
    ConvertTo-Json -InputObject @($json) -Depth 12 | Set-Content -Path (Join-Path $OutputFolder 'Keevault-Export.json') -Encoding utf8
}
if ($Format -in 'All', 'Csv') {
    # Bitwarden CSV columns: understood by Keevault's import, Bitwarden, 1Password, KeePassXC and others.
    $rows = foreach ($e in $all) {
        $d = $e.Doc
        $type = [string](Get-Prop $d 'type' 'login')
        [pscustomobject][ordered]@{
            folder         = (@($e.VaultName) + @(([string](Get-Prop $d 'folder')).Split('/', [StringSplitOptions]::RemoveEmptyEntries))) -join '/'
            favorite       = $(if (Get-Prop $d 'favorite' $false) { '1' } else { '' })
            type           = $(if ($type -eq 'login' -or $type -eq 'server') { 'login' } else { 'note' })
            name           = Get-Prop $d 'title'
            notes          = Get-Prop $d 'notes'
            fields         = (Get-ExtraLines $d) -join "`n"
            reprompt       = ''
            login_uri      = (@(Get-Prop $d 'urls' @()) -join ',')
            login_username = Get-Prop $d 'username'
            login_password = Get-Prop $d 'password'
            login_totp     = Get-Prop $d 'totp'
        }
    }
    $rows | Export-Csv -Path (Join-Path $OutputFolder 'Keevault-Export.csv') -NoTypeInformation -Encoding utf8
}
if ($Format -in 'All', 'KeePass') { [IO.File]::WriteAllBytes((Join-Path $OutputFolder 'Keevault-KeePass.xml'), (ConvertTo-KeePassXml $all)) }

Write-Host ''
Write-Host (Say "$($all.Count) Einträge exportiert nach: $OutputFolder" "$($all.Count) entries exported to: $OutputFolder") -ForegroundColor Green
Write-Host (Say 'Die Dateien sind UNVERSCHLÜSSELT – nach dem Import sicher löschen.' 'The files are NOT ENCRYPTED – delete them securely after importing.') -ForegroundColor Yellow
if ($failed) { exit 2 }
