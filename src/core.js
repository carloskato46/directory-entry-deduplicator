/**
 * Core deduplication logic for directory entries that differ only in
 * Unicode normalization form.
 *
 * Background: HFS+ normalizes filenames to NFD (decomposed) on write.
 * APFS preserves the bytes you give it but an OS that previously used
 * HFS+ may carry the same logical file under two normalization forms,
 * or a directory may contain both a copied-from-HFS+ (NFD) entry and a
 * freshly-created NFC entry with the same logical name. The result is
 * two directory entries that the filesystem treats as distinct but that
 * a human or downstream program almost always considers duplicates.
 *
 * This module identifies such collisions and reports how to merge them.
 */

/**
 * Error thrown when a merge cannot be performed because the entries
 * disagree on a field that has no safe default resolution.
 */
export class MergeConflict extends Error {
  constructor(message) {
    super(message);
    this.name = 'MergeConflict';
  }
}

/**
 * Compare two strings for logical equality using Unicode NFC.
 *
 * We chose NFC (rather than NFD or NFKC) because NFC is the most common
 * storage form on the web and in modern filesystems, and comparing in a
 * single common form is sufficient: if two strings share an NFC form,
 * they share a canonical decomposition and are canonically equivalent.
 *
 * NFKC would additionally fold compatibility characters (e.g. the
 * fullwidth 'Ａ' to 'A'), which is NOT desired here — those are
 * distinct identifiers, not normalization variants.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function canonicallyEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  if (a === b) {
    return true;
  }
  return a.normalize('NFC') === b.normalize('NFC');
}

/**
 * Partition an array of directory entries into groups whose names are
 * canonically equivalent under NFC normalization.
 *
 * An entry is a plain object with at least a `name` string. Extra
 * fields are preserved but not inspected here.
 *
 * The algorithm is O(n²) over the number of names. We accept this
 * because directories needing deduplication are almost always small
 * (a few thousand entries at most) and we deliberately avoid building
 * a hash key derived from a normalized form, which would allocate a
 * new string per entry and obscure the source form in debugging.
 *
 * Group order is undefined; callers needing determinism should sort.
 *
 * @param {Array<{name: string}>} entries
 * @returns {Array<Array<{name: string}>>} groups of size >= 2
 */
export function groupByCanonicalName(entries) {
  if (!Array.isArray(entries)) {
    throw new TypeError('entries must be an array');
  }
  for (const e of entries) {
    if (typeof e !== 'object' || e === null || typeof e.name !== 'string') {
      throw new TypeError('each entry must be a non-null object with a string name');
    }
  }

  const groups = [];
  const assigned = new Array(entries.length).fill(false);

  for (let i = 0; i < entries.length; i++) {
    if (assigned[i]) {
      continue;
    }
    const group = [entries[i]];
    assigned[i] = true;
    for (let j = i + 1; j < entries.length; j++) {
      if (!assigned[j] && canonicallyEqual(entries[i].name, entries[j].name)) {
        group.push(entries[j]);
        assigned[j] = true;
      }
    }
    if (group.length >= 2) {
      groups.push(group);
    }
  }
  return groups;
}

/**
 * Build a merged directory-entry description from a group of entries
 * that share a canonical name.
 *
 * Resolution policy (stated plainly so callers know what they get):
 *
 * - `name`: always the NFC form. This is the safest target on APFS
 *   and matches modern expectations. The source entries' actual byte
 *   forms are returned in `sourceNames` for audit/logging.
 *
 * - `size`: if all entries agree on size, the merged size is that
 *   value. If any entry's size is missing (undefined or null), we
 *   treat that as "unknown" and prefer the size of the majority of
 *   known values; if there is no majority, the first known size wins.
 *   If no entries have a known size, `size` is undefined.
 *
 * - `mtime`: resolved by the injected `clock` so tests are
 *   deterministic. We compare normalized timestamps by calling
 *   `clock()` once and selecting the entry whose `mtime` is
 *   closest to that instant; on ties, the first entry wins. This
 *   mirrors a common heuristic: keep the entry that was "most
 *   recently relevant". If no entry has an mtime, `mtime` is undefined.
 *
 * - other fields: copied from the first entry that defines them, in
 *   the order entries were supplied. This is deterministic but blunt;
 *   callers needing richer policy should post-process.
 *
 * @param {Array<object>} group
 * @param {object} [opts]
 * @param {() => number} [opts.clock] Returns a millisecond timestamp.
 * @returns {{name: string, size?: number, mtime?: number, sourceNames: string[]}}
 * @throws {MergeConflict} if `group` is empty or not all names are canonically equivalent.
 */
export function mergeGroup(group, opts = {}) {
  if (!Array.isArray(group) || group.length === 0) {
    throw new MergeConflict('mergeGroup requires a non-empty group');
  }
  for (const e of group) {
    if (typeof e !== 'object' || e === null || typeof e.name !== 'string') {
      throw new MergeConflict('each entry must be a non-null object with a string name');
    }
  }
  const pivot = group[0].name.normalize('NFC');
  for (let i = 1; i < group.length; i++) {
    if (group[i].name.normalize('NFC') !== pivot) {
      throw new MergeConflict('group entries are not canonically equivalent');
    }
  }

  const clock = opts.clock;
  if (clock !== undefined && typeof clock !== 'function') {
    throw new TypeError('opts.clock must be a function returning a number');
  }

  const result = {
    name: pivot,
    sourceNames: group.map((e) => e.name),
  };

  // --- size resolution (majority of known values, first-wins on tie) ---
  const knownSizes = group.filter((e) => typeof e.size === 'number');
  if (knownSizes.length > 0) {
    const counts = new Map();
    for (const e of knownSizes) {
      counts.set(e.size, (counts.get(e.size) || 0) + 1);
    }
    let bestSize = knownSizes[0].size;
    let bestCount = 1;
    for (const [size, count] of counts) {
      if (count > bestCount) {
        bestSize = size;
        bestCount = count;
      }
    }
    result.size = bestSize;
  }

  // --- mtime resolution (closest to clock(), first-wins on tie) ---
  const knownMtimes = group.filter((e) => typeof e.mtime === 'number');
  if (knownMtimes.length > 0 && clock) {
    const now = clock();
    let best = knownMtimes[0];
    let bestAbs = Math.abs(best.mtime - now);
    for (let i = 1; i < knownMtimes.length; i++) {
      const candidate = knownMtimes[i];
      const candidateAbs = Math.abs(candidate.mtime - now);
      if (candidateAbs < bestAbs) {
        best = candidate;
        bestAbs = candidateAbs;
      }
    }
    result.mtime = best.mtime;
  } else if (knownMtimes.length > 0) {
    // No clock supplied: deterministic first-known-wins fallback.
    result.mtime = knownMtimes[0].mtime;
  }

  // --- other fields: first-defining entry wins, in order ---
  for (const entry of group) {
    for (const key of Object.keys(entry)) {
      if (key === 'name' || key === 'size' || key === 'mtime') {
        continue;
      }
      if (!(key in result)) {
        result[key] = entry[key];
      }
    }
  }

  return result;
}

/**
 * Convenience: find all duplicate groups in a directory listing and
 * return a merge plan. Does not mutate the input.
 *
 * @param {Array<object>} entries
 * @param {object} [opts] Forwarded to mergeGroup.
 * @returns {Array<object>} one merged entry per duplicate group.
 */
export function planDeduplication(entries, opts = {}) {
  const groups = groupByCanonicalName(entries);
  return groups.map((g) => mergeGroup(g, opts));
}
