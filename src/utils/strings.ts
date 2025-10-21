function normalizePalindromes(str: string): boolean {
  const normalized = str.toLowerCase().replace(/[^a-z0-9]/g, ""); // remove punctuation, whitespace, symbols

  return normalized === normalized.split("").reverse().join("");
}
export { normalizePalindromes };
