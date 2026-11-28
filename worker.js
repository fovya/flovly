const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

const MODEL_NAME = "gemini-3.8-flash";

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

function extractReplyText(geminiData) {
  const replyParts = geminiData?.candidates?.[0]?.content?.parts || [];
  return replyParts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGeminiOnce(apiKey, payload) {
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    MODEL_NAME
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(geminiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000)
  });

  const data = await res.json().catch(() => ({}));
  return { res, data };
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

    const payload = {
      systemInstruction: {
        parts: [{ text: buildSystemInstruction() }]
      },
      contents,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 600
      }
    };

    const maxAttempts = 2;
    let lastErrorMessage = "Gagal memanggil Gemini API.";
    let lastStatus = 502;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const { res, data } = await callGeminiOnce(apiKey, payload);

        if (res.ok) {
          const replyText = extractReplyText(data);
          if (replyText) {
            return jsonResponse({ reply: replyText });
          }
          lastErrorMessage = "Balasan kosong diterima dari Gemini.";
          lastStatus = 502;
        } else {
          const apiErrorMessage =
            data?.error?.message || `Gagal memanggil Gemini API (HTTP ${res.status}).`;
          lastErrorMessage = apiErrorMessage;
          lastStatus = res.status;

          const isTempSpike =
            res.status === 429 ||
            res.status === 503 ||
            res.status === 504 ||
            /high demand|unavailable|overloaded/i.test(apiErrorMessage);

          if (!isTempSpike || attempt === maxAttempts) {
            return jsonResponse({ error: apiErrorMessage }, res.status);
          }
        }
      } catch (err) {
        lastErrorMessage =
          err?.name === "TimeoutError"
            ? "Waktu tunggu respons Gemini habis."
            : "Gagal terhubung ke Gemini API: " + (err?.message || String(err));
        lastStatus = 504;

        if (attempt === maxAttempts) {
          return jsonResponse({ error: lastErrorMessage }, lastStatus);
        }
      }

      await sleep(800);
    }

    return jsonResponse({ error: lastErrorMessage }, lastStatus);
  }
};
