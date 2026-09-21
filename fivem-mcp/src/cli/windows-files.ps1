# FiveAI MCP credential file helper (unified-artifact RFC section 5.2).
# Desktop-entry-only Windows operations. This script never touches the
# network, is never loaded by FiveM, and never receives token values on
# the command line - only literal file paths.
#
# Modes:
#   Acl     Disable inheritance and restrict access to the current user and
#           the Administrators group, then verify the applied boundary.
#   Verify  Check the boundary without modifying anything.
#   Move    Publish via the .NET Framework two-argument File.Move(source,
#           destination) semantics: the destination is never overwritten
#           (EXISTS is reported instead).
#
# Output: one line on stdout (OK or EXISTS), exit code 0 on success,
# exit code 1 with a stderr message on any failure.

param(
  [Parameter(Mandatory = $true)][ValidateSet("Acl", "Verify", "Move")][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Destination = ""
)

$ErrorActionPreference = "Stop"

function Write-Failure([string]$Message) {
  [Console]::Error.WriteLine($Message)
  exit 1
}

$CurrentUserSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$AdministratorsSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-32-544")

function Test-Boundary([string]$LiteralPath) {
  # True only when inheritance is disabled and every access rule is an
  # Allow rule for exactly the current user or Administrators, with both
  # present. Anything else (inherited rules, deny rules, other accounts)
  # fails the boundary.
  $item = Get-Item -LiteralPath $LiteralPath
  if ($item.PSIsContainer) { return $false }
  $acl = $item.GetAccessControl()
  if (-not $acl.AreAccessRulesProtected) { return $false }
  $seenUser = $false
  $seenAdministrators = $false
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { return $false }
    $sid = $null
    try {
      $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
      return $false
    }
    if ($sid -eq $CurrentUserSid.Value) { $seenUser = $true; continue }
    if ($sid -eq $AdministratorsSid.Value) { $seenAdministrators = $true; continue }
    return $false
  }
  return ($seenUser -and $seenAdministrators)
}

if ($Mode -eq "Acl") {
  $item = Get-Item -LiteralPath $Path
  if ($item.PSIsContainer) { Write-Failure "Acl target must be a file: $Path" }
  $acl = $item.GetAccessControl()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $null = $acl.RemoveAccessRuleSpecific($rule) }
  $null = $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($CurrentUserSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))
  $null = $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($AdministratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)))
  $item.SetAccessControl($acl)
  if (-not (Test-Boundary $Path)) { Write-Failure "ACL boundary verification failed after applying it: $Path" }
  [Console]::Out.WriteLine("OK")
  exit 0
}

if ($Mode -eq "Verify") {
  if (-not (Test-Boundary $Path)) { Write-Failure "credential file ACL does not meet the required boundary (inheritance disabled; only the current user and Administrators): $Path" }
  [Console]::Out.WriteLine("OK")
  exit 0
}

if ($Mode -eq "Move") {
  if ($Destination -eq "") { Write-Failure "Move requires -Destination" }
  if ([System.IO.File]::Exists($Destination)) { [Console]::Out.WriteLine("EXISTS"); exit 0 }
  try {
    [System.IO.File]::Move($Path, $Destination)
  } catch [System.IO.IOException] {
    if ([System.IO.File]::Exists($Destination)) { [Console]::Out.WriteLine("EXISTS"); exit 0 }
    Write-Failure "publish move failed: $($_.Exception.Message)"
  } catch {
    Write-Failure "publish move failed: $($_.Exception.Message)"
  }
  [Console]::Out.WriteLine("OK")
  exit 0
}

Write-Failure "unreachable mode: $Mode"
