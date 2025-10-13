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
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const client = new OpenAI({ apiKey: process.env.MICAHB_OPENAI_API_KEY });

export default async function handler(req, res) {
  // CORS first
  setCORS(res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

  try {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

        // Parse JSON body safely
    const data = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    const subject = data.subject;
    const body = data.body;

    // Simple auth: set header "Authorization: Bearer <AUTH_TOKEN>"
    const authHeader = req.headers.authorization || "";
    if (!AUTH || !authHeader.startsWith("Bearer ") || authHeader.split(" ")[1] !== AUTH) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const { subject = "", body = "" } = await readJson(req);
    if (!body) {
      res.status(400).json({ error: "Missing 'body' in JSON payload" });
      return;
    }

    // System + user prompt for strict JSON extraction
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
      "Return valid ISO 8601 timestamps for start_iso/end_iso when possible (e.g., 2025-09-30T10:00:00-07:00)."
    ].join(" ");

    const schema = {
      title: "",
      date_text: "",     // original date text found (optional, human-readable)
      time_text: "",     // original time text found (optional)
      start_iso: "",     // ISO 8601 if determinable
      end_iso: "",
      location: "",      // room info or general description
      address: "",       // street address if present
      join_url: "",      // Zoom/Meet/Teams link if present
      organizer_name: "",
      organizer_email: "",
      scheduler_name: "",  // agent/assistant who set it up
      scheduler_email: "",
      attendees_primary: [], // array of names we meet WITH
      companies: [],         // e.g., ["Platinum Dunes", "UTA"]
      source_subject: "",    // echo of subject
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

    const resp = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });

    let data = {};
    try {
      data = JSON.parse(resp.choices?.[0]?.message?.content || "{}");
    } catch {
      // If model returned non-JSON somehow
      data = {};
    }

    // Minimal post-AI guardrails: remove obvious schedulers from attendees
    const lowerBody = String(body).toLowerCase();
    const denyKeywords = ["office of", "assistant to", "admin assistant", "scheduler"];
    const appearsLikeScheduler = (name, email) => {
      const n = (name || "").toLowerCase();
      const e = (email || "").toLowerCase();
      if (SCHEDULER_DENYLIST.some(dom => e.includes(dom))) return true;
      if (denyKeywords.some(k => n.includes(k))) return true;
      // if the name appears near signature blocks, heuristic skip (weak but cheap):
      if (n && lowerBody.includes(n) && /office of|assistant to|o:\s*\+?\d|beverly hills|signature/gi.test(lowerBody)) {
        return true;
      }
      return false;
    };

    // Clean attendees_primary if model slipped
    if (Array.isArray(data.attendees_primary)) {
      data.attendees_primary = data.attendees_primary.filter(n => {
        // If the AI also included emails in array entries like "Name <email>", split:
        const emailMatch = String(n).match(/<([^>]+)>/);
        const email = emailMatch ? emailMatch[1] : "";
        return !appearsLikeScheduler(String(n), email);
      });
    } else {
      data.attendees_primary = [];
    }

    // Always echo subject back
    data.source_subject = subject;

    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Parser error", detail: String(err?.message || err) });
  }
}

async function readJson(req) {
  const text = await new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", c => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}
