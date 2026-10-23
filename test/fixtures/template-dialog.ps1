param(
    [Parameter(Mandatory = $true)]
    [string]$SourcePath
)

# Host-free executable check for Get-DialogRoot.
#
# The ACTUAL function body is extracted from the product script's AST and
# invoked against stub automation types. Nothing here touches SONAR, the
# desktop, or any Windows UI assembly - the only Add-Type is the stub source
# below, so this runs on any machine that has powershell.exe.
#
# This file is deliberately ASCII-only: the Chinese dialog caption is built
# from code points, and the title pattern passed to Get-DialogRoot is the
# product's own literal, so the extraction is language-agnostic.

$ErrorActionPreference = 'Stop'

$stub = @'
namespace System.Windows.Automation
{
    public enum TreeScope { Element = 1, Children = 2, Descendants = 4, Subtree = 7 }

    public class Condition
    {
        public static Condition TrueCondition = new Condition();
    }

    public class PropertyCondition : Condition
    {
        public int PropertyId; public object Value;
        public PropertyCondition(int id, object value) { PropertyId = id; Value = value; }
    }

    public class ControlType
    {
        public string ProgrammaticName;
        public ControlType(string n) { ProgrammaticName = n; }
        public static ControlType Window = new ControlType("ControlType.Window");
        public static ControlType Pane = new ControlType("ControlType.Pane");
    }

    public class AutomationElementInformation
    {
        public object Name { get; set; }
        public string ClassName { get; set; }
        public ControlType ControlType { get; set; }
        public int ProcessId { get; set; }
        public bool IsEnabled { get; set; }
    }

    public class AutomationElementCollection : System.Collections.IEnumerable
    {
        private readonly System.Collections.Generic.List<AutomationElement> _items =
            new System.Collections.Generic.List<AutomationElement>();
        public void Add(AutomationElement e) { _items.Add(e); }
        public int Count { get { return _items.Count; } }
        public System.Collections.IEnumerator GetEnumerator() { return _items.GetEnumerator(); }
    }

    public class AutomationElement
    {
        public static int ProcessIdProperty = 1;
        public AutomationElementInformation Current = new AutomationElementInformation();
        public System.Collections.Generic.List<AutomationElement> Children =
            new System.Collections.Generic.List<AutomationElement>();
        public bool Stale;

        public AutomationElement(string name, string cls, int pid)
        {
            Current.Name = name; Current.ClassName = cls; Current.ProcessId = pid;
            Current.ControlType = ControlType.Pane; Current.IsEnabled = true;
        }

        public AutomationElement AsWindow()
        {
            Current.ControlType = ControlType.Window;
            return this;
        }

        public static AutomationElement StaleElement(int pid)
        {
            AutomationElement e = new AutomationElement("gone", "#32770", pid);
            e.Stale = true;
            return e;
        }

        private static bool Matches(AutomationElement e, Condition c)
        {
            PropertyCondition pc = c as PropertyCondition;
            if (pc == null) { return true; }
            if (pc.PropertyId == AutomationElement.ProcessIdProperty)
            {
                return e.Current.ProcessId == (int)pc.Value;
            }
            return true;
        }

        public AutomationElementCollection FindAll(TreeScope scope, Condition c)
        {
            if (Stale) { throw new ElementNotAvailableException(); }
            AutomationElementCollection outCol = new AutomationElementCollection();
            foreach (AutomationElement child in Children)
            {
                if (Matches(child, c)) { outCol.Add(child); }
                if (scope == TreeScope.Descendants || scope == TreeScope.Subtree)
                {
                    foreach (AutomationElement d in Walk(child, c)) { outCol.Add(d); }
                }
            }
            return outCol;
        }

        public AutomationElement FindFirst(TreeScope scope, Condition c)
        {
            foreach (AutomationElement e in FindAll(scope, c)) { return e; }
            return null;
        }

        private static System.Collections.Generic.List<AutomationElement> Walk(
            AutomationElement e, Condition c)
        {
            System.Collections.Generic.List<AutomationElement> acc =
                new System.Collections.Generic.List<AutomationElement>();
            if (e.Stale) { throw new ElementNotAvailableException(); }
            foreach (AutomationElement child in e.Children)
            {
                if (Matches(child, c)) { acc.Add(child); }
                acc.AddRange(Walk(child, c));
            }
            return acc;
        }

        public static AutomationElement RootElement =
            new AutomationElement("Desktop", "#32769", 0);
    }

    public class ElementNotAvailableException : System.Exception
    {
        public ElementNotAvailableException() : base("element not available") { }
    }
}
'@

Add-Type -TypeDefinition $stub -Language CSharp

# Test-only stand-in for the real pid lookup, so the fixture needs no SONAR.
function Get-SonarPid { return 42 }

# Pull Get-DialogRoot out of the product script by AST, definition verbatim.
$text = [System.IO.File]::ReadAllText($SourcePath)
$tokens = $null; $errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errs)
if ($errs -and $errs.Count -gt 0) { throw "product script does not parse: $($errs[0].Message)" }
$fn = $ast.FindAll({
        param($n)
        $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
        $n.Name -eq 'Get-DialogRoot'
    }, $true) | Select-Object -First 1
if (-not $fn) { throw 'Get-DialogRoot not found in the product script' }
Invoke-Expression $fn.Extent.Text

$A = [System.Windows.Automation.AutomationElement]
# The dialog caption fragment used by inserttemplate, ASCII-only so the
# Windows PowerShell 5 encoding of this fixture cannot mangle it.
$pattern = 'Track Template'

function New-Win($name, $cls, $ownerPid, $isDialog) {
    $e = New-Object System.Windows.Automation.AutomationElement($name, $cls, $ownerPid)
    if ($isDialog) { $e.AsWindow() | Out-Null }
    return $e
}

$fail = @()
$dlgName = 'Import Track Template'

# --- Case 1: the measured shape. The SONAR frame owns a #32770 dialog; the
# dialog is a DESCENDANT of the frame, not a desktop child. The frame's own
# caption also matches the title regex, as a stale 'Track Template' file name
# would, and it must still not be returned.
$A::RootElement.Children.Clear()
$frame = New-Win "Cakewalk SONAR $dlgName" 'Sonar' 42 $false
$frame.AsWindow() | Out-Null
$owned = New-Win $dlgName '#32770' 42 $true
$owned.Children.Add((New-Win ([string][char]0x6587) 'Edit' 42 $false)) | Out-Null
$frame.Children.Add($owned) | Out-Null
$A::RootElement.Children.Add($frame) | Out-Null

$got = Get-DialogRoot $pattern
if (-not $got) { $fail += 'owned nested dialog not found' }
elseif (-not [object]::ReferenceEquals($got, $owned)) {
    $fail += "owned nested dialog: returned '$($got.Current.Name)' / '$($got.Current.ClassName)'"
}

# --- Case 2: a same-pid TOP-LEVEL #32770 dialog.
$A::RootElement.Children.Clear()
$frame2 = New-Win 'Cakewalk SONAR' 'Sonar' 42 $false
$top = New-Win $dlgName '#32770' 42 $true
$A::RootElement.Children.Add($frame2) | Out-Null
$A::RootElement.Children.Add($top) | Out-Null

$got = Get-DialogRoot $pattern
if (-not $got) { $fail += 'same-pid top-level dialog not found' }
elseif (-not [object]::ReferenceEquals($got, $top)) {
    $fail += "same-pid top-level dialog: returned '$($got.Current.Name)' / '$($got.Current.ClassName)'"
}

# --- Case 3: a FOREIGN pid dialog, nested under a foreign frame, is refused
# even though its caption matches.
$A::RootElement.Children.Clear()
$foreignFrame = New-Win 'Other App' 'OtherFrame' 99 $false
$foreignDlg = New-Win $dlgName '#32770' 99 $true
$foreignFrame.Children.Add($foreignDlg) | Out-Null
$A::RootElement.Children.Add($foreignFrame) | Out-Null
$A::RootElement.Children.Add((New-Win 'Cakewalk SONAR' 'Sonar' 42 $false)) | Out-Null

$got = Get-DialogRoot $pattern
if ($got) { $fail += "foreign-pid dialog was accepted: '$($got.Current.Name)'" }

# --- Case 4: same pid, caption matches, but it is not a #32770 dialog (and the
# same-pid frame itself matches the title too). Both refused.
$A::RootElement.Children.Clear()
$fakeMain = New-Win "Cakewalk SONAR - $dlgName" 'Sonar' 42 $false
$fakeMain.AsWindow() | Out-Null
$pane = New-Win $dlgName 'Afx:ControlBar' 42 $true
$fakeMain.Children.Add($pane) | Out-Null
$A::RootElement.Children.Add($fakeMain) | Out-Null

$got = Get-DialogRoot $pattern
if ($got) { $fail += "non-dialog title match was accepted: '$($got.Current.ClassName)' / '$($got.Current.Name)'" }

# --- Case 5: a stale element during enumeration must not throw.
$A::RootElement.Children.Clear()
$A::RootElement.Children.Add($A::StaleElement(42)) | Out-Null
try {
    $got = Get-DialogRoot $pattern
    if ($got) { $fail += 'stale-only tree returned a dialog' }
} catch {
    $fail += "stale element threw: $($_.Exception.Message)"
}

# --- No Windows UI assembly may have been loaded by this fixture.
foreach ($n in @('UIAutomationClient', 'UIAutomationTypes')) {
    $loaded = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { $_.GetName().Name -eq $n }
    if ($loaded) { $fail += "unexpectedly loaded $n" }
}

if ($fail.Count -gt 0) {
    [ordered]@{ ok = $false; failures = $fail } | ConvertTo-Json -Compress
    exit 1
}
[ordered]@{ ok = $true; cases = 5 } | ConvertTo-Json -Compress
exit 0
