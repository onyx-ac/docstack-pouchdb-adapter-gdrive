/**
 * `pouchdb-merge` ships no TypeScript declarations and there's no `@types`
 * package for it - minimal ambient declaration covering only what this adapter
 * actually uses. Mirrors the equivalent file in `@docstack/pouchdb-adapter-native`
 * (a sibling project solving the identical tree-merge problem).
 */
declare module 'pouchdb-merge' {
  /** `[revId, opts, children]` - CouchDB's key-tree node shape. */
  export type RevTreeNode = [string, Record<string, unknown>, RevTreeNode[]];

  export interface RevTreePath {
    pos: number;
    ids: RevTreeNode;
  }

  export type RevTree = RevTreePath[];

  export interface DocMetadata {
    id?: string;
    rev?: string;
    rev_tree: RevTree;
    deleted?: boolean;
  }

  export interface MergeResult {
    tree: RevTree;
    stemmedRevs: string[];
    conflicts: false | 'new_leaf' | 'new_branch' | 'internal_node';
  }

  export function merge(tree: RevTree, path: RevTreePath, depth: number): MergeResult;
  export function winningRev(metadata: DocMetadata): string;
  export function isDeleted(metadata: DocMetadata, rev?: string): boolean;
  export function revExists(tree: RevTree, rev: string): boolean;
  export function collectConflicts(metadata: DocMetadata): string[];
}
