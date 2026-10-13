export async function installOfflineBoundary(page) {
  // Later test fixtures override this fallback for API responses. No route.fetch().
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return route.abort();
    if (url.hostname === '127.0.0.1' && ['5173', '5177', '4178'].includes(url.port)) return route.continue();
    return route.abort();
  });
}
