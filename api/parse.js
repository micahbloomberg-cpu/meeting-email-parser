// Runtime: Node.js on Vercel serverless
import OpenAI from "openai";

// --- CORS helper ---
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const TZ = process.env.MICAHB_TZ || "America/Los_Angeles"; // your default tz for outputs
const AUTH = process.env.MICAHB_AUTH_TOKEN;                // simple bearer auth
const SCHEDULER_DENYLIST = (process.env.MICAHB_SCHEDULER_DENYLIST || "@unitedtalent.com,@uta.com")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const client = new OpenAI({ apiKey: process.env.MICAHB_OPENAI_API_KEY });

export default async function handler(req, res) {
  // CORS first
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  // ---- TOP-LEVEL DEBUG (runs even on GET) ----
const topDbg = (req.query && req.query.debug === "1") || req.headers["x-debug"] === "1";
if (topDbg) {
  const ah = req.headers.authorization || "";
  const tok = ah.startsWith("Bearer ") ? ah.split(" ")[1] : "";
  return res.status(200).json({
    stage: "top",
    method: req.method,
    has_auth_header: Boolean(ah),
    token_len: tok.length,
    expected_len: (AUTH || "").length,
    token_matches: Boolean(AUTH) && tok === AUTH,
    content_type: req.headers["content-type"] || null
  });
}


  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    // -------- Robust JSON body parsing --------
    let data = req.body;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        res.status(400).json({ error: "Malformed JSON body" });
        return;
      }
    }
    if (!data || typeof data !== "object") {
      res.status(400).json({ error: "Missing JSON body" });
      return;
    }

    let { subject = "", body = "", html = "" } = data;

    // If plain body is empty, fall back to HTML (strip tags)
    if (!body && html) {
      body = html
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

// -------- Inline auth debug (temporary) --------
const dbg = (req.query && req.query.debug === "1") || req.headers["x-debug"] === "1";
if (dbg) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : "";
  return res.status(200).json({
    ok: true,
    subject,
    body_len: String(body || "").length,
    has_key: Boolean(process.env.MICAHB_OPENAI_API_KEY),
    model: MODEL,
    // auth diagnostics (no secrets leaked)
    has_auth_header: Boolean(authHeader),
    token_len: token.length,
    expected_len: (AUTH || "").length,
    token_matches: Boolean(AUTH) && token === AUTH
  });
}

    // -------- Simple bearer auth --------
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : "";
    if (!AUTH || token !== AUTH) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    -------- Optional inline debug (uncomment if needed) --------
    if (req.query && req.query.debug === "1") {
    return res.status(200).json({
    ok: true,
    subject,
    body_len: String(body || "").length,
    has_key: Boolean(process.env.MICAHB_OPENAI_API_KEY),
    model: MODEL,
    });
    }

    // -------- Build prompt --------
    const system = [
      "You extract structured meeting details from raw email text.",
      "Return STRICT JSON ONLY. No preamble, no markdown, no comments.",
      "Infer missing values conservatively; if unknown, return empty string or empty array.",
      `All times should be interpreted in ${TZ} unless an explicit offset/zone is provided.`,
      "Only include people we are actually meeting WITH in attendees_primary.",
      "Agents/assistants (e.g., 'Office of', 'Assistant to', signature blocks) should go to scheduler_name/email, not attendees_primary.",
      "Prefer names under labels like 'WITH:' or 'Attendees:' for attendees_primary.",
      "If 'Zoom/Meet/Teams' links appear, set join_url accordingly.",
      "If an address appears (street/city/state/zip), set address accordingly.",
      "If both address and join_url exist, include both.",
      "Return valid ISO 8601 timestamps for start_iso/end_iso when possible (e.g., 2025-09-30T10:00:00-07:00).",
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
      source_subject: "",
    };

    const user = [
      "Extract the following fields from the email according to this JSON template:",
      JSON.stringify(schema, null, 2),
      "",
      "Email subject:",
      subject,
      "",
      "Email body:",
      body,
    ].join("\n");

    // -------- OpenAI call with error surfacing --------
    try {
      const completion = await client.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      });

      const content = completion.choices?.[0]?.message?.content || "{}";
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        return res
          .status(502)
          .json({ error: "Parser error", detail: "Model returned non-JSON", content });
      }

      // -------- Post-processing / guardrails --------
      const lowerBody = String(body).toLowerCase();
      const denyKeywords = ["office of", "assistant to", "admin assistant", "scheduler"];
      const appearsLikeScheduler = (name, email) => {
        const n = (name || "").toLowerCase();
        const e = (email || "").toLowerCase();
        if (SCHEDULER_DENYLIST.some((dom) => e.includes(dom))) return true;
        if (denyKeywords.some((k) => n.includes(k))) return true;
        if (
          n &&
          lowerBody.includes(n) &&
          /office of|assistant to|o:\s*\+?\d|beverly hills|signature/gi.test(lowerBody)
        )
          return true;
        return false;
      };

      if (Array.isArray(parsed.attendees_primary)) {
        parsed.attendees_primary = parsed.attendees_primary.filter((n) => {
          const emailMatch = String(n).match(/<([^>]+)>/);
          const email = emailMatch ? emailMatch[1] : "";
          return !appearsLikeScheduler(String(n), email);
        });
      } else {
        parsed.attendees_primary = [];
      }

      parsed.source_subject = subject;
      return res.status(200).json(parsed);
    } catch (err) {
      console.error("OpenAI error:", err?.status, err?.message, err?.response?.data);
      return res.status(502).json({
        error: "Parser error",
        detail: String(err?.response?.data || err?.message || err),
      });
    }
  } catch (err) {
    console.error("Unhandled", err);
    res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
}
