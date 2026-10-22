# An installer owns the lock for its entire execution, including npm and MIDI.
function Enter-InstallerLock([string]$Name) {
  if (-not $Name) {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $Name = 'Local\CakewalkMcpInstaller-' + $sid
  }
  $mutex = [Threading.Mutex]::new($false, $Name)
  $owned = $false
  try {
    try { $owned = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $owned = $true }
    if (-not $owned) { throw 'Another cakewalkmcp installer is already running in this user session.' }
    return $mutex
  } catch {
    $mutex.Dispose()
    throw
  }
}

function Exit-InstallerLock($Mutex) {
  if ($Mutex) {
    try { $Mutex.ReleaseMutex() }
    finally { $Mutex.Dispose() }
  }
}
