# Local graphical wizard: a small HTTP server on localhost that serves ui/ and calls the engine, shown in an Edge app
# window. Only the window opened with the one-time start token gets the session cookie; every API call is a POST with
# a custom header (no cross-site form or fetch can send it without CORS, which the server never allows) and the Host
# must be localhost (no DNS rebinding).

$script:KsUiFiles = @{
    '/'                         = @('ui', 'index.html', 'text/html; charset=utf-8')
    '/index.html'               = @('ui', 'index.html', 'text/html; charset=utf-8')
    '/app.js'                   = @('ui', 'app.js', 'text/javascript; charset=utf-8')
    '/setup.css'                = @('ui', 'setup.css', 'text/css; charset=utf-8')
    '/i18n.js'                  = @('ui', 'i18n.js', 'text/javascript; charset=utf-8')
    '/extension/styles/app.css' = @('styles', 'app.css', 'text/css; charset=utf-8')
}
$script:KsMaxBody = 524288

function Get-KsToolRoot { return (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) }

function Get-KsUiFile([string] $Kind, [string] $Name) {
    $tool = Get-KsToolRoot
    if ($Kind -eq 'ui') { return (Join-Path (Join-Path $tool 'ui') $Name) }
    # Same relative layout in the repo and in the portable package: <root>/setup-tool and <root>/extension/styles.
    return (Join-Path (Join-Path (Join-Path (Split-Path $tool -Parent) 'extension') 'styles') $Name)
}

function New-KsRandomHex([int] $Bytes) {
    $b = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($b) } finally { $rng.Dispose() }
    return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Test-KsSame([string] $A, [string] $B) {
    if (-not $A -or -not $B -or $A.Length -ne $B.Length) { return $false }
    $diff = 0
    for ($i = 0; $i -lt $A.Length; $i++) { $diff = $diff -bor ([int][char] $A[$i] -bxor [int][char] $B[$i]) }
    return ($diff -eq 0)
}

function Get-KsFreePort {
    $l = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), 0
    $l.Start()
    try { return ([System.Net.IPEndPoint] $l.LocalEndpoint).Port } finally { $l.Stop() }
}

function Find-KsEdge {
    foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)) {
        if (-not $base) { continue }
        $exe = Join-Path $base 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $exe) { return $exe }
    }
    return $null
}

function Send-KsResponse($Response, [int] $Status, [string] $Type, [byte[]] $Bytes) {
    $Response.StatusCode = $Status
    $Response.Headers['Cache-Control'] = 'no-store'
    $Response.Headers['X-Content-Type-Options'] = 'nosniff'
    $Response.Headers['Referrer-Policy'] = 'no-referrer'
    $Response.Headers['Content-Security-Policy'] = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"
    if ($Type) { $Response.ContentType = $Type }
    if ($Bytes) { $Response.ContentLength64 = $Bytes.Length; $Response.OutputStream.Write($Bytes, 0, $Bytes.Length) }
    $Response.OutputStream.Close()
}

function Send-KsJson($Response, [int] $Status, $Object) {
    $json = $Object | ConvertTo-Json -Depth 12 -Compress
    Send-KsResponse $Response $Status 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($json))
}

function Invoke-KsApi([string] $Name, $Body, $Session) {
    switch ($Name) {
        'state' {
            $ctx = Get-KeevaultSetupContext
            $defaults = New-KeevaultSetupPlan -SubscriptionId $ctx.SubscriptionId
            # Texts the window shows from the engine, in the current language: step labels and the questions per step.
            $labels = [ordered]@{}
            foreach ($id in $script:KsStepIds) { $labels[$id] = KsT "label.$id" }
            $questions = @(foreach ($step in $script:KsQuestions.Keys) { foreach ($q in $script:KsQuestions[$step]) { @{ id = $q; step = $step; text = (KsT "q.$q") } } })
            return @{ context = $ctx; defaults = $defaults; version = (Get-Module KeevaultSetup).Version.ToString(); tool = (Get-KeevaultSetupVersion); language = $script:KsLang; stepLabels = $labels; questions = $questions }
        }
        'language' {
            if (@('de', 'en') -notcontains [string] $Body.language) { throw (KsT 'ui.language') }
            Set-KeevaultSetupLanguage ([string] $Body.language)
            return (Invoke-KsApi 'state' $null $Session)
        }
        'connect' {
            $tenant = ''; $sub = ''
            if ($Body.tenantId) { $tenant = [string] $Body.tenantId }
            if ($Body.subscriptionId) { $sub = [string] $Body.subscriptionId }
            if ($tenant -and $tenant -notmatch $script:KsGuid -and $tenant -notmatch '^[A-Za-z0-9.-]{3,253}$') { throw (KsT 'ui.tenant') }
            if ($sub -and $sub -notmatch $script:KsGuid) { throw (KsT 'ui.sub') }
            return @{ context = (Connect-KeevaultSetup -TenantId $tenant -SubscriptionId $sub) }
        }
        'rights' {
            return @{ rights = (Get-KeevaultSetupRights -SubscriptionId ([string] $Body.subscriptionId) -ResourceGroup ([string] $Body.resourceGroup)) }
        }
        'validate' {
            $check = Test-KeevaultSetupPlan $Body.plan
            $steps = @()
            if ($check.Valid) { $steps = @(Get-KeevaultSetupStep $check.Plan) }
            return @{ valid = $check.Valid; errors = @($check.Errors); plan = $check.Plan; steps = $steps }
        }
        'import' { return @{ plan = (Import-KeevaultSetupPlan -Json ([string] $Body.json)) } }
        'export' { return @{ json = (ConvertTo-KeevaultSetupPlanJson $Body.plan -Portable:([bool] $Body.portable)) } }
        'terraform' { return @{ name = 'keevault.tf'; text = (ConvertTo-KeevaultSetupTerraform $Body.plan) } }
        'devicepolicy' {
            $zip = Export-KeevaultSetupDevicePolicy -Plan $Body.plan -Zip
            return @{ name = 'Keevault-Richtlinien-Paket.zip'; type = 'application/zip'; base64 = [Convert]::ToBase64String($zip) }
        }
        'dryrun' {
            $Session.Last = Invoke-KeevaultSetup -Plan $Body.plan -WhatIf
            return @{ result = $Session.Last }
        }
        'run' {
            # The button in the window is the confirmation; the engine still checks that the plan is the one of the dry run.
            $Session.Last = Invoke-KeevaultSetup -Plan $Body.plan -ConfirmPlanHash ([string] $Body.hash) -Confirm:$false
            return @{ result = $Session.Last }
        }
        'report' {
            if (-not $Session.Last) { throw (KsT 'ui.needDryRun') }
            $format = [string] $Body.format
            if (-not $format) { $format = 'md' }
            $kind = @{ md = @('Markdown', 'md', 'text/markdown'); html = @('Html', 'html', 'text/html'); docx = @('Docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') }[$format]
            if (-not $kind) { throw (KsT 'ui.format') }
            $lang = $script:KsLang
            if ($Session.Last.PSObject.Properties['Language']) { $script:KsLang = $Session.Last.Language }
            $name = "$(KsT 'rep.file').$($kind[1])"
            $script:KsLang = $lang
            $out = New-KeevaultSetupReport -Result $Session.Last -Format $kind[0]
            if ($out -is [byte[]]) { return @{ name = $name; type = $kind[2]; base64 = [Convert]::ToBase64String($out) } }
            $r = @{ name = $name; type = $kind[2]; text = $out }
            if ($format -eq 'md') { $r.markdown = $out }
            return $r
        }
        # Part e: drift and framework check (read-only), their report, and the updater.
        'drift' {
            $Session.Drift = Test-KeevaultSetupDrift -Plan $Body.plan -Device:([bool] $Body.device)
            return @{ result = ($Session.Drift | Select-Object * -ExcludeProperty Plan) }
        }
        'compliance' {
            $Session.Compliance = Test-KeevaultSetupCompliance -Plan $Body.plan
            return @{ result = $Session.Compliance }
        }
        'checkreport' {
            $kind = @{ md = @('Markdown', 'md', 'text/markdown'); html = @('Html', 'html', 'text/html'); docx = @('Docx', 'docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') }[[string] $Body.format]
            if (-not $kind) { throw (KsT 'ui.format') }
            $out = New-KeevaultSetupCheckReport -Drift $Session.Drift -Compliance $Session.Compliance -Format $kind[0]
            $name = "Keevault-Pruefbericht.$($kind[1])"
            if ($out -is [byte[]]) { return @{ name = $name; type = $kind[2]; base64 = [Convert]::ToBase64String($out) } }
            return @{ name = $name; type = $kind[2]; text = $out }
        }
        'updatecheck' { return @{ update = (Get-KeevaultSetupUpdate) } }
        'updateinstall' {
            # The button in the window is the confirmation; the engine checks signature, checksums and content again.
            return @{ install = (Install-KeevaultSetupUpdate -Confirm:$false) }
        }
        'quit' { $Session.Quit = $true; return @{ ok = $true } }
    }
    throw (KsT 'ui.unknown')
}

function Start-KeevaultSetupUi {
    <#
    .SYNOPSIS
        Startet den grafischen Assistenten (lokales Fenster). Endet, wenn das Fenster geschlossen wird.
    #>
    [CmdletBinding()]
    param([int] $Port = 0, [switch] $NoBrowser)
    if (-not $Port) { $Port = Get-KsFreePort }
    $startToken = New-KsRandomHex 32
    $cookie = New-KsRandomHex 32
    $hostName = "localhost:$Port"
    $listener = New-Object System.Net.HttpListener
    $listener.Prefixes.Add("http://$hostName/")
    $listener.Start()
    $session = @{ Last = $null; Drift = $null; Compliance = $null; Quit = $false; Started = $false }
    $browser = $null; $profileDir = $null
    $url = "http://$hostName/start?t=$startToken"
    try {
        [Console]::Out.WriteLine("KEEVAULT_SETUP_URL $url")
        [Console]::Out.Flush()
        if (-not $NoBrowser) {
            $edge = Find-KsEdge
            if ($edge) {
                $profileDir = Join-Path ([System.IO.Path]::GetTempPath()) ("keevault-setup-" + (New-KsRandomHex 6))
                $browser = Start-Process -FilePath $edge -PassThru -ArgumentList @("--app=$url", "--user-data-dir=`"$profileDir`"", '--no-first-run', '--no-default-browser-check', '--window-size=1100,820')
            }
            else { Start-Process $url | Out-Null }
        }
        $pending = $listener.GetContextAsync()
        while (-not $session.Quit) {
            if (-not $pending.Wait(500)) {
                if ($browser -and $browser.HasExited) { break }
                continue
            }
            $ctx = $pending.Result
            $pending = $null
            $req = $ctx.Request; $res = $ctx.Response
            try {
                $path = $req.Url.AbsolutePath
                $cookieOk = $req.Cookies['ks'] -and (Test-KsSame $req.Cookies['ks'].Value $cookie)
                if ($req.Headers['Host'] -ne $hostName) { Send-KsJson $res 403 @{ error = 'Host' } }
                elseif ($path -eq '/start') {
                    if (-not $session.Started -and $req.HttpMethod -eq 'GET' -and (Test-KsSame $req.QueryString['t'] $startToken)) {
                        $session.Started = $true
                        $res.Headers.Add('Set-Cookie', "ks=$cookie; Path=/; HttpOnly; SameSite=Strict")
                        $res.Headers['Location'] = '/'
                        Send-KsResponse $res 302 '' $null
                    }
                    else { Send-KsJson $res 403 @{ error = 'Startlink ungültig oder schon benutzt.' } }
                }
                elseif (-not $cookieOk) { Send-KsJson $res 403 @{ error = 'Keine Sitzung.' } }
                elseif ($path -like '/api/*') {
                    if ($req.HttpMethod -ne 'POST' -or $req.Headers['X-Keevault-Setup'] -ne '1' -or ([string] $req.ContentType) -notlike 'application/json*') { Send-KsJson $res 403 @{ error = 'Anfrage abgelehnt.' } }
                    elseif ($req.ContentLength64 -gt $script:KsMaxBody) { Send-KsJson $res 413 @{ error = 'Zu groß.' } }
                    else {
                        $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
                        $raw = $reader.ReadToEnd(); $reader.Dispose()
                        if ($raw.Length -gt $script:KsMaxBody) { throw 'Zu groß.' }
                        $body = $null
                        if ($raw) { $body = $raw | ConvertFrom-Json }
                        if (-not $body) { $body = [pscustomobject]@{} }
                        try { Send-KsJson $res 200 (Invoke-KsApi $path.Substring(5) $body $session) }
                        catch { Send-KsJson $res 400 @{ error = $_.Exception.Message } }
                    }
                }
                elseif ($req.HttpMethod -eq 'GET' -and $script:KsUiFiles.ContainsKey($path)) {
                    $f = $script:KsUiFiles[$path]
                    $file = Get-KsUiFile $f[0] $f[1]
                    if (Test-Path -LiteralPath $file) { Send-KsResponse $res 200 $f[2] ([System.IO.File]::ReadAllBytes($file)) }
                    else { Send-KsJson $res 404 @{ error = 'fehlt' } }
                }
                else { Send-KsJson $res 404 @{ error = 'nicht gefunden' } }
            }
            catch {
                try { Send-KsJson $res 500 @{ error = 'Interner Fehler.' } } catch { }
            }
            if (-not $session.Quit) { $pending = $listener.GetContextAsync() }
        }
    }
    finally {
        $listener.Stop()
        $listener.Close()
        if ($browser -and -not $browser.HasExited) { try { $browser.CloseMainWindow() | Out-Null } catch { } }
        if ($profileDir) {
            for ($i = 0; $i -lt 10 -and (Test-Path -LiteralPath $profileDir); $i++) {
                try { Remove-Item -LiteralPath $profileDir -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500 }
            }
        }
    }
}
