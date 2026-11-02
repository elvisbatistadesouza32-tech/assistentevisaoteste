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

// Modelos confirmados na lista da conta. Se um estiver sobrecarregado (503),
// indisponível (500) ou não existir (404), o servidor tenta o próximo.
const MODELOS = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-3.1-flash-lite"];
const LIMITE_MS = 8000;               // tempo máximo esperando o Google em cada tentativa
const ORCAMENTO_TOTAL_MS = 18000;     // tempo máximo somando todas as tentativas
const TAMANHO_MAX_IMAGEM = 3000000;   // ~2,2 MB em base64 (bem acima dos ~100 KB usados)

// Lembra entre pedidos se o modelo aceita "sem raciocínio" e qual modelo funcionou.
// O modelo reserva é usado por 5 minutos; depois o servidor volta a tentar o principal.
let semRaciocinioGlobal = true;
let indiceModeloGlobal = 0;
let modeloReservaDesde = 0;

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
  if (indiceModeloGlobal !== 0 && Date.now() - modeloReservaDesde > 5 * 60 * 1000) indiceModeloGlobal = 0;
  let indiceModelo = indiceModeloGlobal;
  const tentados = [];

  for (let tentativa = 0; tentativa < MODELOS.length * 2; tentativa++) {
    if (Date.now() - inicio > ORCAMENTO_TOTAL_MS) break;
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
      const motivo = e.name === "AbortError" ? `sem resposta em ${LIMITE_MS / 1000}s` : e.message;
      tentados.push(`${modelo}: ${motivo}`);
      if (indiceModelo < MODELOS.length - 1) { indiceModelo++; continue; }
      return res.status(504).json({ erro: `Falha ao falar com o Google (${tentados.join("; ")})` });
    }
    clearTimeout(relogio);

    if (!resposta.ok) {
      const msg = (dados.error && dados.error.message) || `HTTP ${resposta.status}`;
      // Modelo não aceita desligar o raciocínio: tenta sem essa opção
      if (resposta.status === 400 && semRaciocinio && /thinking/i.test(msg)) { semRaciocinio = false; continue; }
      // Modelo não encontrado: tenta o próximo da lista
      // Modelo inexistente (404), sobrecarregado (503) ou com falha (500): tenta o próximo
      if ([404, 500, 503].includes(resposta.status) && indiceModelo < MODELOS.length - 1) {
        tentados.push(`${modelo}: ${resposta.status}`);
        indiceModelo++;
        continue;
      }
      tentados.push(`${modelo}: ${resposta.status}`);
      return res.status(resposta.status).json({ erro: `Google respondeu ${resposta.status}: ${msg}`, modelo, tentados });
    }

    const candidato = dados.candidates && dados.candidates[0];
    const partes = (candidato && candidato.content && candidato.content.parts) || [];
    const texto = partes.filter(p => p.text && !p.thought).map(p => p.text).join("\n").trim();
    if (!texto) {
      const motivo = (candidato && candidato.finishReason) || (dados.promptFeedback && dados.promptFeedback.blockReason) || "desconhecido";
      return res.status(502).json({ erro: `Resposta vazia da IA (motivo: ${motivo})`, modelo });
    }

    semRaciocinioGlobal = semRaciocinio;
    if (indiceModelo !== indiceModeloGlobal) { indiceModeloGlobal = indiceModelo; modeloReservaDesde = Date.now(); }
    return res.status(200).json({ texto, modelo, ms: Date.now() - inicio, tentados });
  }

  return res.status(503).json({ erro: `Todos os modelos estão ocupados agora. Tente de novo em alguns segundos. (${tentados.join("; ")})` });
};
