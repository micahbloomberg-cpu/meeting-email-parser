// --- CORS helper ---
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

export default async function handler(req, res) {
  // CORS first
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
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

  // -------- Simple bearer auth --------
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : "";
  if (!process.env.MICAHB_AUTH_TOKEN || token !== process.env.MICAHB_AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // -------- Build prompt --------
  const system = [
    "You extract structured meeting details from raw email text.",
    "Return STRICT JSON ONLY. No preamble, no markdown, no comments.",
    "Infer missing values conservatively; if unknown, return empty string or empty array.",
    `All times should be interpreted in ${process.env.MICAHB_TZ || "America/Los_Angeles"} unless an explicit offset/zone is provided.`,
    "Only include people we are actually meeting WITH in attendees_primary.",
    "Agents/assistants (e.g., 'Office of', 'Assistant to', signature blocks) should go to scheduler_name/email, not attendees_primary.",
    "Prefer names under labels like 'WITH:' or 'Attendees:' for attendees_primary.",
    "If 'Zoom/Meet/Teams' links appear, set join_url accordingly.",
    "If an address appears (street/city/state/zip), set address accordingly.",
    "If both address and join_url exist, include both.",
    "Return valid ISO 8601 timestamps for start_iso/end_iso when possible (e.g., 2025-09-30T10:00:00-07:00)."
  ].join(" ");

  const schema = {
    title: "",
    date_text: "",
    time_text: "",
    start_iso: "",
    end_iso: "",
    location: "",
    address: "",
    join_url: "",
    organizer_name: "",
    organizer_email: "",
    scheduler_name: "",
    scheduler_email: "",
    attendees_primary: [],
    companies: [],
    source_subject: ""
  };

  const user = [
    "Extract the following fields from the email according to this JSON template:",
    JSON.stringify(schema, null, 2),
    "",
    "Email subject:",
    subject,
    "",
    "Email body:",
    body
  ].join("\n");

  // Lazy import and client init, with error surfacing
  let client;
  try {
    const { default: OpenAI } = await import("openai");
    client = new OpenAI({ apiKey: process.env.MICAHB_OPENAI_API_KEY });
    if (!process.env.MICAHB_OPENAI_API_KEY) {
      return res.status(502).json({
        error: "OpenAI init error",
        detail: "Missing MICAHB_OPENAI_API_KEY in environment"
      });
    }
  } catch (e) {
    return res.status(502).json({
      error: "OpenAI init error",
      detail: String(e?.message || e)
    });
  }

  try {
    const completion = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    const content = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      return res.status(502).json({
        error: "Parser error",
        detail: "Model returned non-JSON",
        content
      });
    }

    parsed.source_subject = subject;
    return res.status(200).json(parsed);
  } catch (err) {
    console.error("OpenAI error:", err?.status, err?.message, err?.response?.data);
    return res.status(502).json({
      error: "Parser error",
      detail: String(err?.response?.data || err?.message || err)
    });
  }
}
