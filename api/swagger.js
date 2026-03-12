let cachedSpec = null;
let cacheTime = 0;
const CACHE_TTL = 3600000; // 1 hour in ms

export default async function handler(req, res) {
  const now = Date.now();

  // Return cached spec if still valid
  if (cachedSpec && now - cacheTime < CACHE_TTL) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.status(200).json(cachedSpec);
  }

  // Fetch fresh spec from USDA
  try {
    const response = await fetch(
      'https://apps.fas.usda.gov/opendatawebV2/assets/swagger/swagger.json',
      {
        headers: { Accept: 'application/json' }
      }
    );

    if (!response.ok) {
      throw new Error(`Upstream returned ${response.status} ${response.statusText}`);
    }

    const spec = await response.json();

    // Cache it
    cachedSpec = spec;
    cacheTime = now;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).json(spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({
      error: 'Failed to fetch Swagger spec',
      detail: message
    });
  }
}
