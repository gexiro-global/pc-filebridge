[CmdletBinding()]
param(
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'PCFileBridge\private\.env.local')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$destinationPath = [IO.Path]::GetFullPath($Destination)
$destinationDirectory = [IO.Path]::GetDirectoryName($destinationPath)
if ([string]::IsNullOrWhiteSpace($destinationDirectory)) {
  throw 'Runtime key destination must include a directory.'
}
if (Test-Path -LiteralPath $destinationPath) {
  throw 'Runtime key file already exists; this initializer never overwrites it.'
}

[IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $destinationDirectory '/inheritance:r' '/grant:r' "${account}:(OI)(CI)(F)" 'SYSTEM:(OI)(CI)(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the runtime key directory ACL.' }

$secureKey = Read-Host 'Paste the OpenAI tunnel runtime API key' -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
$plainKey = $null
try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  if ([string]::IsNullOrWhiteSpace($plainKey) -or $plainKey -match '[\r\n]') {
    throw 'Runtime key is empty or malformed.'
  }
  $utf8 = [Text.UTF8Encoding]::new($false)
  $stream = [IO.File]::Open($destinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = $utf8.GetBytes("OPENAI_API_KEY=$plainKey`n")
    $stream.Write($bytes, 0, $bytes.Length)
    [Array]::Clear($bytes, 0, $bytes.Length)
  } finally {
    $stream.Dispose()
  }
} finally {
  if ($secretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  }
  $plainKey = $null
  $secureKey.Dispose()
}

& icacls.exe $destinationPath '/inheritance:r' '/grant:r' "${account}:(R)" 'SYSTEM:(F)' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the runtime key file ACL.' }

Write-Output "RUNTIME_KEY_INITIALIZED path=$destinationPath overwrite=false"
