/**
 * Which commit a release tag on origin points at, so launch.ts can tell a release to resume from one made elsewhere.
 */

/** The `git ls-remote` argv for `tag`: an annotated tag lists its own object and, as <tag>^{}, the commit it points at. */
export function lsRemoteTag(tag: string): string[] {
  return ["git", "ls-remote", "--tags", "origin", tag, `${tag}^{}`];
}

/** The commit in `lsRemoteTag`'s output, or "" when the tag isn't on origin yet. */
export function taggedCommit(out: string): string {
  const refs = out.split("\n").filter(Boolean);
  return (refs.find((l) => l.endsWith("^{}")) ?? refs[0] ?? "").split(/\s+/)[0] ?? "";
}
