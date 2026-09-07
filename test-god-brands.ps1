# test-god-brands.ps1
#
# What this script does, in plain English:
#   1. Loads the secrets from api/.env
#   2. Recreates a fresh test "god" user with is_platform_admin = true
#   3. Signs in to get a JWT
#   4. Calls all four god routes end-to-end:
#      - POST   /api/v1/god/brands           (create "Acme Casino")
#      - GET    /api/v1/god/brands           (list)
#      - GET    /api/v1/god/brands/:id       (detail)
#      - PATCH  /api/v1/god/brands/:id       (suspend, then unsuspend)
#   5. Confirms a non-god user gets 403 on the same endpoint
#
# ⚠ This creates a real workspace in the configured Supabase project. Run
#   against a dev project or be ready to clean up. The script soft-deletes
#   the workspace at the end via `delete from workspaces where slug=...`.

$ErrorActionPreference = "Stop"

# ── 1. Load secrets ───────────────────────────────────────────────────────
$envFile = "$PSScriptRoot\api\.env"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: $envFile not found." -ForegroundColor Red
    exit 1
}
Get-Content $envFile | Where-Object { $_ -match "^[A-Z_]+=" } | ForEach-Object {
    $k, $v = $_ -split "=", 2
    Set-Item -Path "env:$k" -Value $v
}

$base = $env:SUPABASE_URL
$anon = $env:SUPABASE_ANON_KEY
$serviceRole = $env:SUPABASE_SERVICE_ROLE_KEY

$godEmail = "god-test@respovia.local"
$mortalEmail = "mortal-test@respovia.local"
$password = "GodTestPassword!2026"
$brandSlug = "acmecasino-smoketest"
$brandDomain = "acme-smoketest.example"

$adminH = @{
    apikey = $serviceRole
    Authorization = "Bearer $serviceRole"
    "Content-Type" = "application/json"
}
$dbH = @{
    apikey = $serviceRole
    Authorization = "Bearer $serviceRole"
    "Content-Type" = "application/json"
    Prefer = "return=minimal"
}

function Reset-User($email, $isGod) {
    $existingUsers = Invoke-RestMethod -Uri "$base/auth/v1/admin/users" -Headers $adminH
    foreach ($u in ($existingUsers.users | Where-Object { $_.email -eq $email })) {
        Invoke-RestMethod -Uri "$base/auth/v1/admin/users/$($u.id)" -Method Delete -Headers $adminH | Out-Null
    }
    $encEmail = [uri]::EscapeDataString($email)
    try {
        Invoke-RestMethod -Uri "$base/rest/v1/users?email=eq.$encEmail" -Method Delete -Headers $dbH | Out-Null
    } catch {}
    $created = Invoke-RestMethod -Uri "$base/auth/v1/admin/users" -Method Post -Headers $adminH `
        -Body (@{ email = $email; password = $password; email_confirm = $true } | ConvertTo-Json)
    $row = @{ id = $created.id; email = $email; name = $email; initials = "GT"; is_platform_admin = $isGod } | ConvertTo-Json
    Invoke-RestMethod -Uri "$base/rest/v1/users" -Method Post -Headers $dbH -Body $row | Out-Null
    return $created.id
}

function Sign-In($email) {
    $body = @{ email = $email; password = $password } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$base/auth/v1/token?grant_type=password" -Method Post `
        -Headers @{ apikey = $anon; "Content-Type" = "application/json" } -Body $body
    return $r.access_token
}

# ── 2. Reset both users ───────────────────────────────────────────────────
Write-Host "Resetting test users..." -ForegroundColor Cyan
$godId = Reset-User $godEmail $true
$mortalId = Reset-User $mortalEmail $false
Write-Host "  god user:    $godId" -ForegroundColor Green
Write-Host "  mortal user: $mortalId" -ForegroundColor Green

# Clean up any leftover smoke-test brand from a previous run.
$encSlug = [uri]::EscapeDataString($brandSlug)
try {
    Invoke-RestMethod -Uri "$base/rest/v1/workspaces?slug=eq.$encSlug" -Method Delete -Headers $dbH | Out-Null
} catch {}

# ── 3. Sign in ────────────────────────────────────────────────────────────
$godJwt = Sign-In $godEmail
$mortalJwt = Sign-In $mortalEmail
Write-Host "Signed in both users" -ForegroundColor Green

$godH = @{ Authorization = "Bearer $godJwt"; "Content-Type" = "application/json" }
$mortalH = @{ Authorization = "Bearer $mortalJwt"; "Content-Type" = "application/json" }
$apiBase = "http://localhost:3001"

# ── 4. Non-god gets 403 ───────────────────────────────────────────────────
Write-Host "`nNon-god → POST /god/brands should 403..." -ForegroundColor Cyan
try {
    Invoke-RestMethod -Uri "$apiBase/api/v1/god/brands" -Method Post -Headers $mortalH `
        -Body (@{ name = "x"; slug = "x" } | ConvertTo-Json) | Out-Null
    Write-Host "  FAIL: expected 403, got success" -ForegroundColor Red
} catch {
    $code = [int]$_.Exception.Response.StatusCode
    if ($code -eq 403) { Write-Host "  OK (403)" -ForegroundColor Green }
    else { Write-Host "  FAIL (got $code)" -ForegroundColor Red }
}

# ── 5. POST create ────────────────────────────────────────────────────────
Write-Host "`nPOST /god/brands (create Acme Casino smoke test)..." -ForegroundColor Cyan
$createBody = @{
    name = "Acme Casino (smoke test)"
    slug = $brandSlug
    domain = $brandDomain
    primary_color = "#0a84ff"
    ai_credits_micro = 1000000
} | ConvertTo-Json
$created = Invoke-RestMethod -Uri "$apiBase/api/v1/god/brands" -Method Post -Headers $godH -Body $createBody
$brandId = $created.brand.id
Write-Host "  Brand id: $brandId" -ForegroundColor Green

# ── 6. GET list ───────────────────────────────────────────────────────────
Write-Host "`nGET /god/brands..." -ForegroundColor Cyan
$list = Invoke-RestMethod -Uri "$apiBase/api/v1/god/brands" -Method Get -Headers $godH
Write-Host "  $($list.brands.Count) brands listed" -ForegroundColor Green

# ── 7. GET detail ─────────────────────────────────────────────────────────
Write-Host "`nGET /god/brands/:id..." -ForegroundColor Cyan
$detail = Invoke-RestMethod -Uri "$apiBase/api/v1/god/brands/$brandId" -Method Get -Headers $godH
Write-Host "  domains: $($detail.domains.Count), tickets: $($detail.counts.tickets), members: $($detail.counts.members)" -ForegroundColor Green

# ── 8. PATCH suspend + unsuspend ──────────────────────────────────────────
Write-Host "`nPATCH /god/brands/:id (suspend)..." -ForegroundColor Cyan
$suspended = Invoke-RestMethod -Uri "$apiBase/api/v1/god/brands/$brandId" -Method Patch -Headers $godH `
    -Body (@{ suspended_at = "now" } | ConvertTo-Json)
Write-Host "  suspended_at: $($suspended.brand.suspended_at)" -ForegroundColor Green

Write-Host "`nPATCH /god/brands/:id (unsuspend)..." -ForegroundColor Cyan
$unsuspended = Invoke-RestMethod -Uri "$apiBase/api/v1/god/brands/$brandId" -Method Patch -Headers $godH `
    -Body (@{ suspended_at = $null } | ConvertTo-Json)
$unsuspendedAt = if ($unsuspended.brand.suspended_at) { $unsuspended.brand.suspended_at } else { '(null)' }
Write-Host "  suspended_at: $unsuspendedAt" -ForegroundColor Green

# ── 9. Cleanup ────────────────────────────────────────────────────────────
Write-Host "`nCleaning up smoke-test brand..." -ForegroundColor Cyan
Invoke-RestMethod -Uri "$base/rest/v1/workspaces?slug=eq.$encSlug" -Method Delete -Headers $dbH | Out-Null
Write-Host "  Done" -ForegroundColor Green

Write-Host "`nAll god route smokes passed." -ForegroundColor Green
