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

// Modelos confirmados na lista da conta, do mais rápido para o mais completo.
// Se um falhar (ocupado, erro, sem resposta), o servidor tenta o próximo.
const MODELOS = ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash", "gemini-3.1-flash-lite"];
const LIMITE_MS = 12000;              // tempo máximo esperando o Google em cada tentativa
const ORCAMENTO_TOTAL_MS = 25000;     // tempo máximo somando todas as tentativas
const TAMANHO_MAX_IMAGEM = 3000000;   // ~2,2 MB em base64 (bem acima dos ~100 KB usados)

// Lembra qual modelo funcionou por último (por 5 minutos), para ir direto nele.
let ultimoModeloBom = 0;
let ultimoModeloBomDesde = 0;

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

  // ---- Ordem das tentativas: começa pelo último modelo que funcionou ----
  if (Date.now() - ultimoModeloBomDesde > 5 * 60 * 1000) ultimoModeloBom = 0;
  const ordem = [ultimoModeloBom, ...MODELOS.map((_, i) => i).filter(i => i !== ultimoModeloBom)];

  const inicio = Date.now();
  const tentados = [];
  let ultimoErro = { status: 503, msg: "Nenhum modelo respondeu." };

  for (const indice of ordem) {
    const restante = ORCAMENTO_TOTAL_MS - (Date.now() - inicio);
    if (restante < 2000) break;
    const modelo = MODELOS[indice];
    const t0 = Date.now();

    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), Math.min(LIMITE_MS, restante));

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
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
          }),
          signal: controle.signal,
        }
      );
      dados = await resposta.json().catch(() => ({}));
    } catch (e) {
      clearTimeout(relogio);
      const motivo = e.name === "AbortError" ? "sem resposta a tempo" : e.message;
      tentados.push(`${modelo}: ${motivo} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      ultimoErro = { status: 504, msg: motivo };
      continue;
    }
    clearTimeout(relogio);

    if (!resposta.ok) {
      const msg = (dados.error && dados.error.message) || `HTTP ${resposta.status}`;
      tentados.push(`${modelo}: ${resposta.status} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      ultimoErro = { status: resposta.status, msg };
      // Chave inválida ou sem permissão: não adianta trocar de modelo
      if (resposta.status === 401 || resposta.status === 403) break;
      continue;
    }

    const candidato = dados.candidates && dados.candidates[0];
    const partes = (candidato && candidato.content && candidato.content.parts) || [];
    const texto = partes.filter(p => p.text && !p.thought).map(p => p.text).join("\n").trim();
    if (!texto) {
      const motivo = (candidato && candidato.finishReason) || (dados.promptFeedback && dados.promptFeedback.blockReason) || "desconhecido";
      tentados.push(`${modelo}: resposta vazia (${motivo})`);
      ultimoErro = { status: 502, msg: `Resposta vazia da IA (motivo: ${motivo})` };
      continue;
    }

    ultimoModeloBom = indice;
    ultimoModeloBomDesde = Date.now();
    return res.status(200).json({ texto, modelo, ms: Date.now() - inicio, tentados });
  }

  return res.status(ultimoErro.status).json({
    erro: `Nenhum modelo conseguiu responder. Último erro: ${ultimoErro.msg}. Tentativas: ${tentados.join("; ")}`,
    tentados,
  });
};
