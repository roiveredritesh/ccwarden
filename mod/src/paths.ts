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

/** `path` with `/` separators: on Windows the engine and the model's tool calls mix both. */
export function slashed(path: string): string {
  return path.replace(/\\/g, '/')
}

/** `path` under `cwd` as git prints it (`/`-separated, relative), else `path` slashed. */
export function relativeTo(path: string, cwd: string | undefined): string {
  const p = slashed(path)
  if (cwd === undefined || cwd === '') return p
  const root = `${slashed(cwd).replace(/\/+$/, '')}/`
  // ponytail: case-blind so `d:` matches `D:`; a case-only clash on Linux would wrongly match
  return p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length) : p
}
