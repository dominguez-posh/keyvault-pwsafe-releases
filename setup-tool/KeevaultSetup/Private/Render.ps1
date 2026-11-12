# Renders the documentation model (Report.ps1) as Markdown, printable HTML or DOCX. Blocks: h1 h2 h3 p note li
# (with Sub) check (Done, Sub) num (N) table (Head, Rows) break. All text is plain text and escaped per format, so
# names and answers never become links, markup or XML. DOCX is Office Open XML written by hand with System.IO.Compression
# from .NET: no new dependency.

function ConvertTo-KsMd([string] $Text) {
    # Plain text into Markdown without letting names or answers form links, HTML or tables.
    if ($null -eq $Text) { return '' }
    $t = $Text -replace '[\r\n]+', ' '
    return ($t -replace '([\\`*_\[\]<>|#])', '\$1')
}

function ConvertTo-KsMarkdown($Model) {
    $md = New-Object System.Collections.Generic.List[string]
    $inList = ''
    foreach ($b in $Model) {
        $isList = @('li', 'check', 'num') -contains $b.T
        # A list ends with a blank line, also where bullets turn into numbers (else Markdown merges the two lists).
        $kind = ''; if ($isList) { $kind = $b.T; if ($kind -eq 'check') { $kind = 'li' } }
        if ($inList -and $kind -ne $inList) { $md.Add('') }
        $inList = $kind
        $x = ConvertTo-KsMd $b.X
        switch ($b.T) {
            'h1' { $md.Add("# $x"); $md.Add('') }
            'h2' { $md.Add("## $x"); $md.Add('') }
            'h3' { $md.Add("### $x"); $md.Add('') }
            'p' { $md.Add($x); $md.Add('') }
            'note' { $md.Add("> $x"); $md.Add('') }
            'break' { $md.Add('---'); $md.Add('') }
            'li' { $md.Add("- $x") }
            'num' { $md.Add("$($b.N). $x") }
            'check' { $mark = ' '; if ($b.Done) { $mark = 'x' }; $md.Add("- [$mark] $x") }
            'table' {
                $md.Add('| ' + (($b.Head | ForEach-Object { ConvertTo-KsMd $_ }) -join ' | ') + ' |')
                $md.Add('|' + ((@($b.Head) | ForEach-Object { ' --- ' }) -join '|') + '|')
                foreach ($row in $b.Rows) { $md.Add('| ' + (($row | ForEach-Object { ConvertTo-KsMd $_ }) -join ' | ') + ' |') }
                $md.Add('')
            }
        }
        if ($isList -and $b.ContainsKey('Sub')) { foreach ($s in @($b.Sub)) { if ($s) { $md.Add("  - $(ConvertTo-KsMd $s)") } } }
    }
    return (($md -join "`n").TrimEnd() + "`n")
}

function ConvertTo-KsHtmlText([string] $Text) {
    if ($null -eq $Text) { return '' }
    # Only the markup characters: umlauts stay readable (the page is UTF-8).
    $t = $Text -replace '[\x00-\x08\x0b\x0c\x0e-\x1f]', ''
    return $t.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&#39;')
}

function ConvertTo-KsHtml($Model, [string] $Title, [string] $Lang) {
    # Self-contained page for printing (A4): no scripts, no external files.
    $css = @'
:root { --accent: #0f6cbd; --text: #1b1b1b; --muted: #5c5c5c; --border: #d6d6d6; --soft: #e6f0fa; }
* { box-sizing: border-box; }
body { font: 11pt/1.45 "Segoe UI", Arial, sans-serif; color: var(--text); background: #fff; max-width: 820px; margin: 24px auto; padding: 0 20px; }
h1 { color: var(--accent); font-size: 20pt; margin: 0 0 8px; }
h2 { font-size: 14pt; margin: 22px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 3px; break-after: avoid; page-break-after: avoid; }
h3 { font-size: 12pt; margin: 14px 0 6px; break-after: avoid; page-break-after: avoid; }
p { margin: 6px 0; }
.note { border-left: 4px solid var(--accent); background: var(--soft); padding: 8px 12px; margin: 10px 0; }
ul, ol { margin: 6px 0 6px 22px; padding: 0; }
ul.checks { list-style: none; margin-left: 0; }
ul.checks > li { position: relative; padding-left: 1.6em; }

.box { position: absolute; left: 0; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; break-inside: avoid; page-break-inside: avoid; }
th, td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; vertical-align: top; }
th { background: var(--soft); }
li { break-inside: avoid; page-break-inside: avoid; }
.break { break-before: page; page-break-before: always; height: 0; margin: 0; border: 0; }
@page { size: A4; margin: 18mm 16mm; }
@media print { body { margin: 0; max-width: none; padding: 0; } }
'@
    $h = New-Object System.Text.StringBuilder
    [void] $h.Append("<!doctype html>`n<html lang=`"$Lang`">`n<head>`n<meta charset=`"utf-8`">`n<meta name=`"viewport`" content=`"width=device-width, initial-scale=1`">`n")
    [void] $h.Append("<title>$(ConvertTo-KsHtmlText $Title)</title>`n<style>`n$css</style>`n</head>`n<body>`n")
    $open = ''
    foreach ($b in $Model) {
        $list = switch ($b.T) { 'li' { 'ul' } 'check' { 'ul class="checks"' } 'num' { 'ol' } default { '' } }
        if ($open -and $list -ne $open) { [void] $h.Append("</$(($open -split ' ')[0])>`n"); $open = '' }
        if ($list -and -not $open) { [void] $h.Append("<$list>`n"); $open = $list }
        $x = ConvertTo-KsHtmlText $b.X
        $sub = ''
        if ($b.ContainsKey('Sub') -and @($b.Sub | Where-Object { $_ }).Count) {
            $sub = '<ul>' + ((@($b.Sub | Where-Object { $_ }) | ForEach-Object { "<li>$(ConvertTo-KsHtmlText $_)</li>" }) -join '') + '</ul>'
        }
        switch ($b.T) {
            'h1' { [void] $h.Append("<h1>$x</h1>`n") }
            'h2' { [void] $h.Append("<h2>$x</h2>`n") }
            'h3' { [void] $h.Append("<h3>$x</h3>`n") }
            'p' { [void] $h.Append("<p>$x</p>`n") }
            'note' { [void] $h.Append("<p class=`"note`">$x</p>`n") }
            'break' { [void] $h.Append("<hr class=`"break`">`n") }
            'li' { [void] $h.Append("<li>$x$sub</li>`n") }
            'num' { [void] $h.Append("<li value=`"$([int] $b.N)`">$x$sub</li>`n") }
            'check' {
                $box = [string] [char] 0x2610; if ($b.Done) { $box = [string] [char] 0x2611 }
                [void] $h.Append("<li><span class=`"box`">$box</span>$x$sub</li>`n")
            }
            'table' {
                [void] $h.Append('<table><thead><tr>' + ((@($b.Head) | ForEach-Object { "<th>$(ConvertTo-KsHtmlText $_)</th>" }) -join '') + "</tr></thead><tbody>`n")
                foreach ($row in $b.Rows) { [void] $h.Append('<tr>' + ((@($row) | ForEach-Object { "<td>$(ConvertTo-KsHtmlText $_)</td>" }) -join '') + "</tr>`n") }
                [void] $h.Append("</tbody></table>`n")
            }
        }
    }
    if ($open) { [void] $h.Append("</$(($open -split ' ')[0])>`n") }
    [void] $h.Append("</body>`n</html>`n")
    return $h.ToString()
}

function ConvertTo-KsXmlText([string] $Text) {
    if ($null -eq $Text) { return '' }
    return [System.Security.SecurityElement]::Escape(($Text -replace '[\x00-\x08\x0b\x0c\x0e-\x1f]', ''))
}

function New-KsDocxPara([string] $Text, [string] $Style = '', [int] $Indent = 0, [int] $Hanging = 0, [switch] $PageBreak) {
    $ppr = ''
    if ($Style) { $ppr += "<w:pStyle w:val=`"$Style`"/>" }
    if ($Indent) { $ppr += "<w:ind w:left=`"$Indent`" w:hanging=`"$Hanging`"/>" }
    if ($ppr) { $ppr = "<w:pPr>$ppr</w:pPr>" }
    if ($PageBreak) { return "<w:p><w:r><w:br w:type=`"page`"/></w:r></w:p>" }
    return "<w:p>$ppr<w:r><w:t xml:space=`"preserve`">$(ConvertTo-KsXmlText $Text)</w:t></w:r></w:p>"
}

function ConvertTo-KsDocx($Model, [string] $Title, [string] $Lang) {
    $body = New-Object System.Text.StringBuilder
    foreach ($b in $Model) {
        switch ($b.T) {
            'h1' { [void] $body.Append((New-KsDocxPara $b.X 'Heading1')) }
            'h2' { [void] $body.Append((New-KsDocxPara $b.X 'Heading2')) }
            'h3' { [void] $body.Append((New-KsDocxPara $b.X 'Heading3')) }
            'p' { [void] $body.Append((New-KsDocxPara $b.X)) }
            'note' { [void] $body.Append((New-KsDocxPara $b.X 'Note')) }
            'break' { [void] $body.Append((New-KsDocxPara '' -PageBreak)) }
            'li' { [void] $body.Append((New-KsDocxPara ("$([char] 0x2022)`t" + $b.X) '' 360 360)) }
            'num' { [void] $body.Append((New-KsDocxPara ("$($b.N).`t" + $b.X) '' 360 360)) }
            'check' {
                $box = [char] 0x2610; if ($b.Done) { $box = [char] 0x2612 }
                [void] $body.Append((New-KsDocxPara ("$box`t" + $b.X) '' 360 360))
            }
            'table' {
                $cell = { param($t, $head) $shade = ''; if ($head) { $shade = '<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="E6F0FA"/></w:tcPr>' }; "<w:tc>$shade$(New-KsDocxPara $t)</w:tc>" }
                [void] $body.Append('<w:tbl><w:tblPr><w:tblStyle w:val="Table"/><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>')
                foreach ($side in 'top', 'left', 'bottom', 'right', 'insideH', 'insideV') { [void] $body.Append("<w:$side w:val=`"single`" w:sz=`"4`" w:space=`"0`" w:color=`"D6D6D6`"/>") }
                [void] $body.Append('</w:tblBorders></w:tblPr>')
                [void] $body.Append('<w:tr>' + ((@($b.Head) | ForEach-Object { & $cell $_ $true }) -join '') + '</w:tr>')
                foreach ($row in $b.Rows) { [void] $body.Append('<w:tr>' + ((@($row) | ForEach-Object { & $cell $_ $false }) -join '') + '</w:tr>') }
                [void] $body.Append('</w:tbl>')
                [void] $body.Append((New-KsDocxPara ''))
            }
        }
        if ($b.ContainsKey('Sub')) { foreach ($s in @($b.Sub)) { if ($s) { [void] $body.Append((New-KsDocxPara ("$([char] 0x2013)`t" + $s) '' 720 360)) } } }
    }
    $ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
    $wlang = 'de-DE'; if ($Lang -eq 'en') { $wlang = 'en-GB' }
    $files = [ordered]@{
        '[Content_Types].xml'          = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'
        '_rels/.rels'                  = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>'
        'docProps/core.xml'            = "<?xml version=`"1.0`" encoding=`"UTF-8`" standalone=`"yes`"?><cp:coreProperties xmlns:cp=`"http://schemas.openxmlformats.org/package/2006/metadata/core-properties`" xmlns:dc=`"http://purl.org/dc/elements/1.1/`"><dc:title>$(ConvertTo-KsXmlText $Title)</dc:title><dc:language>$wlang</dc:language></cp:coreProperties>"
        'word/_rels/document.xml.rels' = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
        'word/styles.xml'              = "<?xml version=`"1.0`" encoding=`"UTF-8`" standalone=`"yes`"?><w:styles $ns><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=`"Segoe UI`" w:hAnsi=`"Segoe UI`" w:cs=`"Segoe UI`" w:eastAsia=`"Segoe UI`"/><w:sz w:val=`"21`"/><w:lang w:val=`"$wlang`"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=`"100`" w:line=`"276`" w:lineRule=`"auto`"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type=`"paragraph`" w:default=`"1`" w:styleId=`"Normal`"><w:name w:val=`"Normal`"/></w:style><w:style w:type=`"paragraph`" w:styleId=`"Heading1`"><w:name w:val=`"heading 1`"/><w:basedOn w:val=`"Normal`"/><w:next w:val=`"Normal`"/><w:pPr><w:keepNext/><w:spacing w:before=`"240`" w:after=`"120`"/><w:outlineLvl w:val=`"0`"/></w:pPr><w:rPr><w:b/><w:color w:val=`"0F6CBD`"/><w:sz w:val=`"36`"/></w:rPr></w:style><w:style w:type=`"paragraph`" w:styleId=`"Heading2`"><w:name w:val=`"heading 2`"/><w:basedOn w:val=`"Normal`"/><w:next w:val=`"Normal`"/><w:pPr><w:keepNext/><w:spacing w:before=`"280`" w:after=`"100`"/><w:outlineLvl w:val=`"1`"/></w:pPr><w:rPr><w:b/><w:sz w:val=`"28`"/></w:rPr></w:style><w:style w:type=`"paragraph`" w:styleId=`"Heading3`"><w:name w:val=`"heading 3`"/><w:basedOn w:val=`"Normal`"/><w:next w:val=`"Normal`"/><w:pPr><w:keepNext/><w:spacing w:before=`"200`" w:after=`"80`"/><w:outlineLvl w:val=`"2`"/></w:pPr><w:rPr><w:b/><w:sz w:val=`"23`"/></w:rPr></w:style><w:style w:type=`"paragraph`" w:styleId=`"Note`"><w:name w:val=`"Note`"/><w:basedOn w:val=`"Normal`"/><w:pPr><w:pBdr><w:left w:val=`"single`" w:sz=`"24`" w:space=`"8`" w:color=`"0F6CBD`"/></w:pBdr><w:shd w:val=`"clear`" w:color=`"auto`" w:fill=`"E6F0FA`"/><w:ind w:left=`"200`"/></w:pPr></w:style><w:style w:type=`"table`" w:styleId=`"Table`"><w:name w:val=`"Table`"/><w:tblPr><w:tblCellMar><w:left w:w=`"100`" w:type=`"dxa`"/><w:right w:w=`"100`" w:type=`"dxa`"/></w:tblCellMar></w:tblPr></w:style></w:styles>"
        'word/document.xml'            = "<?xml version=`"1.0`" encoding=`"UTF-8`" standalone=`"yes`"?><w:document $ns><w:body>$($body.ToString())<w:sectPr><w:pgSz w:w=`"11906`" w:h=`"16838`"/><w:pgMar w:top=`"1020`" w:right=`"907`" w:bottom=`"1020`" w:left=`"907`" w:header=`"567`" w:footer=`"567`" w:gutter=`"0`"/></w:sectPr></w:body></w:document>"
    }
    if (-not ('System.IO.Compression.ZipArchive' -as [type])) { Add-Type -AssemblyName System.IO.Compression }
    $ms = New-Object System.IO.MemoryStream
    $zip = New-Object System.IO.Compression.ZipArchive($ms, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        $utf8 = New-Object System.Text.UTF8Encoding $false
        foreach ($name in $files.Keys) {
            $entry = $zip.CreateEntry($name)
            $stream = $entry.Open()
            try { $bytes = $utf8.GetBytes($files[$name]); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
        }
    }
    finally { $zip.Dispose() }
    return , $ms.ToArray()
}
