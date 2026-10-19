<#
  Makes the Microsoft Store tile images from the app icon.

  Run:  powershell -NoProfile -File scripts/make-appx-assets.ps1

  Reads apps/desktop/build/icon.png (1024x1024) and writes the four logos an
  MSIX package requires into apps/desktop/build/appx/, where electron-builder's
  appx target looks for them. Without them it falls back to its own default
  artwork, which is not Terra Pulse's.

  The square logos are the icon scaled down. The wide tile is the icon at the
  tile's height, centred on the icon's own background colour, so the tile reads
  as one piece rather than a square stuck on a band. That colour is also the
  manifest's `backgroundColor` in electron-builder.yml; sample it here and keep
  the two in step if the icon ever changes.

  Re-run after changing the icon. The outputs are committed, like the icon.
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$source = Join-Path $root 'apps/desktop/build/icon.png'
$outDir = Join-Path $root 'apps/desktop/build/appx'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$icon = [System.Drawing.Bitmap]::FromFile($source)

# The icon's background, read from inside the rounded square (its corners are
# transparent). Printed so electron-builder.yml can be checked against it.
$bg = $icon.GetPixel(40, 512)
'icon background: #{0:x2}{1:x2}{2:x2}' -f $bg.R, $bg.G, $bg.B

function Save-Logo([string]$name, [int]$width, [int]$height, [bool]$fillBackground) {
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  if ($fillBackground) { $graphics.Clear($bg) } else { $graphics.Clear([System.Drawing.Color]::Transparent) }
  $side = [Math]::Min($width, $height)
  $x = [int](($width - $side) / 2)
  $y = [int](($height - $side) / 2)
  $graphics.DrawImage($icon, $x, $y, $side, $side)
  $graphics.Dispose()
  $path = Join-Path $outDir $name
  $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
  "wrote $name ($width x $height)"
}

Save-Logo 'StoreLogo.png' 50 50 $false
Save-Logo 'Square44x44Logo.png' 44 44 $false
Save-Logo 'Square150x150Logo.png' 150 150 $false
Save-Logo 'Wide310x150Logo.png' 310 150 $true

$icon.Dispose()
