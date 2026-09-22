/**
 * Shared row-count wording.
 *
 * Three surfaces used to phrase this differently ("4 rows", "4 rows" with a
 * thousands separator, "Result 1 (1 rows)"), so the pluralisation drifted; one
 * helper keeps them identical and localised.
 */
export function formatRowCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'row' : 'rows'}`
}
