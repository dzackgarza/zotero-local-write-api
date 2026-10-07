/**
 * The connection settings of the live suites. Each suite's `just` recipe names
 * them, with the local Zotero as the default, so a suite run outside its recipe
 * fails instead of guessing a target.
 */
export function liveSetting(name: "ZOTERO_LOCAL_BASE_URL" | "ZOTERO_LIBRARY_ID"): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is not set; run the suite through its \`just\` recipe`);
  }
  return value;
}
