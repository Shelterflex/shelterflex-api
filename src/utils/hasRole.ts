/** True when the account is registered for any of the given roles. */
export function hasRole(
  user: { role: string; roles?: string[] } | undefined,
  ...roles: string[]
): boolean {
  if (!user) return false
  return roles.some((role) => role === user.role || !!user.roles?.includes(role))
}
