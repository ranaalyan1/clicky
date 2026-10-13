import { SearchTarget, searchTargets } from "../shared/contracts";

export interface SearchTargetDefinition {
  id: SearchTarget;
  label: string;
  urlTemplate: string;
}

/**
 * `default` maps to Google because Windows gives no supported way to read the
 * default browser's search engine. Everything else searches the site the user
 * named, which is what "search YouTube for ..." means.
 */
export const searchTargetDefinitions: SearchTargetDefinition[] = [
  { id: "default", label: "the web", urlTemplate: "https://www.google.com/search?q={query}" },
  { id: "google", label: "Google", urlTemplate: "https://www.google.com/search?q={query}" },
  { id: "youtube", label: "YouTube", urlTemplate: "https://www.youtube.com/results?search_query={query}" },
  { id: "amazon", label: "Amazon", urlTemplate: "https://www.amazon.in/s?k={query}" },
  { id: "bing", label: "Bing", urlTemplate: "https://www.bing.com/search?q={query}" },
  { id: "wikipedia", label: "Wikipedia", urlTemplate: "https://en.wikipedia.org/w/index.php?search={query}" },
];

export function isKnownSearchTarget(candidateTarget: string): candidateTarget is SearchTarget {
  return (searchTargets as readonly string[]).includes(candidateTarget);
}

export function buildSearchUrl(target: SearchTarget, query: string): string {
  const searchTargetDefinition = searchTargetDefinitions.find(
    (searchTarget) => searchTarget.id === target,
  ) ?? searchTargetDefinitions[0]!;
  return searchTargetDefinition.urlTemplate.replace("{query}", encodeURIComponent(query.trim()));
}
