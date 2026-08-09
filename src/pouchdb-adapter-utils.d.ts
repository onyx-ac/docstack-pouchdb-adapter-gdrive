/**
 * `pouchdb-adapter-utils` ships no TypeScript declarations and there's no
 * `@types` package for it - minimal ambient declaration covering only what this
 * adapter actually uses.
 */
declare module 'pouchdb-adapter-utils' {
  export interface ParsedDoc {
    metadata: {
      id?: string;
      rev?: string;
      rev_tree: any;
      deleted?: boolean;
    };
    data: Record<string, unknown>;
  }

  /** Builds a tree-path + data split from a raw doc's `_id`/`_rev`/`_revisions` -
   *  returns an error-shaped object (no `.metadata`) on a malformed rev instead
   *  of throwing. */
  export function parseDoc(doc: Record<string, unknown>, newEdits: boolean, dbOpts?: { deterministic_revs?: boolean }): ParsedDoc | { error: unknown; [key: string]: unknown };
}
