/**
 * The tags to attach to an imported bookmark: trimmed, with blanks and repeats
 * dropped.
 *
 * Import files carry tags exactly as the source wrote them, and a stray blank
 * ("a,,b", a trailing comma, a whitespace-only tag) used to make the whole
 * tag update fail validation ("You must provide either a tagId or a tagName"),
 * which marked the bookmark's import as failed even though the bookmark itself
 * had been created.
 */
export function cleanImportTags(
  tags: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw?.trim();
    if (!tag || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    cleaned.push(tag);
  }
  return cleaned;
}
