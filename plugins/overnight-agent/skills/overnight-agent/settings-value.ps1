function ConvertFrom-SettingCell {
  param([AllowEmptyString()][string]$Cell)
  $match = [regex]::Match([string]$Cell, '`([^`]*)`')
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ([string]$Cell).Trim()
}
