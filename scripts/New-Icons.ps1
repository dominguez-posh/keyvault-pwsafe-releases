#Requires -Version 7
<#
.SYNOPSIS
    Zeichnet das App-Symbol (Schild mit Schlüsselloch) und schreibt die PNG-Symbole der Erweiterung
    sowie icon.png/icon.ico der Desktop-App.
#>
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent

function New-IconBitmap([int]$Size) {
    $bmp = [System.Drawing.Bitmap]::new($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.ScaleTransform($Size / 128.0, $Size / 128.0)

    # Rounded square with diagonal gradient.
    $bg = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $r = 28; $x = 4; $y = 4; $w = 120; $h = 120
    $bg.AddArc($x, $y, $r, $r, 180, 90)
    $bg.AddArc($x + $w - $r, $y, $r, $r, 270, 90)
    $bg.AddArc($x + $w - $r, $y + $h - $r, $r, $r, 0, 90)
    $bg.AddArc($x, $y + $h - $r, $r, $r, 90, 90)
    $bg.CloseFigure()
    $grad = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        [System.Drawing.PointF]::new(0, 0), [System.Drawing.PointF]::new(128, 128),
        [System.Drawing.Color]::FromArgb(255, 36, 140, 230), [System.Drawing.Color]::FromArgb(255, 11, 72, 140))
    $g.FillPath($grad, $bg)

    # Shield.
    $shield = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $shield.AddLine(64, 20, 102, 33)
    $shield.AddLine(102, 33, 102, 60)
    $shield.AddBezier(102, 60, 102, 86, 86, 101, 64, 110)
    $shield.AddBezier(64, 110, 42, 101, 26, 86, 26, 60)
    $shield.AddLine(26, 60, 26, 33)
    $shield.CloseFigure()
    $g.FillPath([System.Drawing.Brushes]::White, $shield)

    # Keyhole.
    $hole = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 15, 108, 189))
    $g.FillEllipse($hole, 51, 42, 26, 26)
    $g.FillPolygon($hole, [System.Drawing.PointF[]]@(
            [System.Drawing.PointF]::new(57, 60), [System.Drawing.PointF]::new(71, 60),
            [System.Drawing.PointF]::new(75, 90), [System.Drawing.PointF]::new(53, 90)))
    $g.Dispose()
    return $bmp
}

function Get-PngBytes([int]$Size) {
    $bmp = New-IconBitmap $Size
    $ms = [System.IO.MemoryStream]::new()
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    return , $ms.ToArray()
}

$extIcons = Join-Path $root 'extension/icons'
$deskAssets = Join-Path $root 'desktop/assets'
New-Item -ItemType Directory -Force $extIcons, $deskAssets | Out-Null

foreach ($size in 16, 32, 48, 128) {
    [System.IO.File]::WriteAllBytes((Join-Path $extIcons "icon$size.png"), (Get-PngBytes $size))
}
[System.IO.File]::WriteAllBytes((Join-Path $deskAssets 'icon.png'), (Get-PngBytes 512))

# MSIX assets of the Windows passkey provider.
$winAssets = Join-Path $root 'windows/PasskeyProvider/Assets'
New-Item -ItemType Directory -Force $winAssets | Out-Null
foreach ($asset in @(@{ Name = 'StoreLogo.png'; Size = 50 }, @{ Name = 'Square44x44Logo.png'; Size = 44 }, @{ Name = 'Square150x150Logo.png'; Size = 150 })) {
    [System.IO.File]::WriteAllBytes((Join-Path $winAssets $asset.Name), (Get-PngBytes $asset.Size))
}

# ICO with PNG-compressed images (Windows Vista and later).
$sizes = 16, 24, 32, 48, 64, 128, 256
$images = $sizes | ForEach-Object { , (Get-PngBytes $_) }
$ms = [System.IO.MemoryStream]::new()
$bw = [System.IO.BinaryWriter]::new($ms)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]
    $bw.Write([byte]($s -ge 256 ? 0 : $s)); $bw.Write([byte]($s -ge 256 ? 0 : $s))
    $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$images[$i].Length); $bw.Write([uint32]$offset)
    $offset += $images[$i].Length
}
foreach ($img in $images) { $bw.Write($img) }
$bw.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $deskAssets 'icon.ico'), $ms.ToArray())
Write-Host "Symbole geschrieben: $extIcons, $deskAssets"
