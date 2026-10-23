// Avoid rewriting notices already present, including previously published versions.
export function pendingDeprecations(metadata, notice) {
  if (!metadata.versions || typeof metadata.versions !== 'object') throw new Error('Registry response has no versions');
  return Object.entries(metadata.versions)
    .filter(([, manifest]) => manifest.deprecated !== notice)
    .map(([version]) => version);
}
