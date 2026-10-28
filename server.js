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
