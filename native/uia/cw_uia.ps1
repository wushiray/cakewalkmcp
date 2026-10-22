<#
cw_uia.ps1 — read and drive SONAR's track-strip controls.

WHY THIS FILE EXISTS

Six adapter tools were dead: cw_set_track_mute / solo / arm / volume / pan /
name. They went through CakeScript, which this build does not have. The track
strips expose every one of those controls to accessibility, but the recorded
finding was that writing is impossible: "Controls advertise AXSetValue / AXToggle
/ AXPress and the runtime accepts the call, but nothing changes."

That finding is half right, and the half that is wrong is the important half.

  READING works and is accurate. A control's Value is a live snapshot: 手动静音
  reads 打开/关闭, 独奏 reads 打开/关闭, 音量 reads the dB. That makes every write
  verifiable without a second mechanism.

  The ACCESSIBILITY ACTIONS do nothing. Confirmed again here: AXToggle and
  AXPress on 手动静音 both return success and leave the value unchanged.

  A REAL MOUSE EVENT works. SetCursorPos + mouse_event at the element's own
  BoundingRectangle toggles the control, and the value then reads back changed.

So the pattern is: locate by name through accessibility, verify through
accessibility, and act with a genuine click. All three parts are needed — the
click alone has nothing to aim at, and the accessibility action alone does
nothing.

A second correction, because it is why this was previously believed impossible:
the adapter's notes said "a plain UIA client sees 2 elements". Re-measured with a
project open, a plain UIA client sees 139 descendants and 82 of them are track
controls. That earlier number was taken with no project open, when the track
strips do not exist yet. Nothing outside a computer-use runtime was ever
required.

COORDINATES

UIA BoundingRectangle and SetCursorPos agree, both physical screen pixels, but
only because Mouse.cs calls SetProcessDPIAware. On a 150% display an unaware
process gets virtualised coordinates and every click lands 1.5x off — which
looks exactly like a control that ignores clicks.

ELEMENT NAMING

    "<label> on Track <N>"     e.g. 手动静音 on Track 3, 录制 on Track 3
    "<track name> on Track <N>"  the strip itself

Only tracks currently VISIBLE in the Track view have elements. A track scrolled
out of sight has none, and that is reported as such rather than as "no such
control", because the two need different fixes.

THIS FILE MUST KEEP ITS UTF-8 BYTE-ORDER MARK

Every label compared here is Chinese (手动静音, 独奏, 录制, 打开, 关闭). Windows
PowerShell 5.1 decodes a .ps1 as the system ANSI codepage unless the file begins
with a UTF-8 BOM. Strip the BOM and the literals are silently mis-decoded — the
clicks still work, `before` and `after` still read correctly, and only the
comparison against the requested state fails, so `verified` comes back false on a
write that actually succeeded. Check the first three bytes are EF BB BF.

USAGE

    cw_uia.ps1 -Action dump
    cw_uia.ps1 -Action find   -Label 手动静音 -Track 1
    cw_uia.ps1 -Action toggle -Label 手动静音 -Track 1
    cw_uia.ps1 -Action set    -Label 手动静音 -Track 1 -On 1
    cw_uia.ps1 -Action click  -Label 输入 -Track 1
    cw_uia.ps1 -Action listtracks

Output is a single JSON object on stdout.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('dump', 'find', 'toggle', 'set', 'click', 'listtracks', 'rename', 'inserttemplate')]
    [string]$Action,
    [string]$Label,
    [int]$Track = 0,
    [int]$On = -1,
    [string]$Text,
    # NOT $Pid: that is a read-only automatic variable in PowerShell and
    # assigning to it aborts the whole script.
    [int]$ProcessId = 0
)

$ErrorActionPreference = 'Stop'

# Emit UTF-8 on stdout. Without this, ConvertTo-Json writes in the console
# codepage (GBK here) while the Node caller decodes UTF-8, and every Chinese
# control label arrives as mojibake — which then makes a matching element look
# like a missing one.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationTypes
Add-Type -Path (Join-Path $PSScriptRoot 'Mouse.cs')

# The labels worth treating as controls. Used to keep `listtracks` from
# reporting every unrelated element that happens to end in " on Track N".
$ControlLabels = @(
    '音量', '声像', '增益', '手动静音', '独奏', '录制', '输入', '输出', '存档',
    '冻结音轨', '自动控制的静音', '自动控制读取', '自动控制写入', '自动控制道',
    '输入反馈', '试录子音轨', '信号探针', '编辑过滤器', '音轨颜色', '插值', '相位', '波形预览'
)

# The state words and labels that change between SONAR versions and UI languages,
# in ONE place, overridable from the environment so a rename is a config change
# rather than a code change.
#
# CW_UI_MUTE  etc. hold the control labels; CW_UI_ON / CW_UI_OFF hold the toggle
# state words; CW_UI_OPEN holds the file-dialog confirm button text.
# English fallbacks are provided because a localized build may use English
# labels on an otherwise Chinese install — each list is tried in order.
$LabelEnv = @{}
foreach ($pair in @(
    @('mute', 'CW_UI_MUTE',  @('手动静音', 'Mute', 'Manual Mute')),
    @('solo', 'CW_UI_SOLO',  @('独奏', 'Solo')),
    @('arm',  'CW_UI_ARM',   @('录制', 'Record', 'Arm'))
)) {
    $key, $envName, $defaults = $pair
    $v = [Environment]::GetEnvironmentVariable($envName)
    $LabelEnv[$key] = if ($v) { $v -split '\|' } else { $defaults }
}
$WordOn   = if ($env:CW_UI_ON)   { $env:CW_UI_ON   -split '\|' } else { @('打开', 'On', 'Open') }
$WordOff  = if ($env:CW_UI_OFF)  { $env:CW_UI_OFF  -split '\|' } else { @('关闭', 'Off', 'Closed') }
$WordOpen = if ($env:CW_UI_OPEN) { $env:CW_UI_OPEN -split '\|' } else { @('打开', 'Open') }

function Test-Word([string]$value, [string[]]$words) {
    foreach ($w in $words) { if ($value -eq $w) { return $true } }
    return $false
}

function Get-SonarPid {
    if ($ProcessId -ne 0) { return $ProcessId }
    $p = Get-Process Sonar -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { throw 'SONAR is not running' }
    return $p.Id
}

# A top-level dialog belonging to SONAR, found by its caption.
#
# The main frame is not the only window with elements: SONAR's file dialogs are
# separate top-level windows, and they are standard MFC — which means their
# controls DO honour AXSetValue and AXPress, unlike SONAR's own drawn controls.
# That difference is the whole reason a template can be inserted from here.
function Get-DialogRoot([string]$pattern) {
    $thePid = Get-SonarPid
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $thePid)
    $wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children, $cond)
    foreach ($w in $wins) {
        if ($w.Current.Name -match $pattern) { return $w }
    }
    return $null
}

function Get-Root {
    $thePid = Get-SonarPid
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $thePid)
    $wins = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children, $cond)
    if (-not $wins -or $wins.Count -eq 0) { throw "no top-level window for pid $thePid" }

    # Pick the main window by class, not by position.
    #
    # SONAR owns SEVERAL top-level windows: the main frame (`Sonar`), tooltip
    # shadows (`SysShadow`), a hidden `Internet Explorer_Hidden`, HUD panes. This
    # used to take the FIRST child for the pid, which worked only while the
    # enumeration happened to list the main frame first. It does not reliably:
    # once a tooltip appeared, the first child became `SysShadow`, which has zero
    # descendants, and every track control read as absent — a failure that looks
    # exactly like "this build has no such control".
    #
    # `Sonar` is the main frame's class and has been stable across the sessions
    # measured; the fallback keeps this working if that ever changes.
    $fallback = $null
    foreach ($w in $wins) {
        if ($w.Current.ClassName -eq 'Sonar') { return $w }
        if (-not $fallback -and $w.Current.Name -match 'Cakewalk') { $fallback = $w }
    }
    if ($fallback) { return $fallback }
    # Last resort: the window with the most descendants, which is the frame
    # rather than a shadow.
    $best = $null; $bestN = -1
    foreach ($w in $wins) {
        $n = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,
             [System.Windows.Automation.Condition]::TrueCondition).Count
        if ($n -gt $bestN) { $bestN = $n; $best = $w }
    }
    return $best
}

function Get-All($root) {
    return $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)
}

function Describe($e) {
    $r = $e.Current.BoundingRectangle
    # Some elements report an Empty rect, which arrives as NaN. Casting NaN to
    # [int] throws and takes the whole run with it, so an unplaced element is
    # reported as 0-size with null coordinates instead.
    #
    # IsNaN/IsInfinity, not IsFinite: PowerShell 5.1 runs on .NET Framework 4.x,
    # where Double.IsFinite does not exist — calling it fails the whole script
    # with "does not contain a method named IsFinite".
    $ok = -not ([double]::IsNaN($r.X) -or [double]::IsInfinity($r.X) -or
                [double]::IsNaN($r.Y) -or [double]::IsInfinity($r.Y) -or
                [double]::IsNaN($r.Width) -or [double]::IsInfinity($r.Width) -or
                [double]::IsNaN($r.Height) -or [double]::IsInfinity($r.Height))
    return [ordered]@{
        name      = $e.Current.Name
        value     = $e.Current.Name  # replaced by the value pattern below when available
        valueText = $null
        type      = $e.Current.ControlType.ProgrammaticName
        enabled   = $e.Current.IsEnabled
        placed    = $ok
        # IsOffscreen is the guard that matters. A strip scrolled out of the
        # Track view's clip region still reports a BoundingRectangle — a real
        # rectangle at a real screen position that is simply not visible. Clicking
        # its centre hits whatever the window actually shows there, so the click
        # silently lands on another control. Measured on track 58 of a 71-track
        # project: the mute button reported [905,378,33,33] while the Track view's
        # client area began at y=474, and clicking it did nothing at all.
        offscreen = $e.Current.IsOffscreen
        x         = if ($ok) { [int]$r.X } else { $null }
        y         = if ($ok) { [int]$r.Y } else { $null }
        w         = if ($ok) { [int]$r.Width } else { 0 }
        h         = if ($ok) { [int]$r.Height } else { 0 }
        cx        = if ($ok) { [int]($r.X + $r.Width / 2) } else { $null }
        cy        = if ($ok) { [int]($r.Y + $r.Height / 2) } else { $null }
    }
}

# A control's state lives in its ValuePattern where one exists, and in the Name
# otherwise. 手动静音 carries its state in the Value; 音量 carries the dB.
# Refuse to click a control the window is not actually showing.
#
# A strip scrolled out of the Track view's clip region still reports a
# BoundingRectangle: a real rectangle, at a real screen position, that is simply
# not displayed. Clicking its centre therefore hits whatever IS displayed there —
# a WRONG write rather than a failed one, which is the worse outcome. Measured on
# track 58 of a 71-track project, where the mute button reported [905,378,33,33]
# while the Track view's client area began at y=474 and the click did nothing.
function Get-ClickRefusal($root, $d, [string]$name) {
    if (-not $d.placed) {
        return [ordered]@{
            ok = $false; name = $name
            error = "'$name' reports no geometry"
            hint  = 'Scroll the track into view in the Track view, then retry.'
        }
    }
    # IsOffscreen alone is NOT enough, and this was measured rather than assumed:
    # track 58 of a 71-track project reported offscreen=false while sitting at
    # y=378 with the Track view's client area starting at y=474. SONAR's provider
    # calls a scrolled-out strip onscreen. Clicking it did nothing, and the tool
    # reported a failed write when the truth was a click into empty chrome.
    #
    # So the check is geometric, against the Track view's own rectangle: the
    # container whose accessibility Name is its class, CTRACKVIEW.
    $view = Find-Control $root 'CTRACKVIEW'
    if ($view) {
        $vr = $view.Current.BoundingRectangle
        $inside = ($d.cx -ge $vr.X -and $d.cx -le ($vr.X + $vr.Width) -and
                   $d.cy -ge $vr.Y -and $d.cy -le ($vr.Y + $vr.Height))
        if (-not $inside) {
            return [ordered]@{
                ok    = $false
                name  = $name
                error = "'$name' is scrolled out of the Track view, so a click would land on whatever is shown in its place"
                hint  = 'Scroll the track into view in the Track view, then retry.'
                where = [ordered]@{ control = @($d.cx, $d.cy)
                                    trackView = @([int]$vr.X, [int]$vr.Y, [int]$vr.Width, [int]$vr.Height) }
            }
        }
    }
    if ($d.offscreen) {
        return [ordered]@{
            ok = $false; name = $name
            error = "'$name' is offscreen"
            hint  = 'Scroll the track into view in the Track view, then retry.'
        }
    }
    return $null
}

function Get-Value($e) {
    try {
        $vp = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        if ($vp) { return $vp.Current.Value }
    } catch { }
    try {
        $tp = $e.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
        if ($tp) { return $tp.Current.ToggleState.ToString() }
    } catch { }
    return $null
}

function Find-Control($root, [string]$name) {
    foreach ($e in (Get-All $root)) {
        if ($e.Current.Name -eq $name) { return $e }
    }
    return $null
}

try {
    $root = Get-Root

    switch ($Action) {

        'listtracks' {
            $seen = New-Object System.Collections.Generic.List[int]
            $controls = 0
            foreach ($e in (Get-All $root)) {
                $n = $e.Current.Name
                if ($n -notmatch ' on Track (\d+)$') { continue }
                $t = [int]$Matches[1]
                $bare = ($n -replace '\s*on Track\s*\d+$', '').Trim()
                # Only real controls count. An element whose name before
                # " on Track N" is not a known label is chrome, and the track-name
                # element itself ("音轨 3 on Track 3") is the track, not a control.
                if ($ControlLabels -contains $bare) {
                    $controls++
                    if (-not $seen.Contains($t)) { $seen.Add($t) }
                }
            }
            [ordered]@{
                ok        = $true
                pid       = (Get-SonarPid)
                controls  = $controls
                # Track numbers the Track view is currently showing, ascending.
                tracks    = @($seen | Sort-Object)
            } | ConvertTo-Json -Depth 6 -Compress
        }

        'dump' {
            $out = @()
            foreach ($e in (Get-All $root)) {
                $n = $e.Current.Name
                if ($n -match ' on Track (\d+)$') {
                    $d = Describe $e
                    $d['valueText'] = Get-Value $e
                    $d['track'] = [int]$Matches[1]
                    $d['label'] = ($n -replace '\s*on Track\s*\d+$', '')
                    $out += $d
                }
            }
            [ordered]@{ ok = $true; pid = (Get-SonarPid); count = $out.Count; controls = $out } |
                ConvertTo-Json -Depth 6 -Compress
        }

        'inserttemplate' {
            if (-not $Text) { throw '-Text must be the full path to a .cwx track template' }
            if (-not (Test-Path -LiteralPath $Text)) { throw "no such template: $Text" }

            # Poll: the dialog is opened by a WM_COMMAND posted just before this
            # runs, and it takes a moment to appear. Checking once made the
            # command look broken when it had simply not finished opening.
            $dlg = $null
            for ($i = 0; $i -lt 20 -and -not $dlg; $i++) {
                $dlg = Get-DialogRoot '音轨模板|Track Template'
                if (-not $dlg) { Start-Sleep -Milliseconds 300 }
            }
            if (-not $dlg) {
                [ordered]@{
                    ok    = $false
                    error = 'the 导入音轨模板 dialog is not open'
                    hint  = 'Post command 0x8536 (插入 > 音轨模板) first.'
                } | ConvertTo-Json -Compress
                break
            }

            # Standard MFC controls: setValue and AXPress are honoured here, so no
            # mouse is involved and the dialog need not be in front.
            $edit = $null; $open = $null
            foreach ($e in $dlg.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                     [System.Windows.Automation.Condition]::TrueCondition)) {
                $t = $e.Current.ControlType.ProgrammaticName
                if (-not $edit -and $t -eq 'ControlType.Edit' -and $e.Current.Name -match '文件名|File name') { $edit = $e }
                $isOpenBtn = $false
                foreach ($ow in $WordOpen) { if ($e.Current.Name -match ('^' + [regex]::Escape($ow))) { $isOpenBtn = $true; break } }
                if (-not $open -and $t -eq 'ControlType.Button' -and $isOpenBtn) { $open = $e }
            }
            if (-not $edit -or -not $open) {
                [ordered]@{ ok = $false; error = 'could not find the filename field or the 打开 button' } |
                    ConvertTo-Json -Compress
                break
            }
            $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $vp.SetValue($Text)
            Start-Sleep -Milliseconds 250
            $ip = $open.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $ip.Invoke()
            Start-Sleep -Milliseconds 1500

            [ordered]@{ ok = $true; requested = $Text; invoked = '打开' } | ConvertTo-Json -Compress
        }

        'find' {
            if (-not $Label -or $Track -le 0) { throw '-Label and -Track are required' }
            $name = "$Label on Track $Track"
            $e = Find-Control $root $name
            if (-not $e) {
                [ordered]@{
                    ok      = $false
                    error   = "no element named '$name'"
                    hint    = 'Only tracks visible in the Track view expose controls; scroll the track into view.'
                } | ConvertTo-Json -Compress
                break
            }
            $d = Describe $e
            $d['valueText'] = Get-Value $e
            $d['ok'] = $true
            $d | ConvertTo-Json -Compress
        }

        'click' {
            if (-not $Label -or $Track -le 0) { throw '-Label and -Track are required' }
            $name = "$Label on Track $Track"
            $e = Find-Control $root $name
            if (-not $e) { [ordered]@{ ok = $false; error = "no element named '$name'" } | ConvertTo-Json -Compress; break }
            $before = Get-Value $e
            $d = Describe $e
            $refusal = Get-ClickRefusal $root $d $name
            if ($refusal) { $refusal | ConvertTo-Json -Compress; break }
            $why = [Mouse]::ClickAtForPid($d.cx, $d.cy, 1, (Get-SonarPid))
            if ($why) { throw "$name : $why" }
            Start-Sleep -Milliseconds 450
            # Re-resolve: the element may be rebuilt after a state change.
            $root2 = Get-Root
            $e2 = Find-Control $root2 $name
            $after = if ($e2) { Get-Value $e2 } else { $null }
            [ordered]@{
                ok        = $true
                name      = $name
                clicked   = "$($d.cx),$($d.cy)"
                before    = $before
                after     = $after
                changed   = ($before -ne $after)
                verified  = [bool]($e2 -and ($before -ne $after))
            } | ConvertTo-Json -Compress
        }

        'rename' {
            if (-not $Text) { throw '-Text is required' }
            if ($Track -le 0) { throw '-Track is required' }

            # The track-name field has no fixed accessibility name — its name IS
            # the track's name, which is the thing being changed. So it is located
            # by row instead: the element ending in " on Track N" whose rectangle
            # shares the strip's row with the mute button, and whose label is not
            # one of the known controls.
            # The mute label anchors the row lookup; it comes from the word list
            # so a renamed control does not silently break rename.
            $mute = $null
            foreach ($ml in $LabelEnv['mute']) {
                $mute = Find-Control $root "$ml on Track $Track"
                if ($mute) { break }
            }
            if (-not $mute) {
                [ordered]@{ ok = $false; error = "track $Track is not on screen" } |
                    ConvertTo-Json -Compress
                break
            }
            $rowY = [int]$mute.Current.BoundingRectangle.Y
            $nameEl = $null
            foreach ($e in (Get-All $root)) {
                $n = $e.Current.Name
                if ($n -notmatch " on Track $Track$") { continue }
                if (($n -replace '\s*on Track\s*\d+$', '').Trim() -in $ControlLabels) { continue }
                $r = $e.Current.BoundingRectangle
                if ([double]::IsNaN($r.X) -or $r.Width -lt 60) { continue }
                if ([Math]::Abs([int]$r.Y - $rowY) -le 4) { $nameEl = $e; break }
            }
            if (-not $nameEl) {
                [ordered]@{ ok = $false; error = "could not locate the name field for track $Track" } |
                    ConvertTo-Json -Compress
                break
            }
            $before = ($nameEl.Current.Name -replace '\s*on Track\s*\d+$', '').Trim()
            if ($before -eq $Text) {
                [ordered]@{ ok = $true; track = $Track; before = $before; after = $before
                            changed = $false; alreadyThere = $true; verified = $true } |
                    ConvertTo-Json -Compress
                break
            }
            $d = Describe $nameEl
            $refusal = Get-ClickRefusal $root $d $nameEl.Current.Name
            if ($refusal) { $refusal | ConvertTo-Json -Compress; break }
            # Double-click to edit, paste, commit.
            #
            # The clipboard rather than SendKeys: SendKeys cannot type Chinese,
            # and track names here are often Chinese. A paste carries any Unicode.
            # Double-click, then CHECK that the editor actually opened before
            # pasting. A strip that renders its name as part of a larger custom
            # control — a soft-synth track is the measured case, 'SI-Electric
            # Piano 1' on the multi-out piano strip — treats the first double-click
            # as a selection instead of an edit. A second one enters the editor.
            # The check is the caret: after entering edit mode the field selects
            # its text, which SendKeys ^a then replaces wholesale; without the
            # editor the paste goes nowhere and the rename silently reports
            # success from the unchanged name.
            $why = [Mouse]::ClickAtForPid($d.cx, $d.cy, 2, (Get-SonarPid))
            if ($why) { throw "$before : $why" }
            Start-Sleep -Milliseconds 800
            $why2 = [Mouse]::ClickAtForPid($d.cx, $d.cy, 1, (Get-SonarPid))
            if ($why2) { throw "$before : $why2" }
            Start-Sleep -Milliseconds 500
            Set-Clipboard -Value $Text
            [System.Windows.Forms.SendKeys]::SendWait('^a')
            Start-Sleep -Milliseconds 150
            [System.Windows.Forms.SendKeys]::SendWait('^v')
            Start-Sleep -Milliseconds 250
            [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
            Start-Sleep -Milliseconds 900

            $root2 = Get-Root
            $m2 = Find-Control $root2 "$($LabelEnv['mute']) on Track $Track"
            $after = $null
            if ($m2) {
                $rowY2 = [int]$m2.Current.BoundingRectangle.Y
                foreach ($e in (Get-All $root2)) {
                    $n = $e.Current.Name
                    if ($n -notmatch " on Track $Track$") { continue }
                    if (($n -replace '\s*on Track\s*\d+$', '').Trim() -in $ControlLabels) { continue }
                    $r = $e.Current.BoundingRectangle
                    if ([double]::IsNaN($r.X) -or $r.Width -lt 60) { continue }
                    if ([Math]::Abs([int]$r.Y - $rowY2) -le 4) {
                        $after = ($n -replace '\s*on Track\s*\d+$', '').Trim(); break
                    }
                }
            }
            [ordered]@{
                ok       = $true
                track    = $Track
                clicked  = "$($d.cx),$($d.cy)"
                before   = $before
                after    = $after
                requested = $Text
                changed  = ($before -ne $after)
                verified = ($after -eq $Text)
            } | ConvertTo-Json -Compress
        }

        'toggle' {
            if (-not $Label -or $Track -le 0) { throw '-Label and -Track are required' }
            $name = "$Label on Track $Track"
            $e = Find-Control $root $name
            if (-not $e) { [ordered]@{ ok = $false; error = "no element named '$name'" } | ConvertTo-Json -Compress; break }
            $before = Get-Value $e
            $d = Describe $e
            $refusal = Get-ClickRefusal $root $d $name
            if ($refusal) { $refusal | ConvertTo-Json -Compress; break }
            $why = [Mouse]::ClickAtForPid($d.cx, $d.cy, 1, (Get-SonarPid))
            if ($why) { throw "$name : $why" }
            Start-Sleep -Milliseconds 450
            $root2 = Get-Root
            $e2 = Find-Control $root2 $name
            $after = if ($e2) { Get-Value $e2 } else { $null }
            [ordered]@{
                ok       = $true
                name     = $name
                clicked  = "$($d.cx),$($d.cy)"
                before   = $before
                after    = $after
                changed  = ($before -ne $after)
                verified = [bool]($e2 -and ($before -ne $after))
            } | ConvertTo-Json -Compress
        }

        'set' {
            if (-not $Label -or $Track -le 0) { throw '-Label and -Track are required' }
            if ($On -lt 0) { throw '-On must be 0 or 1' }
            $name = "$Label on Track $Track"
            $e = Find-Control $root $name
            if (-not $e) { [ordered]@{ ok = $false; error = "no element named '$name'" } | ConvertTo-Json -Compress; break }
            # The state words come from the word list at the top of this file, so
            # a UI-text change across a SONAR version is a config override, not a
            # code edit. The value is matched against BOTH lists: a toggle whose
            # current state reads as neither on nor off is not settable by this
            # verb, and saying so beats clicking blindly.
            $target = if ($On -eq 1) { $WordOn[0] } else { $WordOff[0] }
            $before = Get-Value $e
            $isToggle = (Test-Word $before $WordOn) -or (Test-Word $before $WordOff)
            if (-not $isToggle) {
                [ordered]@{
                    ok = $false
                    name = $name
                    error = "'$name' reads '$before', which matches neither the on-words ($($WordOn -join '|')) nor the off-words ($($WordOff -join '|'))"
                } | ConvertTo-Json -Compress
                break
            }
            $alreadyRight = if ($On -eq 1) { Test-Word $before $WordOn } else { Test-Word $before $WordOff }
            if ($alreadyRight) {
                # Already right. Reporting `verified` true here matters: the
                # requested state IS the observed state, so this is success, and a
                # caller that treats "changed=false" as failure would retry
                # forever on an idempotent write.
                [ordered]@{
                    ok = $true; name = $name; before = $before; after = $before
                    changed = $false; alreadyThere = $true; verified = $true
                    note = 'already in the requested state; nothing clicked'
                } | ConvertTo-Json -Compress
                break
            }
            $d = Describe $e
            $refusal = Get-ClickRefusal $root $d $name
            if ($refusal) { $refusal | ConvertTo-Json -Compress; break }

            # Click, read back, and retry once if nothing moved.
            #
            # A single click is not always enough, and the reason is not the
            # control: the FIRST synthesised click after the pointer arrives from
            # elsewhere can be consumed activating the window. Measured on track
            # 80, where mute was the first click of the run and did nothing while
            # solo and arm — the very next two clicks, same strip, same method —
            # both landed. Retrying is safe because the success test is the
            # read-back, so a click that already worked is never repeated: the
            # loop exits on `verified` and only fires again when the value still
            # does not match. `attempts` reports how many it took.
            $after = $before
            $attempts = 0
            $maxAttempts = 2
            $e2 = $e
            while ($attempts -lt $maxAttempts -and $after -ne $target) {
                $why = [Mouse]::ClickAtForPid($d.cx, $d.cy, 1, (Get-SonarPid))
                if ($why) { throw "$name : $why" }
                $attempts++
                Start-Sleep -Milliseconds 450
                $root2 = Get-Root
                $e2 = Find-Control $root2 $name
                $after = if ($e2) { Get-Value $e2 } else { $null }
            }
            [ordered]@{
                ok         = $true
                name       = $name
                clicked    = "$($d.cx),$($d.cy)"
                attempts   = $attempts
                before     = $before
                after      = $after
                changed    = ($before -ne $after)
                alreadyThere = $false
                verified   = [bool]($e2 -and ($after -eq $target))
            } | ConvertTo-Json -Compress
        }
    }
}
catch {
    [ordered]@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
