/** True for a POST whose URL path ends in `suffix`, on any host. A malformed URL is false. */
export function isPostToPathSuffix(request: Request, suffix: string): boolean {
  if (request.method !== 'POST') return false;
  try {
    return new URL(request.url).pathname.endsWith(suffix);
  } catch {
    return false;
  }
}
