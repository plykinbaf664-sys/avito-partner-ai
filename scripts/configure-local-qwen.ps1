# Local-only credential setup. Never contacts production or prints secret values.
$ErrorActionPreference = 'Stop'
$projectPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$envPath = Join-Path $projectPath '.env.local'
if (-not (Test-Path -LiteralPath (Join-Path $projectPath 'package.json'))) {
    throw 'Run the script from the avito-partner-ai repository.'
}
$trackedEnv = & git -C $projectPath ls-files -- .env.local
if ($LASTEXITCODE -ne 0 -or $trackedEnv) { throw '.env.local must not be tracked by Git.' }
& git -C $projectPath check-ignore -q -- .env.local
if ($LASTEXITCODE -ne 0) { throw '.env.local must be ignored by Git.' }

function Read-PrivateValue([string] $label) {
    $secureValue = Read-Host -Prompt $label -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer).Trim() }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $secureValue.Dispose()
    }
}

function Set-PrivateFileAcl([string] $path) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = New-Object Security.AccessControl.FileSecurity
    $security.SetOwner($identity)
    $security.SetAccessRuleProtection($true, $false)
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $identity, [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow)))
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow)))
    Set-Acl -LiteralPath $path -AclObject $security
}

$apiKey = Read-PrivateValue 'QWEN_API_KEY (hidden)'
$apiHost = Read-PrivateValue 'QWEN_API_HOST, Singapore workspace host (hidden)'
if (-not $apiKey -or $apiKey -match '\s') { throw 'Invalid API key. Values were not saved.' }
if ($apiHost -notmatch '^https?://') { $apiHost = 'https://' + $apiHost }
$hostUri = $null
if (-not [Uri]::TryCreate($apiHost, [UriKind]::Absolute, [ref] $hostUri) -or
    $hostUri.Scheme -ne 'https' -or -not $hostUri.IsDefaultPort -or $hostUri.UserInfo -or
    $hostUri.Query -or $hostUri.Fragment -or
    $hostUri.Host -notmatch '^[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com$' -or
    $hostUri.AbsolutePath -notin @('/', '/compatible-mode/v1', '/compatible-mode/v1/')) {
    throw 'Invalid Singapore workspace host. Values were not saved.'
}
$values = [ordered]@{
    LLM_PROVIDER = 'qwen'
    QWEN_API_KEY = $apiKey
    QWEN_API_HOST = 'https://' + $hostUri.Host
    QWEN_MODEL = 'qwen3.8-flash'
    QWEN_CACHE_MODE = 'explicit'
    QWEN_STRUCTURED_OUTPUT = 'json_object'
    QWEN_TIMEOUT_MS = '120000'
    QWEN_THINKING_MODE = 'bounded'
    QWEN_THINKING_BUDGET = '2048'
    TEST_CHAT_LAB_DATABASE_URL = 'file:./data/test-chat-lab.db'
}
$existing = if (Test-Path -LiteralPath $envPath) { [IO.File]::ReadAllLines($envPath) } else { @() }
$lines = @($existing | Where-Object {
    $match = [regex]::Match($_, '^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=')
    -not ($match.Success -and $values.Contains($match.Groups[1].Value))
})
$lines += @($values.GetEnumerator() | ForEach-Object { $_.Key + '=' + $_.Value })
# Temporary storage is outside Git and readable only by this Windows user/SYSTEM.
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('avito-qwen-env-' + [Guid]::NewGuid() + '.tmp')
try {
    [IO.File]::WriteAllText($temporary, '')
    Set-PrivateFileAcl $temporary
    [IO.File]::WriteAllText($temporary, ($lines -join "`n") + "`n", (New-Object Text.UTF8Encoding($false)))
    # Windows PowerShell 5.1 binds $null to an empty string for this .NET
    # string argument. File.Replace then treats it as an invalid backup path.
    # NullString passes an actual .NET null and preserves atomic replacement.
    if (Test-Path -LiteralPath $envPath) { [IO.File]::Replace($temporary, $envPath, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $envPath) }
    Set-PrivateFileAcl $envPath
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    $apiKey = $null
    $apiHost = $null
    $values = $null
    $lines = $null
}
Write-Output 'Local Qwen configuration saved. Restart the local dev server to load it.'
