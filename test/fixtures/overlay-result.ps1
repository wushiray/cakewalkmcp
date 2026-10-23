param([string]$Source)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$text = [IO.File]::ReadAllText($Source)
$scriptText = [regex]::Match($text, '(?s)const SCRIPT = String.raw`(.*?)`;').Groups[1].Value
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($scriptText,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$switch=$ast.Find({param($n) $n -is [Management.Automation.Language.SwitchStatementAst] -and ($n.Clauses | Where-Object { $_.Item1.Value -eq 'overlays' })},$true)
$clause=$switch.Clauses | Where-Object { $_.Item1.Value -eq 'overlays' }
$body=$clause.Item2.Extent.Text
$operation=[scriptblock]::Create($body.Substring(1,$body.Length-2))
Add-Type @'
using System;
public class CwBridge {
  public static bool AllowPost = true;
  public static uint GetWindowThreadProcessId(IntPtr h, out uint pid) {pid=123;return 1;}
  public static bool PostMessageW(IntPtr h, uint m, IntPtr w, IntPtr l) {return AllowPost;}
}
'@
function Find-SonarMain { [IntPtr]1 }
function Get-Overlays { param($TargetPid) $script:reads++; if($script:reads -eq 1){$script:before}else{$script:after} }
function Start-Sleep { param($Milliseconds) }
function Emit { param($value) $script:result=$value }
$a=[pscustomobject]@{hwndHex='11';cls='JUCE';title='a'}
$b=[pscustomobject]@{hwndHex='22';cls='JUCE';title='b'}
$d=[pscustomobject]@{hwndHex='33';cls='#32770';title='protected'}
$rows=@()
foreach($name in @('protected','post-failed','refused','nothing','partial','all')) {
  $script:reads=0; $script:result=$null
  $req=[pscustomobject]@{close=$true;closeDialogs=$false}
  [CwBridge]::AllowPost=($name -ne 'post-failed')
  $script:before=@($a,$b); $script:after=@()
  switch($name) {
    'protected' {$script:before=@($d);$script:after=@($d)}
    'post-failed' {$script:after=@($a,$b)}
    'refused' {$script:after=@($a,$b)}
    'nothing' {$script:before=@()}
    'partial' {$script:after=@($b)}
  }
  & $operation
  $rows += [pscustomobject]@{name=$name;result=$script:result}
}
ConvertTo-Json -Depth 8 -Compress -InputObject $rows
