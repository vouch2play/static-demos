export default async function handler(req, res) {
  const { path, ...queryParams } = req.query;
  const inboundPath = Array.isArray(path) ? path.join('/') : (path || '');

  // All requests through /api/fas/* route to apps.fas.usda.gov/opendatawebV2/api/*
  const upstreamUrl = new URL(`https://apps.fas.usda.gov/OpenData/api/${inboundPath}`);
  
  // Add query parameters from client
  Object.entries(queryParams).forEach(([k, v]) => {
    upstreamUrl.searchParams.set(k, v);
  });

  // Inject API key if available
  const apiKey = process.env.FAS_API_KEY?.trim();
  console.log(`[FAS API] key loaded: ${apiKey ? 'YES (' + apiKey.slice(0, 4) + '...)' : 'NO - check .env.local'}`);
  if (apiKey) {
    upstreamUrl.searchParams.set('apiKey', apiKey);
  }

  console.log(`[FAS API] ${req.method} ${upstreamUrl.toString()}`);

  try {
    const usdaRes = await fetch(upstreamUrl.toString(), {
      method: req.method,
      headers: {
        Accept: req.headers.accept || 'application/json'
      }
    });

    const body = await usdaRes.text();
    const contentType = usdaRes.headers.get('content-type') || 'application/json';
    
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(usdaRes.status).send(body);
  } catch (err) {
    res.status(502).json({
      error: 'Failed to reach USDA FAS API',
      detail: err instanceof Error ? err.message : String(err)
    });
  }
}
