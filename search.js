/** Validate model-supplied search JSON against deployment bounds. */
export function validateSearch(args, config) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Expected search arguments object');
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query || query.length > config.maxQueryChars) throw new Error('query must contain 1..' + config.maxQueryChars + ' characters');
  return { query };
}

/**
 * Rank exact names and lexical matches with word boundaries.
 * Exact full name = 1000; exact single token = 100; token inside the name = 40;
 * loose name substring = 10; token inside the description = 1.
 * Description hits require word boundaries, so "revision" no longer matches "vision".
 */
export function rankTools(catalog, query, limit) {
  const normalized = query.toLowerCase();
  const words = [...new Set(normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean))];
  const escaping = /[.*+?^${}()|[\]\\]/g;
  const boundary = (haystack, word) => {
    const escaped = word.replace(escaping, '\\$&');
    return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '($|[^\\p{L}\\p{N}])', 'u').test(haystack);
  };
  return catalog.map(tool => {
    const name = tool.name.toLowerCase();
    const description = (tool.description || '').toLowerCase();
    let score = 0;
    if (name === normalized) score += 1000;
    for (const word of words) {
      if (name === word) score += 100;
      else if (boundary(name, word)) score += 40;
      else if (name.includes(word)) score += 10;
      if (boundary(description, word)) score += 1;
    }
    return { tool, score };
  }).filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
    .slice(0, limit).map(hit => hit.tool);
}
