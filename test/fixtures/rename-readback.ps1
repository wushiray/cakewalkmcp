# Host-free regression fixture for the `rename` read-back in native/uia/cw_uia.ps1.
#
# It never loads UIAutomation, never touches the clipboard and never talks to a
# running SONAR. Instead it extracts the ACTUAL 'rename' branch body from the
# script with the PowerShell AST, wraps it in a fresh switch on 'rename', and
# runs it against stub functions and fake automation elements.
#
# The bug this pins down: the initial row anchor tried every mute alias, but the
# post-rename read-back interpolated the whole alias ARRAY into one name
# ("absent-alias Mute on Track 1"), which matches nothing, so a rename that had
# actually succeeded reported after=null / verified=false.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File rename-readback.ps1 [-Script <path>] [-InitialName <text>]
# Output: a single JSON object on stdout, including the captured branch output.

param(
    [string]$Script = '',
    [string]$InitialName = 'Old'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not $Script) {
    $here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $Script = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) 'native/uia/cw_uia.ps1'
}

# --- locate the real 'rename' switch clause ---------------------------------
$text = Get-Content -LiteralPath $Script -Raw -Encoding UTF8
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
if ($errors -and $errors.Count -gt 0) {
    [ordered]@{ ok = $false; error = "parse error: $($errors[0].Message)" } | ConvertTo-Json -Compress
    exit 1
}

$switchAst = $ast.FindAll({
    param($n)
    $n -is [System.Management.Automation.Language.SwitchStatementAst]
}, $true) | Select-Object -First 1
if (-not $switchAst) {
    [ordered]@{ ok = $false; error = 'no switch statement in script' } | ConvertTo-Json -Compress
    exit 1
}

$clause = $null
foreach ($c in $switchAst.Clauses) {
    $cond = $c.Item1
    # A literal 'rename' clause: a string constant whose value is rename.
    if ($cond -is [System.Management.Automation.Language.StringConstantExpressionAst] -and
        $cond.Value -eq 'rename') {
        $clause = $c
        break
    }
}
if (-not $clause) {
    [ordered]@{ ok = $false; error = "no 'rename' clause in the switch" } | ConvertTo-Json -Compress
    exit 1
}

# The statement list exactly as written in the file - not a re-implementation.
$bodyStatements = @($clause.Item2.Statements | ForEach-Object { $_.Extent.Text })

# --- stubs: nothing here is a real host -------------------------------------
# Mouse and SendKeys stand-ins. Mouse is a type in the real script, so it is
# stubbed as a C# class that returns null ("click accepted"). It does not touch
# the cursor, and SendKeys does not send anything.
if (-not ('FakeHost.Mouse' -as [type])) {
    Add-Type -TypeDefinition @'
namespace FakeHost {
    public static class Mouse {
        public static string ClickAtForPid(int x, int y, int count, int pid) { return null; }
    }
    public static class SendKeys {
        public static void SendWait(string keys) { }
    }
}
'@
}

$script:writeHappened = $false
$script:getRootCalls = 0
$script:clipboardValue = $null

function New-FakeElement([string]$name, [int]$y) {
    $rect = [pscustomobject]@{
        X = [double]10; Y = [double]$y; Width = [double]100; Height = [double]20
    }
    $current = [pscustomobject]@{
        Name              = $name
        BoundingRectangle = $rect
        ControlType       = [pscustomobject]@{ ProgrammaticName = 'ControlType.Button' }
        IsEnabled         = $true
        IsOffscreen       = $false
        ClassName         = 'Fake'
    }
    return [pscustomobject]@{ Current = $current }
}

# Fixed geometry so the row match is deterministic: mute and the name field
# share row y=0. Width 100 clears the branch's "< 60" width guard.
$script:elementsBefore = @(
    (New-FakeElement 'Mute on Track 1' 0),
    (New-FakeElement ($InitialName + ' on Track 1') 0)
)
$script:elementsAfter = @(
    (New-FakeElement 'Mute on Track 1' 0),
    (New-FakeElement 'New on Track 1' 0)
)

# The first Get-Root is the pre-write anchor; every later one is post-write.
function Get-Root {
    $script:getRootCalls++
    if ($script:getRootCalls -ge 2) {
        $script:writeHappened = $true
        return [pscustomobject]@{ Generation = 'after' }
    }
    return [pscustomobject]@{ Generation = 'before' }
}

function Get-All($root) {
    if ($null -eq $root) { return @() }
    if ($root.Generation -eq 'after') { return $script:elementsAfter }
    return $script:elementsBefore
}

# Exact-name lookup, like the real one: no alias guessing, no name joining.
function Find-Control($root, [string]$name) {
    foreach ($e in (Get-All $root)) {
        if ($e.Current.Name -eq $name) { return $e }
    }
    return $null
}

function Get-ClickRefusal($root, $d, [string]$name) { return $null }
function Get-Value($e) { return $null }
function Get-SonarPid { return 4242 }
function Start-Sleep { param($Milliseconds) }
function Set-Clipboard { param($Value) $script:clipboardValue = $Value }
function Describe($e) {
    $r = $e.Current.BoundingRectangle
    return [ordered]@{
        name      = $e.Current.Name
        placed    = $true
        offscreen = $false
        x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
        cx = [int]($r.X + $r.Width / 2); cy = [int]($r.Y + $r.Height / 2)
    }
}

# Wrap the ACTUAL statements in a switch that selects 'rename', so `break`
# inside the branch behaves exactly as it does in the real script.
$wrapped = "switch ('rename') { 'rename' {" + "`n" + ($bodyStatements -join "`n") + "`n} }"

# Only the two type accelerators are redirected to the stubs; the branch's own
# statements are otherwise run verbatim.
$patched = $wrapped -replace '\[Mouse\]::ClickAtForPid', '[FakeHost.Mouse]::ClickAtForPid'
$patched = $patched -replace '\[System\.Windows\.Forms\.SendKeys\]::SendWait', '[FakeHost.SendKeys]::SendWait'

# Values the branch reads from the script's param block, bound in its own scope.
$seed = @"
`$Action = 'rename'
`$Label = ''
`$Track = 1
`$On = -1
`$Text = 'New'
`$ProcessId = 4242
`$ControlLabels = @('Mute')
`$LabelEnv = @{ 'mute' = @('absent-alias', 'Mute'); 'solo' = @('Solo'); 'arm' = @('Record') }
`$WordOn = @('On')
`$WordOff = @('Off')
`$WordOpen = @('Open')
`$root = Get-Root
"@

$runner = [scriptblock]::Create($seed + "`n" + $patched)

$output = ''
$failure = $null
try {
    $emitted = @(& $runner 6>&1 | Where-Object { $_ -is [string] })
    if ($emitted.Count -gt 0) { $output = [string]$emitted[-1] }
} catch {
    $output = ''
    $failure = $_.Exception.Message
}

$parsed = $null
if ($output) {
    try { $parsed = $output | ConvertFrom-Json } catch { $parsed = $null }
}

[ordered]@{
    ok             = $true
    script         = $Script
    clauseFound    = $true
    statementCount = $bodyStatements.Count
    initialName    = $InitialName
    raw            = $output
    branch         = $parsed
    afterWriteSeen = $script:writeHappened
    getRootCalls   = $script:getRootCalls
    failure        = $failure
} | ConvertTo-Json -Depth 8 -Compress
