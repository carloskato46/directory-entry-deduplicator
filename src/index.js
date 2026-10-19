/**
 * Public entry point for the directory-entry-deduplicator library.
 *
 * Re-exports the core types and functions so consumers depend on a
 * single stable surface.
 */
export { MergeConflict, canonicallyEqual, groupByCanonicalName, mergeGroup, planDeduplication } from './core.js';
