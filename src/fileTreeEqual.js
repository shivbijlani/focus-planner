export function sameFileTree(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const left = a[i]
    const right = b[i]
    if (
      left?.name !== right?.name
      || left?.type !== right?.type
      || left?.path !== right?.path
      || !sameFileTree(left?.children ?? [], right?.children ?? [])
    ) return false
  }
  return true
}
