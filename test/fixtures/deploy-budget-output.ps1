param([Parameter(Mandatory=$true)][string]$Source,[switch]$BundledSuccess)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Install-LoopMidiPackage'},$true)
$Root='C:\qa-only-no-io';$script:setupCalls=0;$script:qaFound=$null
function Find-LoopMidiExe { $script:qaFound }
function Test-Path { param($LiteralPath) $true }
function Get-AuthenticodeSignature { param($LiteralPath) @{Status='Valid'} }
function Start-LoopMidiSetup { param($setupPath,$budgetSec) $script:setupCalls++;if($BundledSuccess){$script:qaFound=@{Path='C:\qa-only-no-io\loopMIDI.exe';Source='stub-success'};return $true};$false }
function Get-Command { param($Name) $null }
function New-Item { param($ItemType,$Path,[switch]$Force) }
function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing,$TimeoutSec) throw 'QA deliberate offline fallback failure; no network' }
function Get-FileHash { param($LiteralPath,$Algorithm) @{Hash='975399eb76e2c5a1d553ecd8975ab361261ccab8fd9412b8060b19877cb4e0d5'} }
function Expand-Archive { param($LiteralPath,$DestinationPath,[switch]$Force) }
function Get-ChildItem { param($LiteralPath,$Filter,[switch]$File) @{FullName='C:\qa-only-no-io\downloaded-setup.exe'} }
function Get-Process { param($Name,$ErrorAction) $null }
function Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force,$ErrorAction) }
function Warn { param($message) }
foreach($name in @('Get-RemainingBudgetSec','Install-LoopMidiPackage')) {
 $target=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
 if($target){Invoke-Expression $target.Extent.Text}
}
$result=Install-LoopMidiPackage
[ordered]@{setupCalls=$script:setupCalls;result=$result;truthy=[bool]$result;path=$result.Path;expected_null=($null -eq $result);no_real_io=$true}|ConvertTo-Json -Depth 4
if($script:setupCalls -ne 1){exit 1}
if($BundledSuccess){if($null -eq $result -or $result -is [array] -or $result.Path -ne 'C:\qa-only-no-io\loopMIDI.exe'){exit 1}}
elseif($null -ne $result){exit 1}
