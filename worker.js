const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

function buildSystemInstruction() {
  return [
    "Kamu adalah teman curhat AI yang hangat, empatik, penuh perhatian, dan suportif untuk Lyvia.",
    "Jawab dalam bahasa Indonesia yang natural, lembut, dan tidak menggurui.",
    "Dengarkan perasaannya dulu, validasi emosinya dengan tulus, lalu beri dukungan atau saran ringan hanya jika terasa relevan.",
    "Jangan menyebut diri kamu model bahasa atau AI teknis kecuali ditanya langsung."
  ].join(" ");
}

function normalizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];

  return rawHistory
    .slice(-12)
    .filter(
      (item) =>
        item &&
        (item.role === "user" || item.role === "model") &&
        typeof item.text === "string" &&
        item.text.trim().length > 0
    )
    .map((item) => ({
      role: item.role,
      parts: [{ text: item.text.trim() }]
    }));
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "lyvia-curhat-api"
      });
    }

    if (request.method !== "POST") {
      return jsonResponse(
        { error: "Method tidak diizinkan. Gunakan POST." },
        405
      );
    }

    const expectedKeyword = (env.SECRET_KEYWORD || "").trim();
    if (!expectedKeyword) {
      return jsonResponse(
        { error: "SECRET_KEYWORD belum diatur di Cloudflare Worker." },
        500
      );
    }

    const apiKey = (env.GEMINI_API_KEY || "").trim();
    if (!apiKey) {
      return jsonResponse(
        { error: "GEMINI_API_KEY belum diatur di Cloudflare Worker." },
        500
      );
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse(
        { error: "Format request harus JSON yang valid." },
        400
      );
    }

    const providedKeyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = normalizeHistory(body.history);

    if (!providedKeyword || providedKeyword !== expectedKeyword) {
      return jsonResponse(
        { error: "Kata kunci salah. Coba periksa lagi ya." },
        401
      );
    }

    if (!message) {
      return jsonResponse(
        { error: "Pesan curhat tidak boleh kosong." },
        400
      );
    }

    const contents = [
      ...history,
      {
        role: "user",
        parts: [{ text: message }]
      }
    ];

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;

    try {
      const geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: buildSystemInstruction() }]
          },
          contents,
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 600
          }
        })
      });

      const geminiData = await geminiRes.json();

      if (!geminiRes.ok) {
        const apiErrorMessage =
          geminiData?.error?.message || `Gagal memanggil Gemini API (HTTP ${geminiRes.status}).`;
        return jsonResponse({ error: apiErrorMessage }, geminiRes.status);
      }

      const replyParts = geminiData?.candidates?.[0]?.content?.parts || [];
      const replyText = replyParts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();

      if (!replyText) {
        return jsonResponse(
          { error: "Balasan kosong diterima dari Gemini." },
          502
        );
      }

      return jsonResponse({ reply: replyText });
    } catch (err) {
      return jsonResponse(
        { error: "Gagal terhubung ke Gemini API: " + (err?.message || String(err)) },
        502
      );
    }
  }
};
