<#
  The former direct wiki writer bypassed review and could overwrite approved pages.
  Keep the familiar command as an explicit failure rather than an alternate writer.
#>
[CmdletBinding()]
param()

throw 'Direct wiki publishing is disabled. Configure the review credentials described in docs/wiki-maintenance.md, then run node scripts/spec/reviewCli.mjs publish to publish only the exact approved revision.'
