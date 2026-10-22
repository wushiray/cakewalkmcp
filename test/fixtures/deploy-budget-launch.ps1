param([Parameter(Mandatory=$true)][string]$Source,[int]$Budget=2,[switch]$AlreadyExited)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
$script:qaNow=[datetime]'2026-10-21T00:00:00';$epoch=$script:qaNow
$script:launches=[Collections.Generic.List[string]]::new()
$script:killed=[Collections.Generic.List[int]]::new()
function Get-Date {$script:qaNow}
function cmd { $script:launches.Add('synchronous-cmd');$script:qaNow=$script:qaNow.AddSeconds(361) }
function Start-Process {
 param($FilePath,$ArgumentList,$WindowStyle,[switch]$PassThru)
 $script:launches.Add('nonblocking-process')
 $p=[pscustomobject]@{Id=777;HasExited=[bool]$AlreadyExited}
 $p|Add-Member ScriptMethod Kill {[void]$script:killed.Add($this.Id)}
 return $p
}
function Stop-Process {param($Id,[switch]$Force,$ErrorAction)}
function Start-Sleep {param($Seconds,$Milliseconds) $script:qaNow=$script:qaNow.AddSeconds([double]$Seconds+[double]$Milliseconds/1000)}
function Find-LoopMidiExe {$null}
function Warn {param($message)}
foreach($name in @('Get-RemainingBudgetSec','Start-LoopMidiSetup')){
 $fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 if($fn){Invoke-Expression $fn.Extent.Text}
}
$result=Start-LoopMidiSetup 'C:\qa-only-no-io\setup.exe' $Budget
$elapsed=($script:qaNow-$epoch).TotalSeconds
[ordered]@{elapsed=$elapsed;budget=$Budget;launches=$script:launches;killed=$script:killed;result=$result;no_real_process=$true}|ConvertTo-Json
if($Budget -le 0){if($elapsed -ne 0 -or $script:launches.Count -ne 0 -or $result -ne $false){exit 1}}
elseif($elapsed -gt ($Budget+3) -or $script:launches.Contains('synchronous-cmd') -or $script:launches.Count -ne 1){exit 1}
elseif($AlreadyExited){if($script:killed.Count -ne 0){exit 1}}
elseif($script:killed.Count -ne 1 -or $script:killed[0] -ne 777){exit 1}
