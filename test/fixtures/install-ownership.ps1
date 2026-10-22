param([Parameter(Mandatory=$true)][string]$Source)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Ensure-LoopMidiPort'},$true)
if(-not $fn){throw 'Missing function'}
Invoke-Expression $fn.Extent.Text
$script:events=@(); $script:running=@(); $script:existing=@(); $script:ownedLoopMidi=$null
function Test-LoopMidiExecutable { param($Path) return $script:trusted }
function Get-Process { param($Name,$ErrorAction) return $script:running }
function Test-Path { param($LiteralPath) return $true }
function Get-Item { param($LiteralPath) return [pscustomobject]@{Property=$script:existing} }
function New-ItemProperty { param($LiteralPath,$Name,$Value,$PropertyType,[switch]$Force) $script:events+='write' }
function Stop-Process { param($InputObject,$Id,$ErrorAction,[switch]$Force) if($Id){throw 'Use the owned process object'}; $script:events+=('stop:'+$InputObject.Id) }
function Start-Process { param($FilePath,[switch]$PassThru,$WindowStyle) $script:events+='start'; return [pscustomobject]@{Id=30;StartTime=30;HasExited=$false} }
function Start-Sleep { param($Seconds,$Milliseconds) }
function Warn { param($Message) $script:events+='warn' }
$other=[pscustomobject]@{Id=10;StartTime=10;HasExited=$false}
$owned=[pscustomobject]@{Id=20;StartTime=20;HasExited=$false}
$results=@()
foreach($case in @('foreign','owned','mixed','none','existing','reused-id','untrusted')) {
  $script:events=@();$script:existing=@();$script:ownedLoopMidi=$null;$script:trusted=$true
  switch($case){
    'foreign' {$script:running=@($other)}
    'owned' {$script:running=@($owned);$script:ownedLoopMidi=$owned}
    'mixed' {$script:running=@($owned,$other);$script:ownedLoopMidi=$owned}
    'none' {$script:running=@()}
    'existing' {$script:running=@();$script:existing=@('loopMIDI Port')}
    'reused-id' {$script:running=@([pscustomobject]@{Id=20;StartTime=21});$script:ownedLoopMidi=$owned}
    'untrusted' {$script:running=@($owned);$script:ownedLoopMidi=$owned;$script:trusted=$false}
  }
  $r=Ensure-LoopMidiPort 'fixture.exe'
  $results+=[pscustomobject]@{case=$case;result=[bool]$r;events=@($script:events)}
}
$results|ConvertTo-Json -Depth 5 -Compress
