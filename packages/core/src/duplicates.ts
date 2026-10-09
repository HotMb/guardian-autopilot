import type {RepositoryManifest} from './manifest.js';

export type ExactDuplicateGroup = {
  sha256: string;
  bytes: number;
  canonical: string;
  duplicates: string[];
};

export function findExactDuplicates(manifest: RepositoryManifest): ExactDuplicateGroup[] {
  const byHash = new Map<string, Array<{path: string; bytes: number}>>();
  for (const file of manifest.files) {
    const group = byHash.get(file.sha256) ?? [];
    group.push({path: file.path, bytes: file.bytes});
    byHash.set(file.sha256, group);
  }

  return [...byHash.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([sha256, files]) => {
      const sorted = [...files].sort((left, right) => left.path.localeCompare(right.path));
      return {
        sha256,
        bytes: sorted[0].bytes,
        canonical: sorted[0].path,
        duplicates: sorted.slice(1).map((file) => file.path),
      };
    })
    .sort((left, right) => left.canonical.localeCompare(right.canonical));
}
