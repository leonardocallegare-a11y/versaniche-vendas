const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongodb");

const port = Number(process.env.PORT || 3000);
const adminUser = process.env.ADMIN_USER;
const adminPassword = process.env.ADMIN_PASSWORD;

const painel = fs.readFileSync(
  path.join(__dirname, "painel.html"),
  "utf8"
);

let bancoStatus = "Testando conexão...";
let bancoPronto = false;
let client;
let ocupado = false;
let pedidosIA = [];
let tentativasLogin = [];

const autorizacoesML = new Map();

function iguais(a, b) {
  const hash = (valor) =>
    crypto
      .createHash("sha256")
      .update(String(valor ?? ""))
      .digest();

  return crypto.timingSafeEqual(hash(a), hash(b));
}

function autorizado(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;

  const texto = Buffer.from(
    header.slice(6),
    "base64"
  ).toString("utf8");

  const posicao = texto.indexOf(":");
  if (posicao < 0) return false;

  const usuarioCorreto = iguais(
    texto.slice(0, posicao),
    adminUser
  );

  const senhaCorreta = iguais(
    texto.slice(posicao + 1),
    adminPassword
  );

  return usuarioCorreto && senhaCorreta;
}

function json(res, status, dados) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(dados));
}

async function lerJson(req) {
  const partes = [];
  let tamanho = 0;

  for await (const parte of req) {
    tamanho += parte.length;

    if (tamanho > 20000) {
      throw new Error("Mensagem muito grande.");
    }

    partes.push(parte);
  }

  return JSON.parse(
    Buffer.concat(partes).toString("utf8")
  );
}

async function testarBanco() {
  bancoPronto = false;

  if (!process.env.MONGODB_URI) {
    bancoStatus = "Falta configurar MONGODB_URI.";
    return;
  }

  try {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 15000,
      connectTimeoutMS: 10000,
      maxPoolSize: 5
    });

    await client.connect();
    await client.db("admin").command({ ping: 1 });

    bancoPronto = true;
    bancoStatus = "MongoDB conectado com sucesso!";
    console.log(bancoStatus);
  } catch {
    bancoStatus = "Falha na conexão com o MongoDB.";
    console.log(bancoStatus);

    if (client) {
      await client.close().catch(() => {});
    }
  }
}

async function conversar(req, res) {
  const origem = req.headers.origin;
  const origemPermitida =
    "https://versaniche-vendas.onrender.com";

  if (origem !== origemPermitida) {
    return json(res, 403, {
      erro: "Origem não autorizada."
    });
  }

  const tipo = req.headers["content-type"] || "";

  if (!tipo.startsWith("application/json")) {
    return json(res, 415, {
      erro: "Formato inválido."
    });
  }

  if (!process.env.OPENAI_API_KEY) {
    return json(res, 503, {
      erro: "Falta configurar OPENAI_API_KEY no Render."
    });
  }

  let dados;

  try {
    dados = await lerJson(req);
  } catch {
    return json(res, 400, {
      erro: "Mensagem inválida ou muito grande."
    });
  }

  if (!Array.isArray(dados?.mensagens)) {
    return json(res, 400, {
      erro: "Conversa inválida."
    });
  }

  const mensagens = dados.mensagens;

  const valido =
    mensagens.length > 0 &&
    mensagens.length <= 12 &&
    mensagens.every((m) =>
      m &&
      ["user", "assistant"].includes(m.role) &&
      typeof m.content === "string" &&
      m.content.trim().length > 0 &&
      m.content.length <= 2000
    ) &&
    mensagens[mensagens.length - 1].role === "user";

  if (!valido) {
    return json(res, 400, {
      erro: "Use mensagens de até 2.000 caracteres."
    });
  }

  const agora = Date.now();

  pedidosIA = pedidosIA.filter(
    (t) => agora - t < 60000
  );

  if (ocupado || pedidosIA.length >= 8) {
    return json(res, 429, {
      erro: "Aguarde a resposta ou tente novamente em um minuto."
    });
  }

  ocupado = true;
  pedidosIA.push(agora);

  try {
    const resposta = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        signal: AbortSignal.timeout(45000),
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
          store: false,
          max_output_tokens: 700,
          instructions: `
Você é o Jarvis, assistente de gestão da Versaniche.
Responda em português brasileiro, com clareza e objetividade.
O responsável prefere ser chamado de Chefe Supremo.
A empresa trabalha com filamentos e produtos de impressão 3D.

Nesta versão você NÃO tem acesso às vendas, estoque,
custos, mensagens de clientes ou anúncios do Mercado Livre.
Você NÃO pode publicar anúncios, alterar preços ou criar ofertas.
Não existe ferramenta de consulta ao banco disponível para você.
Nunca afirme que consultou dados ou executou ações.
Use apenas informações fornecidas na conversa.
Diferencie fatos informados, hipóteses e sugestões.
Para cálculos, explique as premissas e peça dados que faltarem.
Pode ajudar a planejar, analisar dados fornecidos e redigir anúncios.
Não peça senhas, tokens nem chaves de API.
          `,
          input: mensagens
        })
      }
    );

    const resultado = await resposta.json().catch(
      () => ({})
    );

    if (!resposta.ok) {
      let erro =
        "A IA não respondeu. Tente novamente depois.";

      if (resposta.status === 401) {
        erro = "A chave da OpenAI não foi aceita.";
      } else if (resposta.status === 403) {
        erro = "A chave não tem permissão para esse recurso.";
      } else if (
        resultado.error?.code === "insufficient_quota"
      ) {
        erro = "Confira os créditos e a cobrança da API OpenAI.";
      } else if (resposta.status === 429) {
        erro = "Limite da API atingido. Confira uso e créditos.";
      } else if (resposta.status === 404) {
        erro = "O modelo configurado não está disponível para a conta.";
      }

      return json(res, 502, { erro });
    }

    const texto = (resultado.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((item) => item.type === "output_text")
      .map((item) => item.text)
      .join("\n");

    if (!texto) {
      return json(res, 502, {
        erro: "A IA retornou uma resposta sem texto."
      });
    }

    return json(res, 200, {
      resposta: texto
    });
  } catch {
    return json(res, 502, {
      erro: "Falha de comunicação ou tempo de resposta excedido."
    });
  } finally {
    ocupado = false;
  }
}

function configuracaoML() {
  const clientId = process.env.MELI_CLIENT_ID;
  const clientSecret = process.env.MELI_CLIENT_SECRET;
  const redirectUri = process.env.MELI_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Credenciais do Mercado Livre incompletas."
    );
  }

  return {
    clientId,
    clientSecret,
    redirectUri
  };
}

function limparCookieML(res) {
  res.setHeader(
    "Set-Cookie",
    "meli_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/api/mercadolivre; Max-Age=0"
  );
}

async function conectarMercadoLivre(req, res) {
  let config;

  try {
    config = configuracaoML();
  } catch {
    return json(res, 503, {
      erro: "Confira MELI_CLIENT_ID, MELI_CLIENT_SECRET e MELI_REDIRECT_URI no Render."
    });
  }

  if (!bancoPronto || !client) {
    return json(res, 503, {
      erro: "MongoDB indisponível. Confira /status antes de conectar."
    });
  }

  try {
    await client.db("admin").command({ ping: 1 });
  } catch {
    return json(res, 503, {
      erro: "Não foi possível acessar o MongoDB."
    });
  }

  const agora = Date.now();

  for (const [chave, valor] of autorizacoesML) {
    if (valor.expira < agora) {
      autorizacoesML.delete(chave);
    }
  }

  if (autorizacoesML.size >= 100) {
    return json(res, 429, {
      erro: "Muitas autorizações em andamento. Aguarde alguns minutos."
    });
  }

  const state = crypto.randomBytes(32).toString("hex");
  const navegador = crypto.randomBytes(32).toString("hex");

  autorizacoesML.set(state, {
    navegador,
    expira: agora + 10 * 60 * 1000
  });

  res.setHeader(
    "Set-Cookie",
    `meli_oauth=${navegador}; HttpOnly; Secure; SameSite=Lax; Path=/api/mercadolivre; Max-Age=600`
  );

  const destino = new URL(
    "https://auth.mercadolivre.com.br/authorization"
  );

  destino.searchParams.set("response_type", "code");
  destino.searchParams.set("client_id", config.clientId);
  destino.searchParams.set("redirect_uri", config.redirectUri);
  destino.searchParams.set("state", state);

  res.writeHead(302, {
    Location: destino.toString()
  });

  return res.end();
}

async function retornoMercadoLivre(req, res) {
  const url = new URL(
    req.url,
    "https://versaniche-vendas.onrender.com"
  );

  const state = url.searchParams.get("state");
  const registro = autorizacoesML.get(state);

  const cookie = (req.headers.cookie || "")
    .split(";")
    .map((parte) => parte.trim())
    .find((parte) =>
      parte.startsWith("meli_oauth=")
    );

  const navegador = cookie
    ? cookie.slice("meli_oauth=".length)
    : "";

  if (
    !registro ||
    registro.expira < Date.now() ||
    !iguais(navegador, registro.navegador)
  ) {
    return json(res, 400, {
      erro: "Autorização inválida ou expirada. Abra /api/mercadolivre/conectar novamente no mesmo navegador."
    });
  }

  autorizacoesML.delete(state);
  limparCookieML(res);

  if (url.searchParams.has("error")) {
    return json(res, 400, {
      erro: "A autorização não foi concluída no Mercado Livre."
    });
  }

  const code = url.searchParams.get("code");

  if (!code) {
    return json(res, 400, {
      erro: "O Mercado Livre não enviou o código de autorização."
    });
  }

  if (!bancoPronto || !client) {
    return json(res, 503, {
      erro: "MongoDB indisponível. Confira /status e reinicie a conexão."
    });
  }

  try {
    const config = configuracaoML();

    await client.db("admin").command({ ping: 1 });

    const resposta = await fetch(
      "https://api.mercadolibre.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        signal: AbortSignal.timeout(20000),
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri
        })
      }
    );

    const tokens = await resposta.json().catch(
      () => ({})
    );

    const duracao = Number(tokens.expires_in);

    if (
      !resposta.ok ||
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      typeof tokens.refresh_token !== "string" ||
      !tokens.refresh_token ||
      !tokens.user_id ||
      !Number.isFinite(duracao) ||
      duracao <= 0
    ) {
      return json(res, 502, {
        erro: "Não foi possível obter os tokens. Confira as credenciais, a URI de redirect e o fluxo Refresh Token na aplicação. Depois reinicie a conexão."
      });
    }

    await client
      .db("versaniche")
      .collection("mercadolivre_conexoes")
      .updateOne(
        {
          _id: String(tokens.user_id)
        },
        {
          $set: {
            client_id: config.clientId,
            reconectar: false,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: new Date(
              Date.now() + duracao * 1000
            ),
            atualizado_em: new Date()
          }
        },
        {
          upsert: true
        }
      );

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8"
    });

    return res.end(
      "Mercado Livre autorizado! Tokens salvos no MongoDB. Você já pode fechar esta aba e voltar ao painel."
    );
  } catch {
    return json(res, 502, {
      erro: "Falha ao concluir ou salvar a conexão. Confira o MongoDB e reinicie em /api/mercadolivre/conectar."
    });
  }
}

// Integração de consulta: nenhuma venda, anúncio ou preço é alterado.
let trabalhoML = null;
const renovacoesML = new Map();
const origemPainel = "https://versaniche-vendas.onrender.com";

function erroML(mensagem, status = 502) {
  const erro = new Error(mensagem);
  erro.publico = true;
  erro.status = status;
  return erro;
}

function bancoML() {
  if (!bancoPronto || !client) {
    throw erroML("Banco indisponível. Confira /status e tente novamente.", 503);
  }
  return client.db("versaniche");
}

async function contaML() {
  const contas = await bancoML().collection("mercadolivre_conexoes")
    .find({ client_id: process.env.MELI_CLIENT_ID }).limit(2).toArray();
  if (!contas.length) throw erroML("Autorize a conta do Mercado Livre primeiro.", 409);
  if (contas.length > 1) {
    throw erroML("Há mais de uma conta autorizada. É necessário definir qual conta o painel usará.", 409);
  }
  return contas[0];
}

async function tokenML(conta, rejeitado = null) {
  const chave = String(conta._id);
  if (renovacoesML.has(chave)) return renovacoesML.get(chave);
  const tarefa = (async () => {
    const colecao = bancoML().collection("mercadolivre_conexoes");
    let atual = await colecao.findOne({ _id: conta._id });
    if (!atual || atual.reconectar) {
      throw erroML("Autorize novamente a conta do Mercado Livre.", 409);
    }
    if (atual.access_token &&
        new Date(atual.expires_at).getTime() > Date.now() + 120000 &&
        (!rejeitado || atual.access_token !== rejeitado)) return atual.access_token;

    // Trava também no MongoDB: protege o refresh token entre instâncias.
    const dono = crypto.randomUUID();
    const trava = await colecao.findOneAndUpdate({
      _id: conta._id,
      refresh_token: atual.refresh_token,
      $or: [
        { renovacao_ate: { $exists: false } },
        { renovacao_ate: { $lt: new Date() } }
      ]
    }, { $set: { renovacao_dono: dono, renovacao_ate: new Date(Date.now() + 90000) } },
    { returnDocument: "after", includeResultMetadata: false });
    if (!trava) throw erroML("Acesso sendo renovado. Tente novamente em alguns segundos.", 409);

    let recebeuResposta = false;
    try {
      const config = configuracaoML();
      const resposta = await fetch("https://api.mercadolibre.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(20000),
        body: new URLSearchParams({
          grant_type: "refresh_token", client_id: config.clientId,
          client_secret: config.clientSecret, refresh_token: trava.refresh_token
        })
      });
      const dados = await resposta.json().catch(() => ({}));
      recebeuResposta = true;
      const segundos = Number(dados.expires_in);
      if (!resposta.ok || !dados.access_token || !dados.refresh_token ||
          !Number.isFinite(segundos) || segundos <= 0 ||
          (dados.user_id && String(dados.user_id) !== chave)) {
        if (resposta.status === 400 || resposta.status === 401 || resposta.ok) {
          await colecao.updateOne({ _id: conta._id, renovacao_dono: dono },
            { $set: { reconectar: true } });
        }
        throw erroML("Não foi possível renovar o acesso. Confira a conexão e, se necessário, autorize novamente.");
      }
      // Salva o NOVO refresh token antes de liberar qualquer outra consulta.
      const gravacao = await colecao.updateOne({ _id: conta._id, renovacao_dono: dono }, {
        $set: { access_token: dados.access_token, refresh_token: dados.refresh_token,
          expires_at: new Date(Date.now() + segundos * 1000),
          atualizado_em: new Date(), reconectar: false },
        $unset: { renovacao_dono: "", renovacao_ate: "" }
      });
      if (gravacao.matchedCount !== 1) throw erroML("Não foi possível salvar o acesso renovado. Autorize novamente.");
      return dados.access_token;
    } catch (erro) {
      if (!recebeuResposta || !erro.publico) {
        // Timeout pode ocorrer após o provedor consumir o token: não o reutiliza.
        await colecao.updateOne({ _id: conta._id, renovacao_dono: dono },
          { $set: { reconectar: true } }).catch(() => {});
      }
      throw erro.publico ? erro : erroML("Falha ao renovar ou salvar o acesso. Autorize novamente se persistir.");
    } finally {
      await colecao.updateOne({ _id: conta._id, renovacao_dono: dono },
        { $unset: { renovacao_dono: "", renovacao_ate: "" } }).catch(() => {});
    }
  })();
  renovacoesML.set(chave, tarefa);
  try { return await tarefa; } finally { renovacoesML.delete(chave); }
}

async function consultarML(conta, caminho) {
  let token = await tokenML(conta);
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const resposta = await fetch("https://api.mercadolibre.com" + caminho, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000)
    });
    if (resposta.status === 401 && tentativa === 0) {
      token = await tokenML(conta, token);
      continue;
    }
    if (!resposta.ok) {
      const mensagem = resposta.status === 403
        ? "O Mercado Livre negou a consulta. Confira a permissão de leitura de vendas/envios e autorize novamente."
        : resposta.status === 429
          ? "Limite de consultas do Mercado Livre atingido. Aguarde e tente novamente."
          : "A consulta ao Mercado Livre falhou. Tente novamente mais tarde.";
      throw erroML(mensagem);
    }
    return resposta.json();
  }
  throw erroML("O acesso foi recusado. Autorize novamente a conta.", 409);
}

function normalizarPedido(pedido) {
  if (pedido.id == null || !Number.isFinite(Date.parse(pedido.date_created)) ||
      !Array.isArray(pedido.order_items) || typeof pedido.status !== "string") {
    throw erroML("Um pedido veio em formato inesperado. A importação anterior foi preservada.");
  }
  const itens = pedido.order_items.map((linha) => {
    const quantidade = Number(linha.quantity);
    const preco = Number(linha.unit_price);
    if (!Number.isInteger(quantidade) || quantidade <= 0 ||
        !Number.isFinite(preco) || preco < 0) {
      throw erroML("Valores de um pedido não puderam ser validados. Nenhum indicador foi atualizado.");
    }
    return { titulo: String(linha.item?.title || "Produto").slice(0, 250),
      quantidade, preco_centavos: Math.round(preco * 100) };
  });
  return { id: String(pedido.id), status: pedido.status,
    data: new Date(pedido.date_created).toISOString(),
    moeda: String(pedido.currency_id || ""), itens,
    bruto_centavos: itens.reduce((soma, item) => soma + item.quantidade * item.preco_centavos, 0) };
}

function resumirPedidos(pedidos, inicio, fim) {
  const pagos = pedidos.filter((p) => p.status === "paid" && p.moeda === "BRL");
  return {
    inicio: new Date(inicio).toISOString(), fim: new Date(fim).toISOString(),
    pedidos_total: pedidos.length, pedidos_pagos: pagos.length,
    bruto_centavos: pagos.reduce((soma, p) => soma + p.bruto_centavos, 0),
    outras_moedas: pedidos.filter((p) => p.moeda !== "BRL").length,
    cancelados: pedidos.filter((p) => p.status === "cancelled").length,
    recentes: [...pedidos].sort((a, b) => b.data.localeCompare(a.data)).slice(0, 20),
    atualizado_em: new Date().toISOString(),
    criterio: "Valor bruto dos itens de pedidos com status paid e moeda BRL, criados no período. Sem frete, taxas, custos ou dedução de estornos parciais. Não representa receita líquida."
  };
}

async function importarPedidosML(conta, trabalho) {
  const fim = Date.now();
  const inicio = fim - 30 * 24 * 60 * 60 * 1000;
  const pedidos = new Map();
  let consultas = 0;
  async function pagina(de, ate, offset = 0) {
    if (++consultas > 180 || Date.now() - fim > 240000) {
      throw erroML("A importação excedeu o limite desta versão. Os indicadores anteriores foram preservados.");
    }
    const parametros = new URLSearchParams({ seller: String(conta._id),
      "order.date_created.from": new Date(de).toISOString(),
      "order.date_created.to": new Date(ate).toISOString(),
      sort: "date_asc", limit: "50", offset: String(offset) });
    const dados = await consultarML(conta, "/orders/search?" + parametros);
    if (!Array.isArray(dados.results) || !Number.isInteger(dados.paging?.total) ||
        dados.paging.total < 0) throw erroML("Resposta de pedidos inválida. A importação anterior foi preservada.");
    return dados;
  }
  async function intervalo(de, ate) {
    let dados = await pagina(de, ate);
    // Divide períodos grandes para não ultrapassar o limite de paginação.
    if (dados.paging.total > 9000) {
      if (ate - de < 2) throw erroML("Volume de pedidos acima do limite desta versão.");
      const meio = Math.floor((de + ate) / 2);
      await intervalo(de, meio);
      await intervalo(meio, ate);
      return;
    }
    let offset = 0;
    while (true) {
      if (!dados.results.length && offset < dados.paging.total) {
        throw erroML("A consulta retornou uma página incompleta. Os indicadores anteriores foram preservados.");
      }
      for (const bruto of dados.results) {
        const p = normalizarPedido(bruto);
        if (Date.parse(p.data) >= inicio && Date.parse(p.data) <= fim) pedidos.set(p.id, p);
      }
      trabalho.pedidos = pedidos.size;
      if (pedidos.size > 50000) throw erroML("Volume acima de 50 mil pedidos. Importação anterior preservada.");
      offset += dados.results.length;
      if (offset >= dados.paging.total) break;
      if (offset >= 9000) throw erroML("Os pedidos mudaram durante a consulta. Tente importar novamente.");
      dados = await pagina(de, ate, offset);
    }
  }
  await intervalo(inicio, fim);
  // Só publica após concluir TODAS as páginas. Falhas não viram zeros.
  const resumo = resumirPedidos([...pedidos.values()], inicio, fim);
  await bancoML().collection("mercadolivre_resumos").updateOne(
    { _id: String(conta._id), client_id: process.env.MELI_CLIENT_ID },
    { $set: resumo }, { upsert: true });
  return resumo;
}

async function estadoMercadoLivre(req, res) {
  const conta = await contaML();
  const resumo = await bancoML().collection("mercadolivre_resumos")
    .findOne({ _id: String(conta._id), client_id: process.env.MELI_CLIENT_ID },
      { projection: { _id: 0, client_id: 0 } });
  return json(res, 200, {
    conectado: !conta.reconectar, conta_id: String(conta._id),
    acesso_expirado: !(new Date(conta.expires_at).getTime() > Date.now()),
    resumo, trabalho: trabalhoML && trabalhoML.conta === String(conta._id)
      ? { estado: trabalhoML.estado, pedidos: trabalhoML.pedidos, erro: trabalhoML.erro || null }
      : null
  });
}

async function iniciarImportacaoML(req, res) {
  if (req.headers.origin !== origemPainel) return json(res, 403, { erro: "Origem não autorizada." });
  const conta = await contaML();
  if (conta.reconectar) throw erroML("Autorize novamente a conta antes de importar.", 409);
  if (trabalhoML?.estado === "importando") return json(res, 202, { mensagem: "Importação já em andamento." });
  if (trabalhoML && Date.now() - trabalhoML.inicio < 60000) {
    return json(res, 429, { erro: "Aguarde um minuto entre importações." });
  }
  const trabalho = { conta: String(conta._id), inicio: Date.now(), estado: "importando", pedidos: 0 };
  trabalhoML = trabalho;
  importarPedidosML(conta, trabalho).then(() => {
    trabalho.estado = "concluido";
  }).catch((erro) => {
    trabalho.estado = "erro";
    trabalho.erro = erro.publico ? erro.message : "Falha de comunicação ou banco. Os indicadores anteriores foram preservados.";
  });
  return json(res, 202, { mensagem: "Importação iniciada." });
}

const server = http.createServer(async (req, res) => {
  res.setHeader(
    "Content-Type",
    "text/html; charset=utf-8"
  );
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  if (!adminUser || !adminPassword) {
    res.writeHead(503);
    return res.end(
      "Configure as credenciais do painel no Render."
    );
  }

  if (!autorizado(req)) {
    const agora = Date.now();

    tentativasLogin = tentativasLogin.filter(
      (t) => agora - t < 60000
    );

    if (tentativasLogin.length >= 30) {
      res.writeHead(429, {
        "Retry-After": "60"
      });

      return res.end(
        "Muitas tentativas. Aguarde um minuto."
      );
    }

    tentativasLogin.push(agora);

    res.setHeader(
      "WWW-Authenticate",
      'Basic realm="Versaniche Vendas", charset="UTF-8"'
    );

    res.writeHead(401);

    return res.end(
      "Entre com seu usuário e senha."
    );
  }

  const rota = (req.url || "/").split("?")[0];

  try {
    if (
      req.method === "GET" &&
      ["/", "/painel"].includes(rota)
    ) {
      res.writeHead(200);
      return res.end(painel);
    }

    if (
      req.method === "GET" &&
      rota === "/status"
    ) {
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8"
      });

      return res.end(bancoStatus);
    }

    if (req.method === "GET" && rota === "/api/mercadolivre/status") {
      return await estadoMercadoLivre(req, res);
    }

    if (req.method === "POST" && rota === "/api/mercadolivre/importar") {
      return await iniciarImportacaoML(req, res);
    }

    if (
      req.method === "POST" &&
      rota === "/api/jarvis"
    ) {
      return await conversar(req, res);
    }

    if (
      req.method === "GET" &&
      rota === "/api/mercadolivre/conectar"
    ) {
      return await conectarMercadoLivre(req, res);
    }

    if (
      req.method === "GET" &&
      rota === "/api/mercadolivre/callback"
    ) {
      return await retornoMercadoLivre(req, res);
    }

    res.writeHead(404);
    return res.end("Página não encontrada.");
  } catch (erro) {
    if (!res.headersSent) {
      return json(res, erro.publico ? erro.status : 500, {
        erro: erro.publico ? erro.message : "Erro interno do servidor."
      });
    }

    res.end();
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    `Servidor iniciado na porta ${port}`
  );

  testarBanco();
});
