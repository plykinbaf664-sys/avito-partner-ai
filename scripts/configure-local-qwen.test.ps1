# Offline regression checks. Only disposable fixtures and dummy credentials.
$ErrorActionPreference = 'Stop'
$sourceScript = Join-Path $PSScriptRoot 'configure-local-qwen.ps1'
$fixturePath = Join-Path ([IO.Path]::GetTempPath()) ('avito-local-qwen-fixture-' + [Guid]::NewGuid())
[IO.Directory]::CreateDirectory((Join-Path $fixturePath 'scripts')) | Out-Null
$fixtureScript = Join-Path $fixturePath 'scripts\configure-local-qwen.ps1'
$fixtureEnv = Join-Path $fixturePath '.env.local'
Copy-Item -LiteralPath $sourceScript -Destination $fixtureScript
[IO.File]::WriteAllText((Join-Path $fixturePath 'package.json'), '{}')
[IO.File]::WriteAllText((Join-Path $fixturePath '.gitignore'), ".env.local`n")
& git -C $fixturePath init -q
if ($LASTEXITCODE -ne 0) { throw 'Fixture Git initialization failed.' }

$global:avitoQwenFixtureKey = 'dummy-key-fixture'
$global:avitoQwenFixtureHost = 'https://fixture.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'
function Read-Host {
    param([string] $Prompt, [switch] $AsSecureString)
    if (-not $AsSecureString) { throw 'Credential input must be hidden.' }
    $value = if ($Prompt.StartsWith('QWEN_API_KEY')) { $global:avitoQwenFixtureKey } else { $global:avitoQwenFixtureHost }
    return ConvertTo-SecureString $value -AsPlainText -Force
}

function Assert-Configured {
    $content = [IO.File]::ReadAllText($fixtureEnv)
    foreach ($entry in @('LLM_PROVIDER=qwen', ('QWEN_API_KEY=' + $global:avitoQwenFixtureKey),
        'QWEN_API_HOST=https://fixture.ap-southeast-1.maas.aliyuncs.com',
        'QWEN_MODEL=qwen3.8-flash', 'QWEN_STRUCTURED_OUTPUT=json_object',
        'QWEN_TIMEOUT_MS=120000', 'QWEN_THINKING_MODE=bounded', 'QWEN_THINKING_BUDGET=2048',
        'TEST_CHAT_LAB_DATABASE_URL=file:./data/test-chat-lab.db')) {
        if (-not $content.Split("`n").Contains($entry)) { throw ('Expected configuration missing: ' + $entry.Split('=')[0]) }
    }
    if (([regex]::Matches($content, '(?m)^LLM_PROVIDER=')).Count -ne 1 -or
        ([regex]::Matches($content, '(?m)^QWEN_API_KEY=')).Count -ne 1) { throw 'Duplicate setting retained.' }
    $bytes = [IO.File]::ReadAllBytes($fixtureEnv)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
        throw 'Unexpected UTF-8 BOM.'
    }
    $acl = Get-Acl -LiteralPath $fixtureEnv
    if (-not $acl.AreAccessRulesProtected) { throw 'Credential ACL is inherited.' }
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18')
    foreach ($rule in $acl.Access) {
        if ($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed) {
            throw 'Unexpected credential-file reader.'
        }
    }
}

try {
    [IO.File]::WriteAllText($fixtureEnv, "# preserve comment`nUNRELATED_SETTING=retained`nANTHROPIC_API_KEY=dummy-old-key`nLLM_PROVIDER=anthropic`nQWEN_API_KEY=old-dummy`n export QWEN_API_KEY=duplicate-dummy`n")
    & $fixtureScript | Out-Null
    Assert-Configured
    $saved = [IO.File]::ReadAllText($fixtureEnv)
    if (-not $saved.Contains('UNRELATED_SETTING=retained') -or
        -not $saved.Contains('ANTHROPIC_API_KEY=dummy-old-key') -or
        -not $saved.Contains('# preserve comment')) { throw 'Unrelated configuration lost.' }
    Write-Output 'PASS: existing env replaced atomically, other settings retained, private ACL, no BOM'

    $global:avitoQwenFixtureKey = 'dummy-replacement-key'
    & $fixtureScript | Out-Null
    Assert-Configured
    Write-Output 'PASS: repeated setup replaces credentials without duplicate variables'

    $beforeInvalid = [IO.File]::ReadAllText($fixtureEnv)
    $global:avitoQwenFixtureHost = 'https://example.invalid'
    $rejected = $false
    try { & $fixtureScript | Out-Null } catch {
        if ($_.Exception.Message -notmatch 'Invalid Singapore workspace host') { throw }
        $rejected = $true
    }
    if (-not $rejected -or [IO.File]::ReadAllText($fixtureEnv) -ne $beforeInvalid) {
        throw 'Invalid input changed the credential file.'
    }
    Write-Output 'PASS: invalid host rejected without changing existing env'

    $global:avitoQwenFixtureHost = 'fixture.ap-southeast-1.maas.aliyuncs.com'
    Remove-Item -LiteralPath $fixtureEnv -Force
    & $fixtureScript | Out-Null
    Assert-Configured
    Write-Output 'PASS: missing env created with normalized host and private ACL'
} finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixturePath)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedFixture.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        -not [IO.Path]::GetFileName($resolvedFixture).StartsWith('avito-local-qwen-fixture-')) {
        throw 'Unsafe fixture cleanup path.'
    }
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}
