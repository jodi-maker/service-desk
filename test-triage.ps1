# test-triage.ps1
#
# What this script does, in plain English:
#   1. Loads the secrets from api/.env
#   2. If a test user already exists in Supabase Auth, deletes it (so we start clean)
#   3. Creates a fresh test user using the admin API (with a known password)
#   4. Signs in to get a temporary access token (JWT)
#   5. Adds that user to the demo workspace so they're allowed to use the API
#   6. Calls the triage endpoint on ticket TK-001 and prints the AI's response

$ErrorActionPreference = "Stop"

# ── 1. Load the secrets from api/.env ─────────────────────────────────────
$envFile = "$PSScriptRoot\api\.env"
if (-not (Test-Path $envFile)) {
    Write-Host "ERROR: $envFile not found. Did you fill in api/.env?" -ForegroundColor Red
    exit 1
}
Get-Content $envFile | Where-Object { $_ -match "^[A-Z_]+=" } | ForEach-Object {
    $k, $v = $_ -split "=", 2
    Set-Item -Path "env:$k" -Value $v
}

$base = $env:SUPABASE_URL
$anon = $env:SUPABASE_ANON_KEY
$serviceRole = $env:SUPABASE_SERVICE_ROLE_KEY
$workspaceId = "00000000-0000-0000-0000-000000000001"
$ticketId    = "00000000-0000-0000-0000-000000000301"  # TK-001
$email = "triage-test@respovia.local"
$password = "TriageTestPassword!2026"

$authAdminHeaders = @{
    apikey = $serviceRole
    Authorization = "Bearer $serviceRole"
    "Content-Type" = "application/json"
}

# ── 2. Delete any stale user with this email so we start clean ───────────
# Two cleanup steps:
#   a) Delete the auth.users row (so we can re-create the auth user fresh).
#   b) Delete the public.users row with our test email (workspace_members
#      cascades via FK). Without (b), the previous run leaves an orphan
#      public.users row with the OLD user_id but our test email — the
#      unique-email constraint then 409s the new insert, and the new
#      user_id never makes it into public.users, so requireAuth fails
#      with "Not a member of that workspace" later.
Write-Host "Looking for stale test user..." -ForegroundColor Cyan
$existingUsers = Invoke-RestMethod -Uri "$base/auth/v1/admin/users" -Headers $authAdminHeaders
$stale = $existingUsers.users | Where-Object { $_.email -eq $email }
if ($stale) {
    foreach ($u in $stale) {
        Invoke-RestMethod -Uri "$base/auth/v1/admin/users/$($u.id)" -Method Delete -Headers $authAdminHeaders | Out-Null
        Write-Host "Deleted stale auth user $($u.id)" -ForegroundColor Yellow
    }
} else {
    Write-Host "(no stale auth user)" -ForegroundColor Gray
}

# Clean up orphan public.users row by email (cascades to workspace_members).
$dbCleanupHeaders = @{
    apikey = $serviceRole
    Authorization = "Bearer $serviceRole"
}
$encodedEmail = [uri]::EscapeDataString($email)
try {
    Invoke-RestMethod -Uri "$base/rest/v1/users?email=eq.$encodedEmail" `
        -Method Delete -Headers $dbCleanupHeaders | Out-Null
    Write-Host "Cleaned up any orphan public.users row" -ForegroundColor Yellow
} catch {
    Write-Host "(no orphan public.users row)" -ForegroundColor Gray
}

# ── 3. Create the test user via admin API (auto-confirmed, no email needed) ─
$createBody = @{
    email = $email
    password = $password
    email_confirm = $true
} | ConvertTo-Json
$created = Invoke-RestMethod -Uri "$base/auth/v1/admin/users" -Method Post `
    -Headers $authAdminHeaders -Body $createBody
$userId = $created.id
Write-Host "Created fresh test user (id: $userId)" -ForegroundColor Green

# ── 4. Sign in to get a JWT ──────────────────────────────────────────────
$signinBody = @{ email = $email; password = $password } | ConvertTo-Json
$signin = Invoke-RestMethod -Uri "$base/auth/v1/token?grant_type=password" -Method Post `
    -Headers @{ apikey = $anon; "Content-Type" = "application/json" } -Body $signinBody
$jwt = $signin.access_token
Write-Host "Signed in (got access token)" -ForegroundColor Green

# ── 5. Add user to public.users + workspace_members ──────────────────────
# Just POST. Tolerate 409 (already exists). Print the response body for any
# other error so we can actually see what PostgREST is complaining about.
function Try-Insert {
    param([string]$Uri, [hashtable]$Headers, [string]$Body, [string]$Label)
    Write-Host "Inserting into $Label..." -ForegroundColor Cyan
    try {
        Invoke-RestMethod -Uri $Uri -Method Post -Headers $Headers -Body $Body | Out-Null
        Write-Host "  OK" -ForegroundColor Green
    } catch {
        $status = $null
        try { $status = [int]$_.Exception.Response.StatusCode } catch {}
        if ($status -eq 409) {
            Write-Host "  (already exists - OK)" -ForegroundColor Gray
            return
        }
        Write-Host "  FAILED (HTTP $status)" -ForegroundColor Red
        if ($_.ErrorDetails.Message) {
            Write-Host "  Response body: $($_.ErrorDetails.Message)" -ForegroundColor Red
        } else {
            Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
        }
        throw
    }
}

$dbAdminHeaders = @{
    apikey = $serviceRole
    Authorization = "Bearer $serviceRole"
    "Content-Type" = "application/json"
    Prefer = "return=minimal"
}

$userRow = @{ id = $userId; email = $email; name = "Triage Test"; initials = "TT" } | ConvertTo-Json
Try-Insert -Uri "$base/rest/v1/users" -Headers $dbAdminHeaders -Body $userRow -Label "public.users"

$memberRow = @{
    workspace_id = $workspaceId
    user_id = $userId
    role_id = "00000000-0000-0000-0000-000000000a01"  # Admin role
    active = $true
} | ConvertTo-Json
Try-Insert -Uri "$base/rest/v1/workspace_members" -Headers $dbAdminHeaders -Body $memberRow -Label "workspace_members"
Write-Host "User is a member of the demo workspace" -ForegroundColor Green

# ── 6. Call the triage endpoint ──────────────────────────────────────────
$apiHeaders = @{
    Authorization = "Bearer $jwt"
    "X-Workspace-Id" = $workspaceId
}
Write-Host "`nCalling triage on TK-001 (this takes ~5-10 seconds)..." -ForegroundColor Cyan
try {
    $result = Invoke-RestMethod -Uri "http://localhost:3001/api/v1/tickets/$ticketId/triage" `
        -Method Post -Headers $apiHeaders
    Write-Host "`n── TRIAGE RESULT ──" -ForegroundColor Green
    $result | ConvertTo-Json -Depth 8
} catch {
    Write-Host "`nTriage call failed:" -ForegroundColor Red
    Write-Host $_.Exception.Message
    if ($_.ErrorDetails.Message) { Write-Host $_.ErrorDetails.Message }
    Write-Host "`nIs the API running? In another PowerShell window: open the Respovia checkout, then cd api; bun run dev"
}
