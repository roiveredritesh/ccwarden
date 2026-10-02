// Paths the mod builds from the engine's own (`$.session.root()`): a Windows
// root is `D:\proj`, so a `/` join gives a mixed path like `D:\proj/.claude`.

/** The separator `base` already uses: a backslash for a Windows path, else `/`. */
export function sepOf(base: string): '\\' | '/' {
  return base.includes('\\') && !base.includes('/') ? '\\' : '/'
}

/** `base` + `rel` with `base`'s own separator; `joinPath(dir, '')` is the prefix of `dir`'s children. */
export function joinPath(base: string, rel: string): string {
  const sep = sepOf(base)
  const head = base.replace(/[\\/]+$/, '')
  return `${head}${sep}${sep === '\\' ? rel.replace(/\//g, '\\') : rel}`
}
