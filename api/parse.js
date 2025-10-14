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

  // ---- TOP-LEVEL DEBUG (runs even on GET, before any checks) ----
  const topDbg = (req.query && req.query.debug === "1") || req.headers["x-debug"] === "1";
  if (topDbg) {
    const ah = req.headers.authorization || "";
    const tok = ah.startsWith("Bearer ") ? ah.split(" ")[1] : "";
    return res.status(200).json({
      stage: "top",
      method: req.method,
      has_auth_header: Boolean(ah),
      token_len: tok.length,
      expected_len: (process.env.MICAHB_AUTH_TOKEN || "").length,
      token_matches: Boolean(process.env.MICAHB_AUTH_TOKEN) && tok === process.env.MICAHB_AUTH_TOKEN,
      content_type: req.headers["content-type"] || null
    });
  }

  // Only POST is allowed beyond this point
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // -------- Robust JSON body parsing --------
  let data = req.body;
  if (typeof data === "string") {
    try { data = JSON.parse(data); }
    catch { res.status(400).json({ error: "Malformed JSON body" }); return; }
  }
  if (!data || typeof data !== "object") {
    res.status(400).json({ error: "Missing JSON body" });
    return;
  }

  let { subject = "", body = "", html = "" } = data;

  // If plain body is empty, fall back to HTML (strip tags)
  if (!body && html) {
    body = String(html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .trim();
  }

  if (!String(body).trim()) {
    res.status(400).json({ error: "Missing 'body' in JSON payload" });
    return;
  }

  // -------- Inline auth debug (no OpenAI yet) --------
  const dbg = (req.query && req.query.debug === "1") || req.headers["x-debug"] === "1";
  if (dbg) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : "";
    return res.status(200).json({
      stage: "post-parse",
      subject,
      body_len: String(body).length,
      has_key: Boolean(process.env.MICAHB_OPENAI_API_KEY),
      has_auth_header: Boolean(authHeader),
      token_len: token.length,
      expected_len: (process.env.MICAHB_AUTH_TOKEN || "").length,
      token_matches: Boolean(process.env.MICAHB_AUTH_TOKEN) && token === process.env.MICAHB_AUTH_TOKEN
    });
  }

  // -------- Simple bearer auth (still no OpenAI) --------
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : "";
  if (!process.env.MICAHB_AUTH_TOKEN || token !== process.env.MICAHB_AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Echo success so we know plumbing works
  return res.status(200).json({ ok: true, subject, body_len: String(body).length });
}

