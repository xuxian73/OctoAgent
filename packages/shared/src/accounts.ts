// Shared browser/server rules. Password lengths use JavaScript UTF-16 units.
export const usernamePattern = "[a-zA-Z0-9_.\\-]{1,64}";
export const passwordMinLength = 12;
export const passwordMaxLength = 256;
export function validUsername(value: unknown): value is string {
  return (
    typeof value === "string" &&
    new RegExp(`^${usernamePattern}$`).exec(value)?.[0] === value
  );
}
export function validAccount(username: unknown, password: unknown): boolean {
  return (
    validUsername(username) &&
    typeof password === "string" &&
    password.length >= passwordMinLength &&
    password.length <= passwordMaxLength
  );
}
