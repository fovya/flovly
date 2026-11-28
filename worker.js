const ALLOWED_ORIGINS = [
  "https://fovya.github.io",
  "http://localhost:3000",
  "http://127.0.0.1:5500"
];

const MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash"
];

const SYSTEM_INSTRUCTION = `
Kamu adalah teman curhat yang hangat, empatik, suportif, dan aman untuk Lyvia.
Jawablah dengan bahasa Indonesia yang natural, lembut, dan tidak menghakimi.
Dengarkan perasaannya dulu sebelum memberi saran, dan jangan terlalu panjang kecuali diminta.
`.trim();

function getCorsHeaders(origin) {
  const allowedOrigin =
    origin && ALLOWED_ORIGINS.includes(origin)
      ? origin
      : "https://fovya.github.io";

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}

function jsonResponse(payload, status = 200, origin = "") {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...getCorsHeaders(origin)
    }
  });
}

function buildContents(history, message) {
  const contents = [];

  if (Array.isArray(history)) {
    for (const item of history.slice(-16)) {
      if (!item || typeof item.text !== "string") continue;
      const cleanText = item.text.trim();
      if (!cleanText) continue;

      const role = item.role === "model" || item.role === "assistant" ? "model" : "user";
      contents.push({
        role,
        parts: [{ text: cleanText }]
      });
    }
  }

  contents.push({
    role: "user",
    parts: [{ text: message.trim() }]
  });

  return contents;
}

async function callGeminiModel(model, apiKey, contents) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_INSTRUCTION }]
      },
      contents,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 800
      }
    })
  });

  const rawText = await response.text();
  let data = null;

  try {
    data = JSON.parse(rawText);
  } catch (_) {
    data = null;
  }

  return { ok: response.ok, status: response.status, data, rawText };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(origin)
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Metode tidak diizinkan." }, 405, origin);
    }

    const apiKey = env.GEMINI_API_KEY;
    const expectedKeyword = (env.SECRET_KEYWORD || "manchester united").trim().toLowerCase();

    if (!apiKey) {
      return jsonResponse(
        { error: "GEMINI_API_KEY belum diatur di Cloudflare Worker." },
        500,
        origin
      );
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse({ error: "Format permintaan tidak valid." }, 400, origin);
    }

    const providedKeyword = typeof body.keyword === "string" ? body.keyword.trim().toLowerCase() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = Array.isArray(body.history) ? body.history : [];

    if (!providedKeyword || providedKeyword !== expectedKeyword) {
      return jsonResponse(
        { error: "Kata kunci rahasia salah atau belum diisi." },
        401,
        origin
      );
    }

    if (!message) {
      return jsonResponse({ error: "Pesan tidak boleh kosong." }, 400, origin);
    }

    const contents = buildContents(history, message);
    let lastErrorMessage = "Model sedang sibuk, coba beberapa saat lagi ya.";

    for (const model of MODELS) {
      try {
        const result = await callGeminiModel(model, apiKey, contents);

        if (result.ok && result.data) {
          const reply =
            result.data?.candidates?.[0]?.content?.parts
              ?.map((p) => p.text || "")
              .join("")
              .trim() || "";

          if (reply) {
            return jsonResponse({ reply, model }, 200, origin);
          }
        }

        const apiErrMsg =
          result.data?.error?.message ||
          `Gagal memanggil ${model} (status ${result.status})`;
        lastErrorMessage = apiErrMsg;

        const isTemporaryOrModelIssue =
          result.status === 429 ||
          result.status === 503 ||
          result.status === 500 ||
          result.status === 404 ||
          /high demand|overloaded|quota|not found|unsupported/i.test(apiErrMsg);

        if (!isTemporaryOrModelIssue) {
          break;
        }
      } catch (err) {
        lastErrorMessage = `Gangguan jaringan ke Gemini: ${err.message || "unknown error"}`;
      }
    }

    return jsonResponse({ error: lastErrorMessage }, 503, origin);
  }
};
// trigger build for worker deployment v2
