export function sameCommitSha(left: string, right: string): boolean {
  if (left === right) return true;
  if (!isHexCommitPrefix(left) || !isHexCommitPrefix(right)) return false;
  return left.startsWith(right) || right.startsWith(left);
}

function isHexCommitPrefix(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value);
}
