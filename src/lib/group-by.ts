/** 鍵ごとにまとめる（鍵は最初に出た順、中身は元の順） */
export function groupBy<T, K>(items: readonly T[], keyOf: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>()
  for (const t of items) {
    const k = keyOf(t)
    const list = m.get(k)
    if (list) list.push(t)
    else m.set(k, [t])
  }
  return m
}
