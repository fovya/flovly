const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    if (request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "lyvia-curhat-api",
        status: "ready",
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method tidak diizinkan." }, 405);
    }

    try {
      const body = await request.json().catch(() => ({}));
      const keyword = String(body.keyword || body.secretKeyword || "").trim();
      const message = String(body.message || body.prompt || body.text || "").trim();
      const history = Array.isArray(body.history) ? body.history : [];

      const expectedKeyword = String(env.SECRET_KEYWORD || "").trim();
      if (!expectedKeyword) {
        return jsonResponse(
          { error: "SECRET_KEYWORD belum diatur di Cloudflare Worker." },
          500
        );
      }

      if (!keyword || keyword.toLowerCase() !== expectedKeyword.toLowerCase()) {
        return jsonResponse({ error: "Kata kunci salah." }, 401);
      }

      if (!message) {
        return jsonResponse({ error: "Pesan curhat tidak boleh kosong." }, 400);
      }

      const apiKey = String(env.GEMINI_API_KEY || "").trim();
      if (!apiKey) {
        return jsonResponse(
          { error: "GEMINI_API_KEY belum diatur di Cloudflare Worker." },
          500
        );
      }

      const contents = [];

      for (const item of history.slice(-10)) {
        const role = item && item.role === "model" ? "model" : "user";
        const text = String(item?.parts?.[0]?.text ?? item?.text ?? item?.content ?? "").trim();
        if (text) {
          contents.push({
            role,
            parts: [{ text }],
          });
        }
      }

      contents.push({
        role: "user",
        parts: [{ text: message }],
      });

      const systemInstruction = {
        parts: [
          {
            text: "Kamu adalah teman curhat yang hangat, empatik, lembut, dan suportif untuk Lyvia. Jawab dalam bahasa Indonesia yang natural, menenangkan, dan tidak menggurui.",
          },
        ],
      };

      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
        apiKey
      )}`;

      const geminiRes = await fetch(geminiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction,
          contents,
        }),
      });

      const geminiData = await geminiRes.json().catch(() => ({}));

      if (!geminiRes.ok) {
        const apiErrorMsg =
          geminiData?.error?.message || `Gemini API error (${geminiRes.status})`;
        return jsonResponse({ error: apiErrorMsg }, geminiRes.status);
      }

      const reply =
        geminiData?.candidates?.[0]?.content?.parts
          ?.map((part) => part?.text || "")
          .join("")
          .trim() || "Maaf, aku belum bisa merespons sekarang. Coba ulangi ya.";

      return jsonResponse({
        reply,
        text: reply,
        message: reply,
      });
    } catch (err) {
      return jsonResponse(
        { error: err?.message || "Terjadi kesalahan pada server Worker." },
        500
      );
    }
  },
};
