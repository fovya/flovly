const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

const PREFERRED_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "gemma2-9b-it",
  "qwen/qwen3-32b"
];

let cachedModelId = null;

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
    "Jawab dalam bahasa Indonesia yang natural, lembut, hangat, dan tidak menggurui.",
    "Dengarkan perasaannya dulu, validasi emosinya dengan tulus, lalu beri dukungan atau saran ringan secara ringkas.",
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
      role: item.role === "model" ? "assistant" : "user",
      content: item.text.trim()
    }));
}

async function resolveGroqModel(groqKey) {
  if (cachedModelId) return cachedModelId;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: {
        Authorization: `Bearer ${groqKey}`
      },
      signal: AbortSignal.timeout(4000)
    });

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const models = Array.isArray(data?.data) ? data.data : [];
      const activeIds = new Set(models.map((m) => m.id).filter(Boolean));

      for (const preferred of PREFERRED_MODELS) {
        if (activeIds.has(preferred)) {
          cachedModelId = preferred;
          return cachedModelId;
        }
      }

      const firstChatModel = models.find(
        (m) => m.id && !/whisper|tts|guard|prompt|embed/i.test(m.id)
      );
      if (firstChatModel?.id) {
        cachedModelId = firstChatModel.id;
        return cachedModelId;
      }
    }
  } catch (_) {
    // Fallback ke model default
  }

  return "llama-3.1-8b-instant";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      return jsonResponse({ ok: true, service: "lyvia-curhat-api", engine: "groq" });
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method tidak diizinkan. Gunakan POST." }, 405);
    }

    const expectedKeyword = (env.SECRET_KEYWORD || "").trim();
    if (!expectedKeyword) {
      return jsonResponse({ error: "SECRET_KEYWORD belum diatur di Cloudflare Worker." }, 500);
    }

    const groqKey = (env.GROQ_API_KEY || "").trim();
    if (!groqKey) {
      return jsonResponse({ error: "GROQ_API_KEY belum diatur di Cloudflare Worker." }, 500);
    }

    let body;
    try {
      body = await request.json();
    } catch (_) {
      return jsonResponse({ error: "Format request harus JSON yang valid." }, 400);
    }

    const providedKeyword = typeof body.keyword === "string" ? body.keyword.trim() : "";
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const history = normalizeHistory(body.history);

    if (!providedKeyword || providedKeyword !== expectedKeyword) {
      return jsonResponse({ error: "Kata kunci salah. Coba periksa lagi ya." }, 401);
    }

    if (!message) {
      return jsonResponse({ error: "Pesan curhat tidak boleh kosong." }, 400);
    }

    const activeModel = await resolveGroqModel(groqKey);

    const messages = [
      { role: "system", content: buildSystemInstruction() },
      ...history,
      { role: "user", content: message }
    ];

    try {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: activeModel,
          messages,
          temperature: 0.8,
          max_tokens: 450
        }),
        signal: AbortSignal.timeout(8000)
      });

      const groqData = await groqRes.json().catch(() => ({}));

      if (!groqRes.ok) {
        const apiError =
          groqData?.error?.message || `Gagal memanggil Groq API (HTTP ${groqRes.status}).`;
        return jsonResponse({ error: apiError }, groqRes.status);
      }

      const replyText = groqData?.choices?.[0]?.message?.content?.trim();
      if (!replyText) {
        return jsonResponse({ error: "Balasan kosong diterima dari AI." }, 502);
      }

      return jsonResponse({ reply: replyText });
    } catch (err) {
      if (err?.name === "TimeoutError") {
        return jsonResponse({ error: "Waktu tunggu habis, coba kirim ulang sebentar ya." }, 504);
      }
      return jsonResponse(
        { error: "Gagal terhubung ke server AI: " + (err?.message || String(err)) },
        502
      );
    }
  }
};
