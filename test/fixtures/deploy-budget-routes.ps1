param([Parameter(Mandatory=$true)][string]$Source,[ValidateSet('bundled-exhausted','pre-download-expiry','winget-lookup-expiry','near-expiry')]$Mode='bundled-exhausted')
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Source parse failed'}
$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Install-LoopMidiPackage'},$true)
if(-not $fn){throw 'Target function absent'}
$script:qaEpoch=[datetime]'2026-10-21T00:00:00'
$script:qaNow=$script:qaEpoch
$script:qaCalls=[Collections.Generic.List[object]]::new()
$Root='C:\qa-owned-budget-repro'
function Get-Date { $script:qaNow }
function Find-LoopMidiExe { $null }
function Test-Path { param($LiteralPath) $Mode -eq 'bundled-exhausted' }
function Get-AuthenticodeSignature { param($LiteralPath) @{Status='Valid'} }
function Start-LoopMidiSetup { param($setupPath,$budgetSec) $script:qaCalls.Add(@{operation='bundled';budget=$budgetSec});$script:qaNow=$script:qaEpoch.AddSeconds(361);$false }
function Get-Command { param($Name)
 if($Mode -eq 'winget-lookup-expiry'){$script:qaNow=$script:qaEpoch.AddSeconds(361);return @{Name='winget'}}
 if($Mode -eq 'near-expiry'){$script:qaNow=$script:qaEpoch.AddSeconds(350)}
 return $null
}
function Start-Process {param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru) $script:qaCalls.Add(@{operation='winget-start-after-lookup'});[pscustomobject]@{Id=777;HasExited=$true}}
function New-Item { param($ItemType,$Path,[switch]$Force) if($Mode -eq 'pre-download-expiry'){$script:qaNow=$script:qaEpoch.AddSeconds(361)} }
function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing,$TimeoutSec) $script:qaCalls.Add(@{operation='download-after-expiry';elapsed=($script:qaNow-$script:qaEpoch).TotalSeconds;timeout=$TimeoutSec});throw 'QA simulated network, no request sent' }
function Get-Process { param($Name,$ErrorAction) $null }
function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction) }
function Warn { param($message) $script:qaCalls.Add(@{operation='warning';message=$message}) }
$budgetHelper=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-RemainingBudgetSec'},$true)
if($budgetHelper){Invoke-Expression $budgetHelper.Extent.Text}
Invoke-Expression $fn.Extent.Text
$null=Install-LoopMidiPackage
$downloads=@($script:qaCalls|Where-Object operation -eq 'download-after-expiry')
$late=@($downloads|Where-Object elapsed -gt 360)
[ordered]@{source=$Source;lateDownloadCount=$late.Count;calls=$script:qaCalls;no_network_or_installer_executed=$true}|ConvertTo-Json -Depth 5
if($late.Count -or @($script:qaCalls|Where-Object operation -eq 'winget-start-after-lookup').Count){exit 1}
if($Mode -eq 'bundled-exhausted' -and @($script:qaCalls|Where-Object operation -eq 'bundled').Count -ne 1){exit 1}
if($Mode -eq 'near-expiry' -and ($downloads.Count -ne 1 -or $downloads[0].timeout -ne 10)){exit 1}
