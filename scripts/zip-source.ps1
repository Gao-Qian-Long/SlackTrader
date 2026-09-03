param([Parameter(Mandatory=$true)][string]$Root, [Parameter(Mandatory=$true)][string]$Listing, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$base = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\') + '\'
$stream = [IO.File]::Open($Destination, [IO.FileMode]::Create)
$zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($name in (Get-Content -LiteralPath $Listing -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    $full = [IO.Path]::GetFullPath((Join-Path $base $name))
    if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Source path leaves project' }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $full, $name.Replace('\','/'), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose(); $stream.Dispose() }
$read = [IO.Compression.ZipFile]::OpenRead($Destination)
try { Write-Output "SOURCE_ZIP=PASS entries=$($read.Entries.Count)" } finally { $read.Dispose() }
