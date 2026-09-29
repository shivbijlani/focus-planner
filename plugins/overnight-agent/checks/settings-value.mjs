export function settingsValue(cell) {
  const raw = String(cell ?? '');
  const fenced = raw.match(/`([^`]+)`/);
  return (fenced ? fenced[1] : raw).trim();
}

export function readSettingRow(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = String(text ?? '').match(
    new RegExp(`^\\s*\\|\\s*${escaped}\\s*\\|\\s*([^|\\r\\n]*)\\|`, 'im'),
  );
  return found ? settingsValue(found[1]) : '';
}
