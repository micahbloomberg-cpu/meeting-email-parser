// --- CORS helper ---
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-debug");
}

export default async function handler(req, res) {
  // CORS first
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // 🚦 minimal sanity response (no auth, no parsing, no OpenAI)
  return res.status(200).json({
    stage: "minimal-ok",
    method: req.method,
    url: req.url,
    has_auth_header: Boolean(req.headers?.authorization),
    content_type: req.headers?.["content-type"] || null
  });
}

