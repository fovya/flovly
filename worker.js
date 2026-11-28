const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

const PREFERRED_MODELS = [
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile",
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
    "Kamu adalah ruang cerita dan teman ngobrol yang mencerminkan sikap Fatur saat memperlakukan Lyvia.",
    "Sikapmu selalu dewasa, tenang, penyayang, sangat mengertiin Lyvia, dan selalu nurutin kemauan atau kebutuhan Lyvia dengan tulus tanpa membantah atau mendebat.",
    "Gunakan bahasa Indonesia sehari-hari yang lembut, hangat, akrab, dan menenangkan dengan sapaan aku dan kamu.",
    "Saat Lyvia lagi capek, bad mood, atau kesal—termasuk kalau ia kesal ke Fatur—tetap bersikap dewasa, sabar, meredakan suasana, mendengarkan perasaannya dulu, dan tidak menggurui.",
    "Selalu akhiri setiap balasanmu dengan kata cayang di bagian paling akhir kalimat.",
    "Jangan pernah menyebut diri kamu model bahasa, AI, bot, atau sistem teknis kecuali ditanya secara langsung."
  ].join(" ");
}

function ensureEndingCayang(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return "Aku di sini nemenin kamu terus, cayang";

  const withoutTrailingPunct = cleaned.replace(/[.!?…]+$/g, "").trim();
  if (/\bcayang$/i.test(withoutTrailingPunct)) {
    return withoutTrailingPunct;
  }

  return `${withoutTrailingPunct}, cayang`;
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

function isNonChatModel(modelId) {
  return /whisper|tts|orpheus|guard|prompt|embed|audio|speech/i.test(modelId || "");
}

async function resolveGroqModel(groqKey) {
  if (cachedModelId && !isNonChatModel(cachedModelId)) {
    return cachedModelId;
  }
  cachedModelId = null;

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
      const activeIds = new Set(
        models
          .map((m) => m?.id)
          .filter((id) => typeof id === "string" && id.length > 0 && !isNonChatModel(id))
      );

      for (const preferred of PREFERRED_MODELS) {
        if (activeIds.has(preferred)) {
          cachedModelId = preferred;
          return cachedModelId;
        }
      }

      const firstChatId = [...activeIds][0];
      if (firstChatId) {
        cachedModelId = firstChatId;
        return cachedModelId;
      }
    }
  } catch (_) {
    // Fallback ke model default chat
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
          temperature: 0.85,
          max_tokens: 400
        }),
        signal: AbortSignal.timeout(8000)
      });

      const groqData = await groqRes.json().catch(() => ({}));

      if (!groqRes.ok) {
        const apiError =
          groqData?.error?.message || `Gagal memanggil Groq API (HTTP ${groqRes.status}).`;
        return jsonResponse({ error: apiError }, groqRes.status);
      }

      const rawReply = groqData?.choices?.[0]?.message?.content?.trim();
      if (!rawReply) {
        return jsonResponse({ error: "Balasan kosong diterima dari AI." }, 502);
      }

      return jsonResponse({ reply: ensureEndingCayang(rawReply) });
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
