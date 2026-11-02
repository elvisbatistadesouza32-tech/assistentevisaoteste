// =====================================================================
// FUNÇÃO DE SERVIDOR - Assistente de Visão
// ---------------------------------------------------------------------
// Este arquivo roda no Vercel (não no celular).
// O celular manda a foto + a instrução para /api/analisar, e esta função
// repassa para o Google Gemini usando a chave guardada no Vercel
// (variável de ambiente GEMINI_API_KEY). Assim a chave nunca aparece
// no celular nem no código público.
//
// GET  /api/analisar  -> mostra se o servidor está ok e se a chave existe
// POST /api/analisar  -> { prompt, imagem } e devolve { texto, modelo, ms }
// =====================================================================

const MODELOS = ["gemini-flash-latest", "gemini-3-flash-preview", "gemini-2.5-flash"];
const LIMITE_MS = 15000;              // tempo máximo esperando o Google
const TAMANHO_MAX_IMAGEM = 3000000;   // ~2,2 MB em base64 (bem acima dos ~100 KB usados)

// Lembra entre pedidos se o modelo aceita "sem raciocínio" e qual modelo funcionou
let semRaciocinioGlobal = true;
let indiceModeloGlobal = 0;

module.exports = async function handler(req, res) {
  const chave = process.env.GEMINI_API_KEY;

  // ---- Verificação rápida (abrir /api/analisar no navegador) ----
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      chaveConfigurada: !!chave,
      mensagem: chave
        ? "Servidor funcionando e chave configurada."
        : "Servidor funcionando, mas FALTA a variável GEMINI_API_KEY no Vercel.",
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Use POST." });
  }
  if (!chave) {
    return res.status(500).json({ erro: "Falta a variável GEMINI_API_KEY no Vercel (Settings > Environment Variables)." });
  }

  // ---- Lê o pedido do celular ----
  let corpo = req.body;
  if (typeof corpo === "string") {
    try { corpo = JSON.parse(corpo); } catch { corpo = {}; }
  }
  const prompt = corpo && corpo.prompt;
  const imagem = corpo && corpo.imagem;
  if (!prompt || typeof prompt !== "string" || prompt.length > 5000) {
    return res.status(400).json({ erro: "Instrução (prompt) ausente ou grande demais." });
  }
  if (!imagem || typeof imagem !== "string" || imagem.length > TAMANHO_MAX_IMAGEM) {
    return res.status(400).json({ erro: "Imagem ausente ou grande demais." });
  }

  // ---- Chama o Gemini (com tentativas automáticas) ----
  const inicio = Date.now();
  let semRaciocinio = semRaciocinioGlobal;
  let indiceModelo = indiceModeloGlobal;

  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const modelo = MODELOS[indiceModelo];
    const generationConfig = { temperature: 0.2, maxOutputTokens: 1024 };
    if (semRaciocinio) generationConfig.thinkingConfig = { thinkingBudget: 0 };

    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), LIMITE_MS);

    let resposta, dados;
    try {
      resposta = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": chave },
          body: JSON.stringify({
            contents: [{ parts: [
              { text: prompt },
              { inline_data: { mime_type: "image/jpeg", data: imagem } },
            ] }],
            generationConfig,
          }),
          signal: controle.signal,
        }
      );
      dados = await resposta.json().catch(() => ({}));
    } catch (e) {
      clearTimeout(relogio);
      const motivo = e.name === "AbortError" ? `o Google não respondeu em ${LIMITE_MS / 1000}s` : e.message;
      return res.status(504).json({ erro: `Falha ao falar com o Google: ${motivo}` });
    }
    clearTimeout(relogio);

    if (!resposta.ok) {
      const msg = (dados.error && dados.error.message) || `HTTP ${resposta.status}`;
      // Modelo não aceita desligar o raciocínio: tenta sem essa opção
      if (resposta.status === 400 && semRaciocinio && /thinking/i.test(msg)) { semRaciocinio = false; continue; }
      // Modelo não encontrado: tenta o próximo da lista
      if (resposta.status === 404 && indiceModelo < MODELOS.length - 1) { indiceModelo++; continue; }
      return res.status(resposta.status).json({ erro: `Google respondeu ${resposta.status}: ${msg}`, modelo });
    }

    const candidato = dados.candidates && dados.candidates[0];
    const partes = (candidato && candidato.content && candidato.content.parts) || [];
    const texto = partes.filter(p => p.text && !p.thought).map(p => p.text).join("\n").trim();
    if (!texto) {
      const motivo = (candidato && candidato.finishReason) || (dados.promptFeedback && dados.promptFeedback.blockReason) || "desconhecido";
      return res.status(502).json({ erro: `Resposta vazia da IA (motivo: ${motivo})`, modelo });
    }

    semRaciocinioGlobal = semRaciocinio;
    indiceModeloGlobal = indiceModelo;
    return res.status(200).json({ texto, modelo, ms: Date.now() - inicio });
  }

  return res.status(502).json({ erro: "Não consegui uma resposta válida da IA." });
};
