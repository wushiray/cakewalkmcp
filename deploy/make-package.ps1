<#
deploy\make-package.ps1 — build the distributable zip.

Why this exists: `npm pack` produces a 1 MB tarball with none of the bundled
runtime, the installer or the docs, so the published artefact cannot be the
"one-click, no-Node" package the README describes. The distributable is a zip
of the tree, built here so it cannot drift.

Usage:
  powershell -ExecutionPolicy Bypass -File deploy\make-package.ps1 [-OutDir <dir>]
#>
[CmdletBinding()]
param([string]$OutDir)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $Root 'dist' }
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

# What a user needs. Deliberately excludes: test/, .zcode/, tmp/, the audit
# notes and the dev-only runner.
$Include = @('bin', 'lib', 'bridge', 'deploy', 'native', 'runtime', 'vendor',
             'node_modules', 'package.json', 'package-lock.json', 'LICENSE',
             'QUICKSTART.md', 'README.md', 'AGENTS.md', 'CONNECT-PROMPT.md',
             'RELEASE-NOTES.md', 'THIRD-PARTY-NOTICES.md',
             'AUDIT-RESPONSE-20261022.md', 'ACCEPTANCE-20261023.md',
             '双击部署.cmd')

$staging = Join-Path $env:TEMP ('cw-pkg-' + [Guid]::NewGuid().ToString('n').Substring(0, 8))
try {
  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  foreach ($item in $Include) {
    $src = Join-Path $Root $item
    if (-not (Test-Path -LiteralPath $src)) { Write-Host "  skip (absent): $item"; continue }
    Copy-Item -LiteralPath $src -Destination $staging -Recurse -Force
  }
  # The launcher has a Chinese file name. This file has a BOM so the literal
  # decodes, but a glob is safer than any literal: the round-5 audit found the
  # zip shipping WITHOUT the launcher while the docs tell the user to
  # double-click it. Take whichever *.cmd sits at the package root.
  Get-ChildItem -LiteralPath $Root -Filter '*.cmd' -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $staging -Force
    Write-Host ("  launcher: {0}" -f $_.Name)
  }
  $name = 'cakewalkmcp-' + (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
  $zip = Join-Path $OutDir ($name + '.zip')
  if (Test-Path $zip) { Remove-Item $zip -Force }
  # Compress-Archive drops empty directories and is slow; the .NET zip is faster
  # and keeps the tree intact.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $staging, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
  Write-Host ""
  Write-Host ("package: {0}  ({1} MB)" -f $zip, $mb) -ForegroundColor Green
  Write-Host "  extract it, double-click the .cmd in the folder, then point the MCP client at:"
  Write-Host ("    {0}" -f (Join-Path $Root "runtime\node.exe bin\cakewalk-mcp.js"))
} finally {
  $tempRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  $cleanupTarget = [IO.Path]::GetFullPath($staging)
  if (-not $cleanupTarget.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($cleanupTarget) -notmatch '^cw-pkg-[0-9a-f]{8}$') {
    throw 'Refusing cleanup outside the owned package staging directory.'
  }
  Remove-Item -LiteralPath $cleanupTarget -Recurse -Force -ErrorAction SilentlyContinue
}
