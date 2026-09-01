<#
  mutcheck-agent-gate.ps1 -- mutation check for the agent gate (#297).

  THE BUG THIS GUARDS
  -------------------
  `agent-gate.md` was DECORATIVE. The Planner web app seeded it, rendered it and let the user
  edit it, and then nothing on the agent side ever read it again: `rg -i agent-gate` over the
  plugin tree returned zero hits. So the one standing permission the user had written -- in the
  one file the agent can never forge, because the agent never writes it -- could not reach the
  gate it was written to open. Every irreversible action still failed closed on a per-task
  journal attribution check, exactly as if the file did not exist.

  Wiring it up is the easy half. The dangerous half is wiring it up WRONG, and the issue names
  the specific wrong reading: the live gate says `focus-planner-ado-codeapp is in YOLO mode` and
  `Creating and publishing a pull request in any repository ... do not gate it`, and NEITHER
  authorises merging a pull request in `focus-planner`. A "gate exists => act freely" reading
  grants a permission that was never given, which is strictly worse than the decorative file.

  WHAT IS ASSERTED
  ----------------
  Seven guarantees, one arm each, and each arm is killed by ONE designated mutation and no other
  (the matrix at the end enforces that, and fails if an arm is redundant or over-broad):

    A  floor-overrides-allow          a floor rule beats an allow rule covering the same action
    B  floor-overrides-human-approval a floor rule beats a human `approve` in the journal
    C  repo-scope                     a rule naming a repo matches ONLY that repo, whole-token
    D  create-is-not-merge            a rule about CREATING a PR never authorises MERGING one
    E  absent-file-fail-closed        absent / empty / malformed gate == the pre-#297 behaviour
    F  enum-validation                -Action is a closed enum; an unknown kind is REFUSED
    G  action-omitted-unchanged       with no -Action the output is the pre-#297 output exactly
    H  gate-allowed-surfaces-human    a gate verdict still REPORTS a human waiting below the turn

  Arm H is the data half of #302 and does not change any verdict. A `gate-allowed` short-circuits
  the journal read, so without this the caller cannot tell "nobody has said anything" from "he
  replied 'don't' ninety seconds ago" -- and "stop when he says stop" becomes an instruction with
  nothing behind it. Two mutations name arm H (M8 always-false, M9 always-true), which the aim
  check permits: it requires each MUTATION to be caught by exactly one arm, not each arm to own
  exactly one mutation. A field that is always false is missing and a field that is always true
  is noise, so only an arm asserting both directions kills both.

  Plus one CORPUS arm, `L`, which runs the REAL live gate text (embedded verbatim below) and
  asserts the finding the issue turns on: merging a focus-planner PR is NOT authorised, while
  opening one IS. It is deliberately EXCLUDED from the one-arm-one-mutation matrix, because it
  covers several guarantees at once and is therefore expected to be killed by more than one
  mutation. That redundancy is the reason to have it: the seven arms prove the mechanism, `L`
  proves the mechanism gives the right answer on the text that actually exists.

  If the live gate file is present on this machine it is ALSO evaluated, as an ADVISORY report
  only. The user is entitled to change his own gate, so a guard that went red when he did would
  be crying wolf; the report says what his current text authorises and never fails on it.

  Runs the REAL oa-state.ps1 as a child process against isolated synthetic journal/state/gate
  folders (-JournalDir / -StateDir / -GatePath), so live state, live journals and the live gate
  file are never touched -- and the gate is never written by anything here, which is the property
  that makes it trustworthy in the first place.

  Mutations run BY DEFAULT, because run-sweeps.ps1 invokes these with no arguments beyond
  -ScriptPath; a mutcheck that only ran its baseline unless asked would report a comfortable
  green every night while proving nothing.

    powershell -File mutcheck-agent-gate.ps1 -ScriptPath <path-to-oa-state.ps1>
    powershell -File mutcheck-agent-gate.ps1 -BaselineOnly     # skip the mutants
#>
[CmdletBinding()]
param(
  [string]$ScriptPath,
  [switch]$BaselineOnly
)

$ErrorActionPreference = 'Stop'

# Default to the installed skill's oa-state.ps1 when run by hand; run-sweeps.ps1 passes
# -ScriptPath explicitly so the nightly sweep guards the PRODUCTION copy, not the repo's.
if (-not $ScriptPath) {
  $candidates = @(
    (Join-Path $PSScriptRoot '..\skills\overnight-agent\oa-state.ps1'),
    (Join-Path $env:LOCALAPPDATA 'overnight-agent\oa-state.ps1'),
    "$env:USERPROFILE\.copilot\installed-plugins\focus-planner\overnight-agent\skills\overnight-agent\oa-state.ps1"
  )
  foreach ($c in $candidates) { if (Test-Path $c) { $ScriptPath = (Resolve-Path $c).Path; break } }
}
if (-not $ScriptPath -or -not (Test-Path $ScriptPath)) { throw "oa-state.ps1 not found (pass -ScriptPath)" }

# --- fixture material ---------------------------------------------------------------------
# The rules below are the live gate's, VERBATIM. They are quoted rather than paraphrased on
# purpose: a paraphrase would drift towards whatever the matcher happens to accept, and the whole
# question the issue asks is what THIS text authorises.
#
# TWO generations are pinned here, because Shiv rewrote the file on 2026-09-01 and both texts
# still earn their keep:
#   * the ORIGINAL (`*_V1`) is the prefix trap -- `focus-planner` is a prefix of
#     `focus-planner-ado-codeapp` -- so arm C keeps testing against it forever.
#   * the CURRENT is what the agent actually reads tonight, and arm L asserts its real finding.
$RULE_YOLO_REPO = 'focus-planner-ado-codeapp is in YOLO mode, dont ask just do, Im the only user'
$RULE_EMAIL_SELF = 'Emailing myself'
$RULE_REPLY = 'Responding to an interaction in a 1-1 chat or email with valuable info (not just shiv is oof). If doing so, append message signature indicating that this was sent by bot and that shiv will review when he gets back.'
$RULE_CREATE_PR = 'Creating and publishing a pull request in any repository, then continuing to work on it until all checks pass, is easily reversible and has no consequence; do not gate it.'
$FLOOR_MANY = 'Send-to-many (group/channel, manager, mass email)'
$FLOOR_FRESH = 'Starting a fresh conversation with someone in chat/email'

# The CURRENT live gate (mtime 2026-09-01T06:42Z), verbatim. Shiv answered the question #297
# deliberately left open -- "if he wants this repo auto-mergeable that is a question to put to
# him" -- by naming THIS repo and adding a data-loss floor.
$RULE_YOLO_THIS_REPO = 'focus-planner is in YOLO mode, dont ask just do, Im the only user. If you ship bug in a PR to prod, dont worry we can easily revert it.'
$FLOOR_MANY_LIVE = 'Send-to-many (group/channel, mass email)'
$FLOOR_DATA_LOSS = 'Outcome can result in permanent data loss'

# An ALLOW rule carrying outcome words but NO verb the action table knows. Used by arm I to prove
# outcome phrasing is confined to the floor: if it were applied to both lists, this would read as
# a GRANT for delete_data, which is the one direction that must never happen.
$ALLOW_OUTCOME_SHAPED = 'A permanent data loss here would be perfectly acceptable'

function New-Gate {
  param([string[]]$Allow, [string[]]$Ask)
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine('# Agent gate')
  [void]$sb.AppendLine()
  [void]$sb.AppendLine('<!-- planner-agent-gate v1 -- you own this file. The overnight agent reads it and never writes it. -->')
  [void]$sb.AppendLine()
  [void]$sb.AppendLine('## Do not gate these (reversible)')
  [void]$sb.AppendLine()
  foreach ($a in $Allow) { [void]$sb.AppendLine("- $a") }
  [void]$sb.AppendLine()
  [void]$sb.AppendLine('## Always ask (safety floor)')
  [void]$sb.AppendLine()
  foreach ($a in $Ask) { [void]$sb.AppendLine("- $a") }
  return $sb.ToString()
}

# The full ORIGINAL gate, reassembled from the verbatim rules above.
$LIVE_GATE = New-Gate -Allow @($RULE_YOLO_REPO, $RULE_EMAIL_SELF, $RULE_REPLY, $RULE_CREATE_PR) -Ask @($FLOOR_MANY, $FLOOR_FRESH)

# The CURRENT gate, likewise.
$LIVE_GATE_NOW = New-Gate -Allow @($RULE_YOLO_THIS_REPO, $RULE_EMAIL_SELF, $RULE_CREATE_PR) -Ask @($FLOOR_MANY_LIVE, $FLOOR_DATA_LOSS)

$AgentBlock = @'
# Task {ID}: synthetic

Some user notes at the top.

---
<!-- OVERNIGHT-AGENT do not edit this line; the agent manages everything below it -->

## Overnight Agent

**Status:** Proposed - plan v1 - 2026-08-31

<!-- from: overnight-agent -->
The agent's last turn. Awaiting a decision.

**Needs from you:** approve to take the irreversible step.
'@

# A genuine, positively-attributed human approval. Used by arm B to prove the floor beats it.
$HumanApprove = "## 2026-08-31`n`n<!-- from: me -->`napprove"

# A human REFUSAL below the agent's turn. Arm H's point: this changes no verdict -- the gate
# still says allowed -- but the caller must be able to SEE it, or "stop when he says stop" is an
# instruction nobody can enforce. Deliberately not an affirmative, so it cannot be confused with
# a consent signal; the field being asserted is presence, not meaning.
$HumanWaiting = "## 2026-09-01`n`n<!-- from: me -->`ndo not send that, hold off"

# The same message with NO provenance marker. `trailing_has_user` uses the fail-OPEN reader, so
# this must still register: the cost of missing a human here is acting over a refusal.
$UnmarkedWaiting = "## 2026-09-01`n`ndo not send that, hold off"

# The two MACHINE shapes, which must read FALSE. These bound how wrong a consumer can be if it
# mistakes the field for "he refused" (the #302 hazard): the agent's own unstamped turn is
# excluded by the managed-heading rule (#272) and a sibling skill's turn by the sibling-reopen
# fix, so neither can make stray machine text look like a human changing his mind. Measured, then
# pinned here -- the residual true-but-not-him case is genuinely unattributed prose, and that is
# exactly why the consumer must read `true` as "stop and read", never as "he said no".
$AgentTurnNoMarker = "## Overnight Agent`n`n**Status:** In progress`nI have shipped the thing and it is fine."
$SiblingTurn = "## 2026-09-01`n`n<!-- from: dance-church -->`nAdded your class."

function New-Journal {
  param([string]$Dir, [string]$Id, [string[]]$Entries)
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.AppendLine(($AgentBlock -replace '\{ID\}', $Id))
  foreach ($e in $Entries) {
    [void]$sb.AppendLine()
    [void]$sb.AppendLine($e)
  }
  [System.IO.File]::WriteAllText((Join-Path $Dir "task-$Id.md"), $sb.ToString(), [System.Text.UTF8Encoding]::new($false))
}

# --- the arms ------------------------------------------------------------------------------
# Each arm is a self-contained world: its own gate text (or none), its own journal, and a list
# of queries with expectations. `Diagnostic` arms are asserted but excluded from the
# one-arm-one-mutation matrix.
#
# ASSERTION DISCIPLINE. Arms A and B both assert a DENY, and they must be told apart by which
# mutation kills them, so each asserts ONLY the field that isolates its own guarantee:
#   A asserts consent_ok=false where the ALLOW list would have said true  -> killed by order swap
#   B asserts consent_ok=false where the JOURNAL would have said true     -> killed by short-circuit removal
# Neither asserts `reason`, because a reason assertion would make each sensitive to the other's
# mutation and collapse the isolation. `reason` and the verbatim `gate_rule` are asserted in
# arm L, which is allowed to be broad.
$arms = [ordered]@{
  'A-floor-overrides-allow'          = @{
    why     = 'a floor rule beats an allow rule covering the SAME action kind'
    gate    = (New-Gate -Allow @('Sending email to a group channel is fine') -Ask @($FLOOR_MANY))
    entries = @()
    queries = @(
      @{ args = @('-Action', 'send_email_many'); expect = @{ consent_ok = $false } }
    )
  }
  'B-floor-overrides-human-approval' = @{
    why     = 'a floor rule beats a genuine human `approve` sitting in the journal'
    gate    = (New-Gate -Allow @($RULE_EMAIL_SELF) -Ask @($FLOOR_FRESH))
    entries = @($HumanApprove)
    queries = @(
      # Control: the journal really does grant consent, so the deny below is not vacuous.
      @{ args = @(); expect = @{ consent_ok = $true } }
      @{ args = @('-Action', 'send_email_new_thread'); expect = @{ consent_ok = $false } }
    )
  }
  'C-repo-scope'                     = @{
    why     = 'a repo-scoped rule matches that repo and NOT one it is merely a prefix of'
    gate    = (New-Gate -Allow @($RULE_YOLO_REPO) -Ask @($FLOOR_MANY))
    entries = @()
    queries = @(
      # `focus-planner` is a PREFIX of `focus-planner-ado-codeapp`. Substring matching says yes
      # here, and saying yes here is the false grant the whole issue is about.
      @{ args = @('-Action', 'merge_pr', '-Repo', 'focus-planner'); expect = @{ consent_ok = $false } }
      @{ args = @('-Action', 'merge_pr', '-Repo', 'focus-planner-ado-codeapp'); expect = @{ consent_ok = $true } }
      # No -Repo at all: a repo-scoped rule cannot be shown to apply, so it does not.
      @{ args = @('-Action', 'merge_pr'); expect = @{ consent_ok = $false } }
      # `owner/name` resolves to the same repo as the bare name.
      @{ args = @('-Action', 'merge_pr', '-Repo', 'shivbijlani/focus-planner-ado-codeapp'); expect = @{ consent_ok = $true } }
    )
  }
  'D-create-is-not-merge'            = @{
    why     = 'CREATING a pull request is authorised; MERGING one is not the same action'
    gate    = (New-Gate -Allow @($RULE_CREATE_PR) -Ask @($FLOOR_MANY))
    entries = @()
    queries = @(
      @{ args = @('-Action', 'open_pr', '-Repo', 'focus-planner'); expect = @{ consent_ok = $true } }
      @{ args = @('-Action', 'merge_pr', '-Repo', 'focus-planner'); expect = @{ consent_ok = $false } }
      # Near neighbours the same rule must not reach: "publishing" is not a release, and
      # "publishing" is not posting in public (no word boundary after `public` in `publishing`).
      @{ args = @('-Action', 'publish_release', '-Repo', 'focus-planner'); expect = @{ consent_ok = $false } }
      @{ args = @('-Action', 'post_public'); expect = @{ consent_ok = $false } }
    )
  }
  'E-absent-file-fail-closed'        = @{
    why     = 'absent / empty / malformed gate behaves EXACTLY as before #297'
    gate    = $null            # no gate file at all
    entries = @()
    queries = @(
      @{ args = @('-Action', 'merge_pr', '-Repo', 'focus-planner'); expect = @{ consent_ok = $false; gate_state = 'absent' } }
      @{ args = @('-Action', 'send_email_self'); expect = @{ consent_ok = $false; gate_state = 'absent' } }
    )
    # Two more worlds for the same guarantee, run with a substituted gate file.
    extraGates = @(
      @{ text = ''; state = 'empty' }
      @{ text = "# Agent gate`n`nJust some prose. No sections, no bullets.`n"; state = 'malformed' }
    )
  }
  'F-enum-validation'                = @{
    why     = '-Action is a CLOSED enum; an action outside it is refused, not silently ignored'
    gate    = (New-Gate -Allow @($RULE_EMAIL_SELF) -Ask @($FLOOR_MANY))
    entries = @()
    mustFail = @(
      @('-Action', 'rm_minus_rf'),
      @('-Action', 'merge'),
      @('-Action', 'anything')
    )
    queries = @(
      # Control: a VALID kind still works, so the arm is not just asserting "everything fails".
      @{ args = @('-Action', 'send_email_self'); expect = @{ consent_ok = $true } }
    )
  }
  'G-action-omitted-unchanged'       = @{
    why     = 'with no -Action the verdict JSON is the pre-#297 shape, field for field'
    # A gate whose FLOOR would block, and whose ALLOW would permit, several kinds -- so if the
    # gate were consulted at all without -Action, this arm would see it.
    gate    = (New-Gate -Allow @($RULE_EMAIL_SELF, $RULE_CREATE_PR) -Ask @($FLOOR_MANY, $FLOOR_FRESH))
    entries = @($HumanApprove)
    fields  = @('id', 'consent_ok', 'reason', 'human_segments', 'affirmative_phrase',
      'affirmative_author', 'affirmative_unattributed', 'trailing_has_user', 'path')
    queries = @(
      @{ args = @(); expect = @{ consent_ok = $true; reason = 'human-authored-affirmative' } }
    )
  }
  'H-gate-allowed-surfaces-human'    = @{
    why     = 'a gate verdict still REPORTS whether a human is waiting below the turn (#302)'
    gate    = (New-Gate -Allow @($RULE_EMAIL_SELF) -Ask @($FLOOR_MANY))
    entries = @()
    queries = @(
      # Both halves are `gate-allowed` -- the verdict must NOT move. Only the reported fact does.
      # A field that is always true is the same failure as no field, so the arm asserts both.
      @{ args = @('-Action', 'send_email_self'); entries = @($HumanWaiting)
        expect = @{ consent_ok = $true; reason = 'gate-allowed'; trailing_has_user = $true }
      }
      @{ args = @('-Action', 'send_email_self'); entries = @()
        expect = @{ consent_ok = $true; reason = 'gate-allowed'; trailing_has_user = $false }
      }
      # And it must be the FAIL-OPEN reader: unmarked prose below the turn is somebody, and the
      # cost of being wrong here is one pause, not a merge over a refusal.
      @{ args = @('-Action', 'send_email_self'); entries = @($UnmarkedWaiting)
        expect = @{ consent_ok = $true; reason = 'gate-allowed'; trailing_has_user = $true }
      }
      # Fail-open does NOT mean "any text at all". The two identifiable MACHINE shapes read false,
      # which is what bounds the #302 consumer's blast radius: neither the agent's own unstamped
      # turn nor a sibling skill's can masquerade as a human changing his mind.
      @{ args = @('-Action', 'send_email_self'); entries = @($AgentTurnNoMarker)
        expect = @{ consent_ok = $true; reason = 'gate-allowed'; trailing_has_user = $false }
      }
      @{ args = @('-Action', 'send_email_self'); entries = @($SiblingTurn)
        expect = @{ consent_ok = $true; reason = 'gate-allowed'; trailing_has_user = $false }
      }
    )
  }
  'I-floor-outcome-phrasing'         = @{
    why     = 'a floor rule naming the OUTCOME binds, instead of matching nothing and being inert'
    gate    = (New-Gate -Allow @($RULE_YOLO_THIS_REPO) -Ask @($FLOOR_DATA_LOSS))
    entries = @()
    queries = @(
      # THE FIX, in its live shape: a blanket YOLO grant for this repo, and a floor rule phrased
      # as the outcome the user fears. Before this, the floor matched nothing -- "data loss" has
      # no verb `delete_data` knew -- so the grant won and the answer was `gate-allowed`. The one
      # rule standing between the agent and permanent data loss was inert, and nothing said so.
      @{ args = @('-Action', 'delete_data', '-Repo', 'focus-planner')
        expect = @{ consent_ok = $false; reason = 'gate-floor-blocks'; gate_rule = $FLOOR_DATA_LOSS }
      }
      # Control: the grant is still a grant. Without this the arm would pass just as well if the
      # floor had swallowed the whole gate, which is the over-correction to guard against.
      @{ args = @('-Action', 'merge_pr', '-Repo', 'focus-planner')
        expect = @{ consent_ok = $true; reason = 'gate-allowed' }
      }
    )
  }
  'J-outcome-confined-to-floor'      = @{
    why     = 'outcome phrasing NEVER widens an allow rule -- the one direction of error to refuse'
    # The same outcome words as arm I, moved to the ALLOW list. Applied to both lists, this
    # sentence becomes a licence to delete data. The floor here is deliberately unrelated to the
    # queried kind, so nothing but the allow rule can produce a `true` -- which is also what keeps
    # this arm blind to M1 and M2: with no floor verdict in play for `delete_data`, neither stage
    # ordering nor short-circuiting can change the answer.
    gate    = (New-Gate -Allow @($ALLOW_OUTCOME_SHAPED) -Ask @($FLOOR_MANY_LIVE))
    entries = @()
    queries = @(
      @{ args = @('-Action', 'delete_data', '-Repo', 'focus-planner'); expect = @{ consent_ok = $false } }
      # Non-vacuity, asserted on a field no other mutation moves: the gate really was read, so
      # the `false` above is a decision rather than a file that failed to load.
      @{ args = @('-Action', 'delete_data', '-Repo', 'focus-planner'); expect = @{ gate_state = 'ok' } }
    )
  }
  'L-live-gate-merge-finding'        = @{
    why        = 'THE finding: the live gate as written does not authorise merging a focus-planner PR'
    diagnostic = $true
    gate       = $LIVE_GATE
    entries    = @($HumanApprove)     # even WITH a human approve, the floor entries must hold
    queries    = @(
      # The headline. Rule 1 names another repo; rule 4 covers creating, not merging.
      @{ args = @('-Action', 'merge_pr', '-Repo', 'focus-planner'); expect = @{ consent_ok = $true; reason = 'human-authored-affirmative'; gate_rule = $null } }
      @{ args = @('-Action', 'open_pr', '-Repo', 'focus-planner'); expect = @{ consent_ok = $true; reason = 'gate-allowed'; gate_rule = $RULE_CREATE_PR } }
      @{ args = @('-Action', 'merge_pr', '-Repo', 'focus-planner-ado-codeapp'); expect = @{ consent_ok = $true; reason = 'gate-allowed'; gate_rule = $RULE_YOLO_REPO } }
      @{ args = @('-Action', 'send_email_self'); expect = @{ consent_ok = $true; reason = 'gate-allowed'; gate_rule = $RULE_EMAIL_SELF } }
      @{ args = @('-Action', 'send_email_reply'); expect = @{ consent_ok = $true; reason = 'gate-allowed'; gate_rule = $RULE_REPLY } }
      @{ args = @('-Action', 'send_email_many'); expect = @{ consent_ok = $false; reason = 'gate-floor-blocks'; gate_rule = $FLOOR_MANY } }
      @{ args = @('-Action', 'send_email_new_thread'); expect = @{ consent_ok = $false; reason = 'gate-floor-blocks'; gate_rule = $FLOOR_FRESH } }
    )
  }
  'M-live-gate-now'                  = @{
    why        = 'THE finding, restated against the gate Shiv actually rewrote on 2026-09-01'
    diagnostic = $true
    gate       = $LIVE_GATE_NOW
    entries    = @()                  # no human approve: every verdict below is the gate's alone
    queries    = @(
      # The inversion. #297 closed with "if he wants this repo auto-mergeable that is a question
      # to put to him, not a default to assume." He answered it by naming THIS repo -- so the same
      # query that read `no rule -> ask` against the previous text is now a grant, and it is the
      # GATE saying so against an empty journal, not the agent reading its own prose.
      @{ args = @('-Action', 'merge_pr', '-Repo', 'focus-planner'); expect = @{ consent_ok = $true; reason = 'gate-allowed'; gate_rule = $RULE_YOLO_THIS_REPO } }
      # Still scoped: a blanket grant naming one repo is not a blanket grant for every repo.
      @{ args = @('-Action', 'merge_pr', '-Repo', 'some-other-repo'); expect = @{ consent_ok = $false } }
      @{ args = @('-Action', 'open_pr', '-Repo', 'focus-planner'); expect = @{ consent_ok = $true; reason = 'gate-allowed' } }
      @{ args = @('-Action', 'send_email_self'); expect = @{ consent_ok = $true; reason = 'gate-allowed'; gate_rule = $RULE_EMAIL_SELF } }
      # Both floor rules bind, and the second is the one this PR had to fix: phrased as an
      # OUTCOME, it lost to the YOLO grant above it until outcome vocabulary was added.
      @{ args = @('-Action', 'send_email_many'); expect = @{ consent_ok = $false; reason = 'gate-floor-blocks'; gate_rule = $FLOOR_MANY_LIVE } }
      @{ args = @('-Action', 'delete_data', '-Repo', 'focus-planner'); expect = @{ consent_ok = $false; reason = 'gate-floor-blocks'; gate_rule = $FLOOR_DATA_LOSS } }
    )
  }
}

# NOTE on the first `L` case. With no gate rule covering `merge_pr` in `focus-planner`, control
# falls through to the journal reader -- and this journal DOES carry a human approve, so the
# answer is `true` for the pre-existing #227 reason, with `gate_rule: null`. That is the correct
# and complete statement of the finding: the gate grants nothing here; any yes comes from the
# per-task journal, exactly as it did before #297.

function Invoke-Child {
  # Runs the real script as a child process and returns (stdout+stderr, exit code).
  #
  # $ErrorActionPreference is dropped to Continue around the call ON PURPOSE. With `2>&1` under
  # `Stop`, a native command's stderr arrives as an ErrorRecord and TERMINATES the caller -- so
  # arm F, whose whole job is to make the script refuse a bad -Action, would blow up the harness
  # instead of recording the refusal it was looking for.
  param([string[]]$ChildArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $raw = (& powershell @ChildArgs 2>&1 | ForEach-Object { "$_" }) -join "`n"
    $code = $LASTEXITCODE
  }
  finally { $ErrorActionPreference = $prev }
  return [pscustomobject]@{ Raw = $raw; Exit = $code }
}

function Invoke-Arm {
  param([string]$Script, [string]$Name, $Arm, [string]$GateOverride, [bool]$HasGateOverride)
  $root = Join-Path $env:TEMP ("oa-gate-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $jdir = Join-Path $root 'journal'
  $sdir = Join-Path $root 'state'
  $gpath = Join-Path $root 'agent-gate.md'
  New-Item -ItemType Directory -Path $jdir -Force | Out-Null
  New-Item -ItemType Directory -Path $sdir -Force | Out-Null
  try {
    New-Journal -Dir $jdir -Id '970' -Entries @($Arm.entries)
    $gateText = if ($HasGateOverride) { $GateOverride } else { $Arm.gate }
    if ($null -ne $gateText) {
      [System.IO.File]::WriteAllText($gpath, $gateText, [System.Text.UTF8Encoding]::new($false))
    }
    $base = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script, 'consent', '-Id', '970',
      '-JournalDir', $jdir, '-StateDir', $sdir, '-GatePath', $gpath)
    $results = @()
    foreach ($q in @($Arm.queries)) {
      if ($null -eq $q) { continue }
      # A query may carry its OWN journal, so one arm can assert both halves of a discrimination
      # (arm H needs "gate-allowed WITH a human message" and "gate-allowed WITHOUT one" to differ
      # in exactly one field). ContainsKey, not truthiness: `entries = @()` is a meaningful world.
      $entries = if ($q.ContainsKey('entries')) { $q.entries } else { $Arm.entries }
      New-Journal -Dir $jdir -Id '970' -Entries @($entries)
      $child = Invoke-Child -ChildArgs ($base + @($q.args))
      $obj = $null
      try { $obj = $child.Raw | ConvertFrom-Json } catch { }
      $results += [pscustomobject]@{ Query = $q; Raw = $child.Raw; Obj = $obj; Exit = $child.Exit }
    }
    $refusals = @()
    foreach ($bad in @($Arm.mustFail)) {
      # `@($null)` is a ONE-element array holding $null, not an empty one. Without this guard an
      # arm with no mustFail list still fired a bare probe, and a bare probe exits 0 -- so every
      # arm reported a phantom "expected refusal, got exit 0". Same shape as the extraGates guard
      # below, and as the `, $out` bug this check found in oa-state.ps1 itself.
      if ($null -eq $bad) { continue }
      $child = Invoke-Child -ChildArgs ($base + @($bad))
      $refusals += [pscustomobject]@{ Args = $bad; Raw = $child.Raw; Exit = $child.Exit }
    }
    return [pscustomobject]@{ Results = $results; Refusals = $refusals }
  }
  finally { Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue }
}

function Test-Arm {
  param([string]$Script, [string]$Name, $Arm, [switch]$Quiet)
  $fail = 0
  $notes = @()

  # main world + any extra gate worlds asserting the same expectations
  $worlds = @([pscustomobject]@{ Override = $null; Has = $false; Label = ''; State = $null })
  foreach ($g in @($Arm.extraGates)) {
    if ($null -eq $g) { continue }
    $worlds += [pscustomobject]@{ Override = $g.text; Has = $true; Label = " [$($g.state)]"; State = $g.state }
  }

  foreach ($w in $worlds) {
    $run = Invoke-Arm -Script $Script -Name $Name -Arm $Arm -GateOverride $w.Override -HasGateOverride $w.Has
    foreach ($r in $run.Results) {
      $label = ($r.Query.args -join ' ')
      if ($null -eq $r.Obj) { $fail++; $notes += "  x$($w.Label) [$label] no JSON: $($r.Raw)"; continue }
      foreach ($k in $r.Query.expect.Keys) {
        $want = $r.Query.expect[$k]
        # `gate_state` in an extra-gate world is that world's state, not the arm's.
        if ($k -eq 'gate_state' -and $w.Has) { $want = $w.State }
        $got = $r.Obj.$k
        $ok = if ($null -eq $want) { $null -eq $got -or "$got" -eq '' } else { "$got" -eq "$want" }
        if (-not $ok) { $fail++; $notes += "  x$($w.Label) [$label] $k : want '$want' got '$got'" }
      }
    }
    foreach ($r in $run.Refusals) {
      # A closed enum must REFUSE, and refusal means a non-zero exit -- not a clean run that
      # quietly ignored the argument, which is how a "validated" input stops validating anything.
      if ($r.Exit -eq 0) { $fail++; $notes += "  x$($w.Label) [$($r.Args -join ' ')] expected refusal, got exit 0" }
    }
    if ($Arm.fields) {
      # Field-for-field shape check: the pre-#297 output had exactly these keys, in this order.
      $r = @($run.Results)[0]
      if ($null -eq $r.Obj) { $fail++; $notes += '  x fields: no JSON' }
      else {
        $got = @($r.Obj.PSObject.Properties.Name)
        if (($got -join ',') -ne (@($Arm.fields) -join ',')) {
          $fail++; $notes += "  x fields: want '$(@($Arm.fields) -join ',')' got '$($got -join ',')'"
        }
      }
    }
  }
  if (-not $Quiet) {
    Write-Host ("{0,-34} {1,-6} {2}" -f $Name, $(if ($fail -eq 0) { 'PASS' } else { 'FAIL' }), $Arm.why)
    foreach ($n in $notes) { Write-Host $n }
  }
  return $fail
}

function Test-AllArms {
  param([string]$Script, [string]$Label, [switch]$Quiet)
  if (-not $Quiet) { Write-Host ""; Write-Host "=== $Label ===" }
  $failedArms = @()
  foreach ($name in $arms.Keys) {
    $f = 0
    try { $f = Test-Arm -Script $Script -Name $name -Arm $arms[$name] -Quiet:$Quiet }
    catch { $f = 1; if (-not $Quiet) { Write-Host "$name threw: $($_.Exception.Message)" } }
    if ($f -gt 0) { $failedArms += $name }
  }
  if (-not $Quiet) { Write-Host ("arms failed: {0} / {1}" -f $failedArms.Count, $arms.Count) }
  return , $failedArms
}

# --- baseline ------------------------------------------------------------------------------
$baselineFailures = Test-AllArms -Script $ScriptPath -Label 'BASELINE (real oa-state.ps1)'
if ($baselineFailures.Count -gt 0) { Write-Host ""; Write-Host "BASELINE FAILED"; exit 1 }

# --- advisory: what does the gate on THIS machine actually authorise? ------------------------
# Never fatal. The user owns this file and may change it whenever he likes; a check that went
# red on his edit would be crying wolf. This just states the current answer out loud.
$livePath = "$env:USERPROFILE\OneDrive\Apps\Focus Planner\agent-gate.md"
if (Test-Path $livePath) {
  Write-Host ""
  Write-Host "=== ADVISORY: the gate file on this machine (never fatal) ==="
  $tmp = Join-Path $env:TEMP ("oa-gate-live-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    New-Journal -Dir $tmp -Id '970' -Entries @()
    foreach ($probe in @(
        @{ a = @('-Action', 'merge_pr', '-Repo', 'focus-planner'); t = 'merge a focus-planner PR' },
        @{ a = @('-Action', 'open_pr', '-Repo', 'focus-planner'); t = 'open a focus-planner PR' },
        @{ a = @('-Action', 'push_main', '-Repo', 'focus-planner'); t = 'push to focus-planner main' })) {
      $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ScriptPath, 'consent', '-Id', '970',
        '-JournalDir', $tmp, '-StateDir', $tmp, '-GatePath', $livePath) + @($probe.a)
      $o = $null
      try { $o = (Invoke-Child -ChildArgs ($a)).Raw | ConvertFrom-Json } catch { }
      Write-Host ("  {0,-30} gate says: {1,-18} {2}" -f $probe.t,
        $(if ($o.reason -eq 'gate-allowed') { 'ALLOWED' } elseif ($o.reason -eq 'gate-floor-blocks') { 'BLOCKED (floor)' } else { 'no rule -> ask' }),
        $(if ($o.gate_rule) { "via: $($o.gate_rule)" } else { '' }))
    }
  }
  finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

if ($BaselineOnly) { exit 0 }

# --- mutations -------------------------------------------------------------------------------
# One mutation per guarantee, each restoring a DIFFERENT version of the hole. `kills` names the
# single arm that must catch it; the matrix at the end fails if a mutation is caught by an arm
# that is not its own, because that would mean two arms are testing the same thing and one of
# them is not pulling its weight.
$src = [IO.File]::ReadAllText($ScriptPath, (New-Object Text.UTF8Encoding($false)))

$mutations = @(
  @{
    name  = 'M1: the ALLOW list is scanned before the floor (floor becomes a suggestion)'
    kills = 'A-floor-overrides-allow'
    # Arm I asserts a floor block, which cannot happen unless the floor is scanned first.
    alsoCaughtBy = @('I-floor-outcome-phrasing')
    apply = {
      param($s)
      $s -replace [regex]::Escape('foreach ($stage in $stages) {'), 'foreach ($stage in ($stages[1], $stages[0])) {'
    }
  },
  @{
    name  = 'M2: a floor verdict no longer short-circuits, so a journal `approve` overrides it'
    kills = 'B-floor-overrides-human-approval'
    # Same entailment: a floor block that does not short-circuit is not a floor block.
    alsoCaughtBy = @('I-floor-outcome-phrasing')
    apply = {
      param($s)
      $s -replace [regex]::Escape("if (`$verdict.decision -ne 'none') {"), "if (`$verdict.decision -eq 'allow') {"
    }
  },
  @{
    name  = 'M3: repo matching by SUBSTRING, so a prefix repo collects another repo''s grant'
    kills = 'C-repo-scope'
    apply = {
      param($s)
      $s -replace [regex]::Escape('if ($t -eq $want -or $t -eq $wantBare) { $hit = $true; break }'), 'if ($t.Contains($want) -or $t.Contains($wantBare)) { $hit = $true; break }'
    }
  },
  @{
    name  = 'M4: merge_pr accepts CREATE verbs, so "creating a PR is fine" authorises merging'
    kills = 'D-create-is-not-merge'
    apply = {
      param($s)
      $s -replace [regex]::Escape("merge_pr              = @('\bmerg(?:e|es|ed|ing)\b|\bauto-?merges?\b|\bland(?:s|ed|ing)? (?:the |a |it )?(?:pr|pull request)\b')"), "merge_pr              = @('\bmerg(?:e|es|ed|ing)\b|\bcreat(?:e|es|ed|ing)\b|\bpublish(?:es|ed|ing)?\b')"
    }
  },
  @{
    name  = 'M5: an ABSENT gate file yields a permissive default instead of no rules'
    kills = 'E-absent-file-fail-closed'
    apply = {
      param($s)
      $s -replace [regex]::Escape('if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return [pscustomobject]$result
  }'), 'if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
    $result.allow = @(''yolo mode, dont ask just do'')
    return [pscustomobject]$result
  }'
    }
  },
  @{
    name  = 'M6: -Action is free text again (ValidateSet dropped)'
    kills = 'F-enum-validation'
    apply = {
      param($s)
      $s -replace [regex]::Escape("  [ValidateSet(
    'merge_pr', 'open_pr', 'push_main', 'delete_branch',
    'send_email_self', 'send_email_reply', 'send_email_new_thread', 'send_email_many',
    'post_public', 'spend_money', 'delete_data', 'deploy', 'publish_release')]
  [string]`$Action,"), "  [string]`$Action,"
    }
  },
  @{
    name  = 'M10: outcome-shaped floor vocabulary dropped (a floor naming the OUTCOME goes inert)'
    kills = 'I-floor-outcome-phrasing'
    apply = {
      param($s)
      # Restores the pre-fix behaviour exactly: the floor is matched by the verb+object table
      # alone, so "Outcome can result in permanent data loss" matches nothing and the blanket
      # YOLO grant below it wins.
      $s -replace [regex]::Escape('  if ($allowOutcomePhrasing) {'), '  if ($false) {'
    }
  },
  @{
    name  = 'M11: outcome vocabulary applied to the ALLOW list too (it starts GRANTING)'
    kills = 'J-outcome-confined-to-floor'
    apply = {
      param($s)
      # The dangerous direction: an allow rule that merely mentions a permanent loss becomes a
      # licence to cause one.
      $s -replace [regex]::Escape("Scoped = `$true; Outcome = `$false }"), "Scoped = `$true; Outcome = `$true }"
    }
  },
  @{
    name  = 'M7: the gate is consulted even when -Action is omitted (output shape changes)'
    kills = 'G-action-omitted-unchanged'
    apply = {
      param($s)
      $out = $s -replace [regex]::Escape('if ($Action) {
    $gate = Read-AgentGate $GatePath'), 'if ($true) {
    $gate = Read-AgentGate $GatePath'
      $out -replace [regex]::Escape('if ($Action) { Add-GateFallthrough $out $gate }'), 'Add-GateFallthrough $out $gate'
    }
  },
  # M8 and M9 are the two halves of the same guarantee and BOTH name arm H, which is allowed:
  # the aim check requires each mutation to be caught by exactly one arm, not each arm to have
  # exactly one mutation. A field that is always false is missing; a field that is always true is
  # noise. Only an arm asserting both directions kills both.
  @{
    name  = 'M8: the gate path reports trailing_has_user as always FALSE (the field goes missing)'
    kills = 'H-gate-allowed-surfaces-human'
    apply = {
      param($s)
      $s -replace [regex]::Escape('if (Test-Path $path) { $trailingHasUser = [bool](Get-JournalFacts $path).HasTrailingUser }'), '# mutated: never look'
    }
  },
  @{
    name  = 'M9: the gate path reports trailing_has_user as always TRUE (the field says nothing)'
    kills = 'H-gate-allowed-surfaces-human'
    apply = {
      param($s)
      $s -replace [regex]::Escape('if (Test-Path $path) { $trailingHasUser = [bool](Get-JournalFacts $path).HasTrailingUser }'), '$trailingHasUser = $true'
    }
  }
)

$mutDir = Join-Path $env:TEMP ("oa-gate-mut-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $mutDir -Force | Out-Null
$killed = 0; $survived = 0; $misaimed = 0
try {
  foreach ($m in $mutations) {
    Write-Host ""
    Write-Host "--- $($m.name)"
    $mutated = & $m.apply $src
    if ($mutated -eq $src) {
      Write-Host "  !! mutation did not apply (anchor text moved) -- treating as SURVIVED"
      $survived++
      continue
    }
    $path = Join-Path $mutDir ("oa-state-" + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.ps1')
    [IO.File]::WriteAllText($path, $mutated, (New-Object Text.UTF8Encoding($false)))

    $failedArms = @()
    try { $failedArms = Test-AllArms -Script $path -Label $m.name -Quiet }
    catch { $failedArms = @('<threw>'); Write-Host "  (mutant threw: $($_.Exception.Message))" }

    # Only the guarantee arms take part in the aim check; `L`/`M` are corpus arms and are
    # expected to be caught by several mutations (see the header).
    $guaranteeArms = @($failedArms | Where-Object { -not $arms[$_].diagnostic })
    Write-Host ("  arms that caught it: {0}" -f $(if ($failedArms.Count) { $failedArms -join ', ' } else { '(none)' }))

    # STRUCTURAL DEPENDENCIES, DECLARED. `alsoCaughtBy` names arms whose sensitivity to this
    # mutation is a property of the design rather than a duplicated test, and it is subtracted
    # before the owner check so "exactly one owner" still means exactly one owner.
    #
    # It exists for one honest reason. Arm I asserts that a floor rule phrased as an OUTCOME
    # blocks -- and "the floor blocked this" entails "the floor was scanned first" (M1) and "a
    # floor verdict short-circuits" (M2). Those are not separable by any fixture: with the floor
    # neutered, M2 and M10 produce a byte-identical verdict, because both end at the journal with
    # `gate_rule` nulled. Declaring the entailment is truthful; silently widening `kills` into a
    # set would hide which arm actually owns the guarantee, and marking arm I diagnostic would
    # leave M10 with no owner at all.
    $expected = @($m.kills)
    $allowedExtra = @(@($m.alsoCaughtBy) | Where-Object { $_ })
    $owners = @($guaranteeArms | Where-Object { $allowedExtra -notcontains $_ })

    if ($failedArms.Count -eq 0) {
      $survived++
      Write-Host "  -> SURVIVED (guard is not load-bearing)"
      continue
    }
    $killed++
    if (@($owners).Count -eq 1 -and $owners[0] -eq $m.kills) {
      $note = if (@($allowedExtra).Count) { " (declared structural: $($allowedExtra -join ', '))" } else { '' }
      Write-Host "  -> KILLED by its own arm, and only its own arm$note"
    }
    else {
      $misaimed++
      Write-Host "  -> KILLED, but MISAIMED: expected exactly '$($m.kills)', got '$($owners -join ', ')'"
    }
  }
}
finally { Remove-Item -Recurse -Force $mutDir -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "mutations killed $killed / $($killed + $survived); misaimed $misaimed"
if ($survived -gt 0 -or $misaimed -gt 0) { exit 1 }
exit 0
