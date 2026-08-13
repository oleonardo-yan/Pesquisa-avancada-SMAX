// ==UserScript==
// @name         SMAX APRIMORADO
// @namespace    http://tampermonkey.net/
// @version      1.15.1
// @description  Robo de opcoes automatizadas para o suporte TJSP, com visualizador de anexos (PDF, imagens, DOCX) integrado direto na tela, sem downloads, navegacao entre anexos e painel de dados da solicitacao.
// @author       Leonardo
// @match        https://suporte.tjsp.jus.br/*
// @require      https://unpkg.com/mammoth@1.6.0/mammoth.browser.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/oleonardo-yan/smax-automatizado/main/meu-script.user.js
// @updateURL    https://raw.githubusercontent.com/oleonardo-yan/smax-automatizado/main/meu-script.user.js
// ==/UserScript==

(function () {
    "use strict";

    // Desativado temporariamente para revisao futura (icone do robo / "Informar
    // recebimento do chamado"). Trocar para true reativa sem precisar mexer em
    // mais nada.
    var ROBO_OPCOES_HABILITADO = false;

    var STORAGE_ETAPA = "tjsp_auto_etapa_recebimento";
    var STORAGE_PRIMEIRO_NOME = "tjsp_auto_primeiro_nome_solicitante";
    var ETAPA_CAPTURAR_NOME_NA_GERAL = "capturar_nome_na_geral";
    var ETAPA_EXECUTAR_NA_DISCUSSAO = "executar_na_discussao";
    var VALOR_PARA_USUARIO = "User";
    var VALOR_OBJETIVO_ATUALIZACAO = "StatusUpdate";
    var HASH_DESTAQUE_ABERTURA = "tjspAutoAbertoPesquisa";

    // Assinaturas cadastradas pelo proprio usuario (texto livre, sem nenhum
    // conteudo nativo pre-carregado) — sessionStorage de proposito: sobrevive a
    // F5, mas some ao fechar a aba/navegador.
    var STORAGE_ASSINATURAS_USUARIO = "tjsp_auto_assinaturas_usuario";
    var TITULO_PREFIXO_CONSULTA = "🔵 ";
    var fluxoEmAndamento = false;
    var contadorToolbar = 0;
    var intervaloDestaqueGuia = null;

    var TRATAMENTO_POR_NOME = {
        "maria":"f","ana":"f","julia":"f","juliana":"f","mariana":"f","patricia":"f","fernanda":"f","carla":"f","camila":"f","bruna":"f","renata":"f","luciana":"f","adriana":"f","marina":"f","vivian":"f","viviane":"f",
        "joao":"m","jose":"m","antonio":"m","carlos":"m","paulo":"m","pedro":"m","lucas":"m","leonardo":"m","marcos":"m","ricardo":"m","roberto":"m","fernando":"m","rafael":"m"
    };

    function criarEvento(tipo) {
        try { var ev = document.createEvent("Event"); ev.initEvent(tipo, true, true); return ev; }
        catch (e) { try { return new Event(tipo, { bubbles: true, cancelable: true }); } catch (erro) { return null; } }
    }

    function dispararEventos(el) {
        var lista = ["input", "change", "keyup", "keydown", "blur"], i, ev;
        if (!el) { return; }
        for (i = 0; i < lista.length; i++) { ev = criarEvento(lista[i]); if (ev) { el.dispatchEvent(ev); } }
    }

    function sleep(ms) { return new Promise(function (resolve) { window.setTimeout(resolve, ms); }); }

    function waitForCondition(fn, timeoutMs, intervalMs) {
        var start = Date.now(); timeoutMs = timeoutMs || 10000; intervalMs = intervalMs || 300;
        return new Promise(function (resolve) {
            function check() {
                var ok = false;
                try { ok = !!fn(); } catch (e) { ok = false; }
                if (ok) { resolve(true); return; }
                if (Date.now() - start >= timeoutMs) { resolve(false); return; }
                window.setTimeout(check, intervalMs);
            }
            check();
        });
    }

    function normalizarTexto(txt) {
        var texto = txt || "";
        try { texto = texto.normalize("NFD").replace(/[\u0300-\u036f]/g, ""); } catch (e) {}
        return texto.replace(/\s+/g, " ").trim().toLowerCase();
    }

    function tituloNome(nome) {
        var partes = String(nome || "").toLowerCase().split(/\s+/), res = [], i, p;
        for (i = 0; i < partes.length; i++) { p = partes[i]; if (p) { res.push(p.charAt(0).toUpperCase() + p.slice(1)); } }
        return res.join(" ");
    }

    function elementoVisivel(el) {
        if (!el) { return false; }
        var r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    }

    function gerarDadosUrlRequest() {
        var m = location.pathname.match(/\/saw\/Request\/\d+/i);
        return m ? { base: location.origin + m[0], query: location.search || "" } : null;
    }
    function gerarUrlGeral() { var d = gerarDadosUrlRequest(); return d ? d.base + "/general" + d.query : ""; }
    function gerarUrlDiscussoes() { var d = gerarDadosUrlRequest(); return d ? d.base + "/discussions" + d.query : ""; }
    function estaEmTelaDeChamado() { return /\/saw\/Request\/\d+/i.test(location.pathname); }

    function estaNaAbaGeral() {
        var url = location.href.toLowerCase(), campoUsuario;
        if (url.indexOf("/general") >= 0 || document.querySelector("#tab-0.active")) { return true; }
        campoUsuario = document.querySelector("input[name='Usuario_c'], input[id$='_Usuario_c']");
        return !!campoUsuario && elementoVisivel(campoUsuario);
    }

    function estaNaAbaDiscussoes() {
        return location.href.toLowerCase().indexOf("/discussions") >= 0 || !!document.querySelector("#tab-8.active");
    }

    function limparNomeSolicitante(raw) {
        var nome, partes, validas = [], i;
        if (!raw) { return ""; }
        nome = String(raw).replace(/\s+/g, " ").replace(/\([^)]*\)/g, "").replace(/<[^>]+>/g, "").replace(/[:*]/g, "").trim();
        if (nome.indexOf("@") >= 0) { nome = nome.split("@")[0].replace(/[._-]+/g, " "); }
        nome = nome.split("|")[0].split("/")[0].trim();
        partes = nome.split(/\s+/);
        for (i = 0; i < partes.length; i++) { if (/^[A-Za-z\u00C0-\u00FF]{2,}$/.test(partes[i])) { validas.push(partes[i]); } }
        return validas.join(" ");
    }

    function obterPrimeiroNomeUsuarioNaGeral() {
        var seletores = ["input[name='Usuario_c']", "input[id$='_Usuario_c']"], i, campo, nomeLimpo, primeiroNome;
        if (!estaNaAbaGeral()) { return ""; }
        for (i = 0; i < seletores.length; i++) {
            campo = document.querySelector(seletores[i]);
            if (campo && campo.value && campo.value.trim()) {
                nomeLimpo = limparNomeSolicitante(campo.value);
                primeiroNome = nomeLimpo.split(/\s+/)[0];
                if (primeiroNome) { return tituloNome(primeiroNome); }
            }
        }
        return "";
    }

    function montarSaudacao() {
        var primeiroNome = sessionStorage.getItem(STORAGE_PRIMEIRO_NOME) || "", nomeNorm, tratamento;
        if (!primeiroNome) { return "Prezado(a) usuario(a),"; }
        nomeNorm = normalizarTexto(primeiroNome); tratamento = TRATAMENTO_POR_NOME[nomeNorm];
        if (tratamento === "f") { return "Prezada senhora " + primeiroNome + ","; }
        if (tratamento === "m") { return "Prezado senhor " + primeiroNome + ","; }
        return "Prezado(a) " + primeiroNome + ",";
    }

    function montarTextoPadrao() {
        // Rotulo fixo aqui de proposito: esta funcao so e usada pelo fluxo
        // automatizado de "Informar recebimento" (ROBO_OPCOES_HABILITADO = false,
        // desativado), que e independente do sistema de assinaturas cadastraveis
        // pelo usuario (esse so vale pros botoes do editor).
        return { textoHtml: [
            "<p>", montarSaudacao(), "</p>",
            "<p>Informamos que a solicita&ccedil;&atilde;o foi recebida e est&aacute; sendo analisada por este suporte com a devida prioridade.</p>",
            "<p>As atualiza&ccedil;&otilde;es ser&atilde;o comunicadas por este canal.</p>",
            "<p>Atenciosamente, SGS 2.2.1</p>"
        ].join("") };
    }

    function selecionarSelectNativo(select, valor) {
        var opcoes, existe = false, i;
        if (!select) { return false; }
        opcoes = Array.prototype.slice.call(select.options || []);
        for (i = 0; i < opcoes.length; i++) { if (opcoes[i].value === valor) { existe = true; break; } }
        if (!existe) { return false; }
        select.value = valor;
        if (window.jQuery) { try { window.jQuery(select).val(valor).trigger("change"); } catch (e) {} }
        dispararEventos(select);
        return select.value === valor;
    }

    function localizarContainerComentarioAtual() { return document.querySelector(".comment-item.currentUserComment") || document.querySelector(".currentUserComment"); }
    function localizarSelectPara() { var c = localizarContainerComentarioAtual(); return c ? c.querySelector("select[ng-model='newComment.CommentTo']") : null; }
    function localizarSelectObjetivo() { var c = localizarContainerComentarioAtual(); return c ? c.querySelector("select[ng-model='newComment.FunctionalPurpose']") : null; }

    function localizarEditorDiscussao() {
        var c = localizarContainerComentarioAtual();
        return c ? c.querySelector("[contenteditable='true'].cke_wysiwyg_div, [contenteditable='true'][role='textbox'], .cke_wysiwyg_div[contenteditable='true']") : null;
    }

    function localizarEditorGeralSolucao() {
        var editores, i, editor;
        if (!estaNaAbaGeral()) { return null; }
        editores = document.querySelectorAll("[contenteditable='true'].cke_wysiwyg_div, [contenteditable='true'][role='textbox'], .cke_wysiwyg_div[contenteditable='true']");
        for (i = 0; i < editores.length; i++) {
            editor = editores[i];
            if (editor.getAttribute("aria-label") === "Solução" && elementoVisivel(editor)) { return editor; }
        }
        return null;
    }

    function localizarEditorOperacional() {
        var editor;
        if (estaNaAbaDiscussoes()) { editor = localizarEditorDiscussao(); if (editor) { return editor; } }
        if (estaNaAbaGeral()) { editor = localizarEditorGeralSolucao(); if (editor) { return editor; } }
        return null;
    }

    function obterInstanciaCKEditorDoEditor(editor) {
        var nome, instance, editable;
        if (!editor || !window.CKEDITOR || !window.CKEDITOR.instances) { return null; }
        try {
            for (nome in window.CKEDITOR.instances) {
                if (Object.prototype.hasOwnProperty.call(window.CKEDITOR.instances, nome)) {
                    instance = window.CKEDITOR.instances[nome]; editable = instance.editable && instance.editable();
                    if (editable && editable.$ === editor) { return instance; }
                }
            }
        } catch (e) {}
        return null;
    }

    function sincronizarEditor(editor) {
        var instance;
        if (!editor) { return; }
        dispararEventos(editor);
        instance = obterInstanciaCKEditorDoEditor(editor);
        if (instance) { try { if (instance.updateElement) { instance.updateElement(); } instance.fire("change"); } catch (e) {} }
    }

    // ============================================================
    // ASSINATURAS DO USUARIO — texto livre cadastrado pelo proprio usuario
    // ============================================================
    function obterAssinaturasUsuario() {
        var bruto, lista;
        try {
            bruto = sessionStorage.getItem(STORAGE_ASSINATURAS_USUARIO);
            lista = bruto ? JSON.parse(bruto) : [];
            return Array.isArray(lista) ? lista : [];
        } catch (e) { return []; }
    }

    function salvarAssinaturasUsuario(lista) {
        try { sessionStorage.setItem(STORAGE_ASSINATURAS_USUARIO, JSON.stringify(lista)); } catch (e) {}
    }

    function gerarIdAssinatura() {
        return "sig-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    // Cada linha do texto digitado vira um paragrafo — o usuario nao precisa
    // saber HTML, so escreve o texto como quer que apareca na resposta.
    function converterTextoParaHtmlAssinatura(texto) {
        var linhas = String(texto || "").replace(/\r\n/g, "\n").split("\n"), partes = [], i, linha;
        for (i = 0; i < linhas.length; i++) {
            linha = linhas[i];
            partes.push("<p>" + (linha.trim() ? escapeHtmlConsulta(linha) : "&nbsp;") + "</p>");
        }
        return partes.join("");
    }

    function criarSvgEngrenagem() {
        return ["<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'>", "<circle cx='12' cy='12' r='3' stroke-width='2'/>", "<path d='M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.7 7.7 0 0 0-2.6-1.5L14 2h-4l-.4 2.5a7.7 7.7 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.7 7.7 0 0 0 2.6 1.5L10 22h4l.4-2.5a7.7 7.7 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5z' stroke-width='1.6' stroke-linejoin='round'/>", "</svg>"].join("");
    }

    function criarEstiloAssinaturas() {
        var style;
        if (document.getElementById("tjsp-assinaturas-style")) { return; }
        style = document.createElement("style"); style.id = "tjsp-assinaturas-style";
        style.textContent = [
            "#tjsp-assinaturas-overlay{position:fixed;inset:0;background:rgba(10,20,35,.55);z-index:2000000;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif}",
            "#tjsp-assinaturas-modal{background:#fff;border-radius:12px;width:420px;max-width:92vw;max-height:86vh;box-shadow:0 20px 50px rgba(0,0,0,.4);overflow:hidden;display:flex;flex-direction:column}",
            "#tjsp-assinaturas-header{background:linear-gradient(135deg,#005a9e,#0078d4);color:#fff;padding:14px 18px;font-size:15px;font-weight:700;flex-shrink:0}",
            "#tjsp-assinaturas-corpo{padding:18px;overflow:auto}",
            "#tjsp-assinaturas-aviso-vazio{font-size:12.5px;color:#48586b;line-height:1.5;background:#eaf4fd;border:1px solid #cfe4f7;border-radius:8px;padding:12px 14px;margin-bottom:14px}",
            ".tjsp-assinaturas-item{display:flex;align-items:center;gap:8px;border:1px solid #e3eaf0;border-radius:8px;padding:10px 12px;margin-bottom:10px}",
            ".tjsp-assinaturas-item:last-child{margin-bottom:0}",
            ".tjsp-assinaturas-item-texto{flex:1;min-width:0}",
            ".tjsp-assinaturas-item-nome{font-size:13px;font-weight:700;color:#222;display:block}",
            ".tjsp-assinaturas-item-preview{font-size:11.5px;color:#7a8b9b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block;margin-top:2px}",
            ".tjsp-assinaturas-item-acoes{display:flex;gap:6px;flex-shrink:0}",
            ".tjsp-assinaturas-item-acoes button{border:0;border-radius:6px;cursor:pointer;font-size:12px;padding:7px 10px}",
            ".tjsp-assinaturas-btn-usar{background:linear-gradient(135deg,#005a9e,#0078d4);color:#fff;font-weight:700}",
            ".tjsp-assinaturas-btn-usar:hover{filter:brightness(1.08)}",
            ".tjsp-assinaturas-btn-editar,.tjsp-assinaturas-btn-excluir{background:#eef1f5;color:#444}",
            ".tjsp-assinaturas-btn-editar:hover{background:#e2e7ed}",
            ".tjsp-assinaturas-btn-excluir:hover{background:#ffe1df;color:#a11f19}",
            "#tjsp-assinaturas-corpo label{display:block;font-size:12px;font-weight:700;color:#333;margin-bottom:5px;margin-top:12px}",
            "#tjsp-assinaturas-corpo label:first-child{margin-top:0}",
            "#tjsp-assinaturas-corpo input[type=text],#tjsp-assinaturas-corpo textarea{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #c7d2e0;border-radius:7px;font-size:13px;color:#222;font-family:inherit}",
            "#tjsp-assinaturas-corpo textarea{resize:vertical;min-height:110px;line-height:1.4}",
            "#tjsp-assinaturas-corpo input[type=text]:focus,#tjsp-assinaturas-corpo textarea:focus{outline:none;border-color:#0078d4;box-shadow:0 0 0 3px rgba(0,120,212,.18)}",
            "#tjsp-assinaturas-rodape{display:flex;gap:8px;padding:14px 18px;background:#f5f7fa;border-top:1px solid #e5e7eb;flex-shrink:0}",
            "#tjsp-assinaturas-rodape button{flex:1;padding:9px 12px;border-radius:7px;border:0;font-size:13px;font-weight:700;cursor:pointer}",
            ".tjsp-assinaturas-btn-primario{background:linear-gradient(135deg,#005a9e,#0078d4);color:#fff}",
            ".tjsp-assinaturas-btn-primario:hover{filter:brightness(1.08)}",
            ".tjsp-assinaturas-btn-secundario{background:#e9edf2;color:#333}",
            ".tjsp-assinaturas-btn-secundario:hover{background:#dde3ea}"
        ].join("\n");
        document.head.appendChild(style);
    }

    // editor: se informado, cada assinatura da lista ganha um botao "Usar" que
    // insere direto e fecha o modal (fluxo do botao da caneta). Se null, o modal
    // serve so pra gerenciar (criar/editar/excluir) — fluxo do botao da engrenagem.
    function abrirModalAssinaturas(editor) {
        var overlay, modal, header, corpo, rodape, antigo;
        criarEstiloAssinaturas();
        antigo = document.getElementById("tjsp-assinaturas-overlay");
        if (antigo) { antigo.remove(); }

        overlay = document.createElement("div"); overlay.id = "tjsp-assinaturas-overlay";
        modal = document.createElement("div"); modal.id = "tjsp-assinaturas-modal";
        header = document.createElement("div"); header.id = "tjsp-assinaturas-header"; header.textContent = "✍️ Minhas assinaturas";
        corpo = document.createElement("div"); corpo.id = "tjsp-assinaturas-corpo";
        rodape = document.createElement("div"); rodape.id = "tjsp-assinaturas-rodape";
        modal.appendChild(header); modal.appendChild(corpo); modal.appendChild(rodape);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        function fechar() { overlay.remove(); }
        overlay.addEventListener("click", function (event) { if (event.target === overlay) { fechar(); } });

        function renderizarLista() {
            var lista = obterAssinaturasUsuario(), html = "", i, item;
            if (!lista.length) {
                html += "<div id='tjsp-assinaturas-aviso-vazio'>Você ainda não tem nenhuma assinatura cadastrada. Cadastre o texto que quer poder inserir com um clique nas suas respostas — pode cadastrar quantas quiser.</div>";
            }
            for (i = 0; i < lista.length; i++) {
                item = lista[i];
                html += "<div class='tjsp-assinaturas-item' data-id='" + item.id + "'>" +
                    "<div class='tjsp-assinaturas-item-texto'>" +
                        "<span class='tjsp-assinaturas-item-nome'>" + escapeHtmlConsulta(item.nome) + "</span>" +
                        "<span class='tjsp-assinaturas-item-preview'>" + escapeHtmlConsulta((item.texto || "").split("\n")[0]) + "</span>" +
                    "</div>" +
                    "<div class='tjsp-assinaturas-item-acoes'>" +
                    (editor ? "<button type='button' class='tjsp-assinaturas-btn-usar' data-acao='usar'>Usar</button>" : "") +
                    "<button type='button' class='tjsp-assinaturas-btn-editar' data-acao='editar' title='Editar'>✏️</button>" +
                    "<button type='button' class='tjsp-assinaturas-btn-excluir' data-acao='excluir' title='Excluir'>🗑️</button>" +
                    "</div></div>";
            }
            corpo.innerHTML = html;
            rodape.innerHTML = "<button type='button' id='tjsp-assinaturas-nova' class='tjsp-assinaturas-btn-primario'>+ Nova assinatura</button>" +
                "<button type='button' id='tjsp-assinaturas-fechar' class='tjsp-assinaturas-btn-secundario'>Fechar</button>";

            Array.prototype.forEach.call(corpo.querySelectorAll(".tjsp-assinaturas-item"), function (el) {
                var id = el.getAttribute("data-id");
                var btnUsar = el.querySelector("[data-acao='usar']");
                var btnEditar = el.querySelector("[data-acao='editar']");
                var btnExcluir = el.querySelector("[data-acao='excluir']");
                if (btnUsar) {
                    btnUsar.addEventListener("click", function () {
                        var alvo = obterAssinaturasUsuario().filter(function (a) { return a.id === id; })[0];
                        fechar();
                        if (alvo) { inserirAssinaturaEspecifica(editor, alvo); }
                    });
                }
                btnEditar.addEventListener("click", function () {
                    var alvo = obterAssinaturasUsuario().filter(function (a) { return a.id === id; })[0];
                    if (alvo) { renderizarFormulario(alvo); }
                });
                btnExcluir.addEventListener("click", function () {
                    salvarAssinaturasUsuario(obterAssinaturasUsuario().filter(function (a) { return a.id !== id; }));
                    renderizarLista();
                });
            });

            document.getElementById("tjsp-assinaturas-nova").addEventListener("click", function () { renderizarFormulario(null); });
            document.getElementById("tjsp-assinaturas-fechar").addEventListener("click", fechar);
        }

        function renderizarFormulario(existente) {
            var avisoPrimeiraVez = !existente && !obterAssinaturasUsuario().length, nomeInput, textoArea;
            corpo.innerHTML =
                (avisoPrimeiraVez ? "<div id='tjsp-assinaturas-aviso-vazio'>Primeira assinatura: dê um nome pra ela e digite o texto como quer que apareça na resposta — cada linha vira um parágrafo.</div>" : "") +
                "<label for='tjsp-assinaturas-nome'>Nome da assinatura</label>" +
                "<input type='text' id='tjsp-assinaturas-nome' placeholder='Ex.: Padrão, Encerramento rápido...' autocomplete='off'>" +
                "<label for='tjsp-assinaturas-texto'>Texto</label>" +
                "<textarea id='tjsp-assinaturas-texto' placeholder='Digite o texto da assinatura...'></textarea>";
            rodape.innerHTML = "<button type='button' id='tjsp-assinaturas-form-cancelar' class='tjsp-assinaturas-btn-secundario'>Cancelar</button>" +
                "<button type='button' id='tjsp-assinaturas-form-salvar' class='tjsp-assinaturas-btn-primario'>Salvar</button>";

            nomeInput = document.getElementById("tjsp-assinaturas-nome");
            textoArea = document.getElementById("tjsp-assinaturas-texto");
            if (existente) { nomeInput.value = existente.nome || ""; textoArea.value = existente.texto || ""; }
            window.setTimeout(function () { nomeInput.focus(); }, 0);

            document.getElementById("tjsp-assinaturas-form-cancelar").addEventListener("click", function () {
                if (obterAssinaturasUsuario().length) { renderizarLista(); } else { fechar(); }
            });

            document.getElementById("tjsp-assinaturas-form-salvar").addEventListener("click", function () {
                var nome = (nomeInput.value || "").trim(), texto = (textoArea.value || "").trim(), lista2;
                if (!nome) { nomeInput.style.borderColor = "#c62828"; nomeInput.focus(); return; }
                if (!texto) { textoArea.style.borderColor = "#c62828"; textoArea.focus(); return; }
                lista2 = obterAssinaturasUsuario();
                if (existente) {
                    lista2 = lista2.map(function (a) { return a.id === existente.id ? { id: a.id, nome: nome, texto: texto } : a; });
                } else {
                    lista2.push({ id: gerarIdAssinatura(), nome: nome, texto: texto });
                }
                salvarAssinaturasUsuario(lista2);
                renderizarLista();
            });
        }

        if (editor && !obterAssinaturasUsuario().length) { renderizarFormulario(null); } else { renderizarLista(); }
    }

    function removerBlocosVaziosNoFinal(editor) {
        var ultimo, tag, semConteudo;
        while (editor.lastChild) {
            ultimo = editor.lastChild;
            if (ultimo.nodeType === 3) {
                if (!ultimo.nodeValue || !ultimo.nodeValue.replace(/[\s ]/g, "")) { editor.removeChild(ultimo); continue; }
                break;
            }
            if (ultimo.nodeType === 1) {
                tag = ultimo.tagName;
                if (tag === "BR") { editor.removeChild(ultimo); continue; }
                if (tag === "P" || tag === "DIV") {
                    semConteudo = !ultimo.querySelector("img, table, video, canvas, svg, iframe, input, select, textarea") && !(ultimo.textContent || "").replace(/[\s ]/g, "");
                    if (semConteudo) { editor.removeChild(ultimo); continue; }
                }
            }
            break;
        }
    }

    function inserirAssinaturaEspecifica(editor, assinatura) {
        if (!editor || !assinatura) { return false; }
        editor.focus();
        // Anexa a assinatura como nos NOVOS no final (insertAdjacentHTML), sem tocar
        // nos nos existentes. Reatribuir editor.innerHTML inteiro destroi e recria
        // todo mundo, inclusive as imagens ja formatadas pelo botao de borda — que
        // sao "widgets" do CKEditor com um registro interno proprio (fora do DOM)
        // ligando o elemento na tela ao objeto do editor. Recriar o elemento quebra
        // essa ligacao, e o CKEditor passa a nao reconhecer mais aquele conteudo como
        // valido ao gerar o HTML final pra salvar — foi isso que fazia a assinatura
        // (ou a propria imagem) sumir depois de salvar a solicitacao.
        removerBlocosVaziosNoFinal(editor);
        editor.insertAdjacentHTML("beforeend", converterTextoParaHtmlAssinatura(assinatura.texto));
        sincronizarEditor(editor);
        return true;
    }

    function inserirAssinaturaNoEditor(editor) {
        var assinaturas;
        if (!editor) { return false; }
        assinaturas = obterAssinaturasUsuario();
        // Com exatamente uma cadastrada, insere direto (um clique, como antes). Sem
        // nenhuma ou com duas ou mais, abre o gerenciador — pra cadastrar a primeira
        // ou pra escolher qual das varias usar.
        if (assinaturas.length === 1) { return inserirAssinaturaEspecifica(editor, assinaturas[0]); }
        abrirModalAssinaturas(editor);
        return false;
    }

    function ocultarMarcadoresResizeImagem(img) {
        var editor, cke, marcadores, i;
        if (!img) { return; }
        editor = img.closest("[contenteditable='true']"); if (!editor) { return; }
        cke = editor.closest(".cke") || editor;
        marcadores = cke.querySelectorAll(".cke_image_resizer,.cke_widget_drag_handler_container,[data-cke-widget-resizer],.cke_widget_wrapper .cke_image_resizer,.cke_widget_selected .cke_image_resizer");
        for (i = 0; i < marcadores.length; i++) {
            marcadores[i].style.setProperty("display", "none", "important");
            marcadores[i].style.setProperty("visibility", "hidden", "important");
            marcadores[i].style.setProperty("opacity", "0", "important");
            marcadores[i].style.setProperty("width", "0", "important");
            marcadores[i].style.setProperty("height", "0", "important");
            marcadores[i].style.setProperty("border", "0", "important");
            marcadores[i].style.setProperty("padding", "0", "important");
            marcadores[i].style.setProperty("margin", "0", "important");
        }
    }

    function ocultarLegendaVaziaImagem(img) {
        var figure, legenda, textoLegenda;
        if (!img) { return; }
        figure = img.closest("figure.image, figure.cke_widget_wrapper, figure");
        if (!figure) { return; }
        legenda = figure.querySelector("figcaption");
        if (!legenda) { return; }
        textoLegenda = (legenda.textContent || "").replace(/ /g, " ").trim();
        if (!textoLegenda) { legenda.style.setProperty("display", "none", "important"); }
        else { legenda.style.removeProperty("display"); }
    }

    function observarArtefatosImagem(img) {
        var wrapper, observer;
        if (!img || img.getAttribute("data-tjsp-artefatos-observados")) { return; }
        wrapper = img.closest(".cke_widget_wrapper") || img.parentNode;
        if (!wrapper) { return; }
        img.setAttribute("data-tjsp-artefatos-observados", "1");
        // O CKEditor recria/reexibe o "puxador" de redimensionar e a legenda vazia
        // do widget de imagem toda vez que a imagem e selecionada/focada de novo
        // (sao elementos novos, nao os mesmos que ja ocultamos uma vez no clique
        // do botao "Formatar resposta") — por isso precisamos reagir a cada
        // mudanca no wrapper, e nao so ocultar uma unica vez.
        observer = new MutationObserver(function () {
            ocultarMarcadoresResizeImagem(img);
            ocultarLegendaVaziaImagem(img);
        });
        observer.observe(wrapper, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
    }

    function aplicarBordaImagem(img) {
        if (!img) { return; }
        img.classList.add("tjsp-auto-imagem-formatada");
        img.style.border = "4px solid #004b8d"; img.style.borderRadius = "4px"; img.style.boxSizing = "border-box";
        img.style.padding = "0"; img.style.marginTop = "10px"; img.style.marginBottom = "10px";
        img.style.outline = "none"; img.style.boxShadow = "none";
        ocultarMarcadoresResizeImagem(img);
        ocultarLegendaVaziaImagem(img);
        observarArtefatosImagem(img);
    }

    function formatarImagensNoEditor(editor, exibirAlerta) {
        var imagens, i;
        if (!editor) { return false; }
        imagens = editor.querySelectorAll("img");
        if (!imagens.length) { if (exibirAlerta) { alert("Nenhuma imagem foi encontrada no editor atual."); } return false; }
        for (i = 0; i < imagens.length; i++) { aplicarBordaImagem(imagens[i]); }
        sincronizarEditor(editor);
        return true;
    }

    function normalizarEspacosTextoPreservandoWidgets(editor) {
        var doc = editor.ownerDocument || document, walker, no, novoValor, alterou = false;
        walker = doc.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null, false);
        while ((no = walker.nextNode())) {
            if (no.nodeValue && no.nodeValue.indexOf("\u00A0") >= 0) {
                novoValor = no.nodeValue.replace(/\u00A0/g, " ");
                if (novoValor !== no.nodeValue) { no.nodeValue = novoValor; alterou = true; }
            }
        }
        return alterou;
    }

    function irmaosSeparadosSoPorEspaco(a, b) {
        var no = a.nextSibling;
        while (no && no !== b) {
            if (no.nodeType !== 3 || (no.nodeValue || "").replace(/[\s\u00A0]/g, "")) { return false; }
            no = no.nextSibling;
        }
        return no === b;
    }

    function colapsarBrsConsecutivos(editor) {
        var brs = Array.prototype.slice.call(editor.querySelectorAll("br")), i = 0, run, j, k, alterou = false;
        while (i < brs.length) {
            run = [brs[i]]; j = i + 1;
            while (j < brs.length && irmaosSeparadosSoPorEspaco(run[run.length - 1], brs[j])) { run.push(brs[j]); j++; }
            if (run.length >= 3) {
                for (k = 2; k < run.length; k++) { run[k].parentNode.removeChild(run[k]); alterou = true; }
            }
            i = j;
        }
        return alterou;
    }

    function noVazioDeBorda(no) {
        if (!no) { return false; }
        if (no.nodeType === 3) { return !(no.nodeValue || "").replace(/[\s\u00A0]/g, ""); }
        if (no.nodeType === 1) { return no.tagName === "BR"; }
        return false;
    }

    function removerBordasVaziasNoInicioEFim(editor) {
        var alterou = false, mudou;
        do {
            mudou = false;
            if (noVazioDeBorda(editor.firstChild)) { editor.removeChild(editor.firstChild); mudou = true; alterou = true; }
            if (noVazioDeBorda(editor.lastChild)) { editor.removeChild(editor.lastChild); mudou = true; alterou = true; }
        } while (mudou);
        return alterou;
    }

    function normalizarConteudoTextoNoEditor(editor) {
        var blocos, i, el, texto, temConteudoPreservado, alterou = false;
        if (!editor) { return false; }
        blocos = editor.querySelectorAll("p, div");
        for (i = blocos.length - 1; i >= 0; i--) {
            el = blocos[i]; texto = (el.textContent || "").replace(/\u00A0/g, " ").trim();
            temConteudoPreservado = !!el.querySelector("img, table, video, canvas, svg, iframe, input, select, textarea");
            if (!texto && !temConteudoPreservado) { el.parentNode.removeChild(el); alterou = true; }
        }
        blocos = editor.querySelectorAll("p, div");
        for (i = 0; i < blocos.length; i++) {
            el = blocos[i]; el.style.marginTop = "0"; el.style.marginBottom = "10px";
            el.style.paddingTop = "0"; el.style.paddingBottom = "0"; el.style.lineHeight = "1.35"; alterou = true;
        }
        blocos = editor.querySelectorAll("li");
        for (i = 0; i < blocos.length; i++) {
            el = blocos[i]; el.style.marginTop = "0"; el.style.marginBottom = "4px";
            el.style.paddingTop = "0"; el.style.paddingBottom = "0"; el.style.lineHeight = "1.35"; alterou = true;
        }
        // Sem reatribuir editor.innerHTML aqui (ver comentario em
        // inserirAssinaturaEspecifica): as limpezas abaixo mexem so em nos de texto e
        // <br>, nunca recriam a estrutura de widget das imagens ja formatadas.
        if (normalizarEspacosTextoPreservandoWidgets(editor)) { alterou = true; }
        if (colapsarBrsConsecutivos(editor)) { alterou = true; }
        if (removerBordasVaziasNoInicioEFim(editor)) { alterou = true; }
        if (alterou) { sincronizarEditor(editor); }
        return alterou;
    }

    function formatarConteudoNoEditor(editor) {
        var textoAlterado, imagensAlteradas;
        if (!editor) { return false; }
        imagensAlteradas = formatarImagensNoEditor(editor, false);
        textoAlterado = normalizarConteudoTextoNoEditor(editor);
        sincronizarEditor(editor);
        return imagensAlteradas || textoAlterado;
    }

    function formatarImagensEditor() {
        var editor = localizarEditorOperacional();
        if (!editor) { alert(["Nao encontrei o editor adequado para formatar a resposta.", "", "Na aba Geral, use o campo Solução.", "Na aba Discussões, abra a área de comentário."].join("\n")); return false; }
        return formatarConteudoNoEditor(editor);
    }

    function editorEhOperacional(editor) {
        if (!editor || !elementoVisivel(editor)) { return false; }
        if (editor.getAttribute("aria-label") === "Solução") { return true; }
        // Antes dependia de container.contains(editor), onde container vinha de
        // ".currentUserComment" (document.querySelector, que so pega o PRIMEIRO
        // elemento com essa classe). Se o chamado ja tem comentario antigo seu no
        // historico e o SMAX reusa essa mesma classe pra destaca-lo, essa consulta
        // pegava o comentario antigo (que nao contem o editor ativo) em vez da
        // caixa do novo comentario — os botoes simplesmente nunca eram instalados
        // nesse chamado. Comentarios ja postados no historico nao sao editaveis
        // (so a caixa do comentario sendo escrito agora tem contenteditable=true),
        // entao basta confirmar que estamos na aba Discussoes.
        return estaNaAbaDiscussoes();
    }

    function localizarBarraDoEditor(editor) {
        var cke;
        if (!editor) { return null; }
        cke = editor.closest(".cke"); if (!cke) { return null; }
        return cke.querySelector(".cke_top .cke_toolbox") || cke.querySelector(".cke_toolbox") || cke.querySelector(".cke_top");
    }

    function criarSvgCaneta() {
        return ["<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'>", "<path d='M4 20h4.6L19.2 9.4a2.2 2.2 0 0 0 0-3.1L17.7 4.8a2.2 2.2 0 0 0-3.1 0L4 15.4V20z' stroke-width='2' stroke-linejoin='round'/>", "<path d='M13.8 5.8l4.4 4.4' stroke-width='2' stroke-linecap='round'/>", "<path d='M4 20l4.2-1.1' stroke-width='2' stroke-linecap='round'/>", "</svg>"].join("");
    }

    function criarSvgImagem() {
        return ["<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'>", "<rect x='3.8' y='5' width='16.4' height='14' rx='2.2' stroke-width='2'/>", "<circle cx='8.6' cy='9.4' r='1.45' stroke-width='1.8'/>", "<path d='M5.4 17l5-5 3.1 3.1 2-2L18.8 17' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/>", "</svg>"].join("");
    }

    function criarSvgCopiar() {
        return "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'><rect x='9' y='9' width='11' height='11' rx='2' stroke-width='1.8'/><path d='M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1' stroke-width='1.8' stroke-linecap='round'/></svg>";
    }

    function aplicarEstiloInlineBotaoToolbar(el, classeExtra) {
        el.style.setProperty("width", "30px", "important"); el.style.setProperty("height", "30px", "important");
        el.style.setProperty("min-width", "30px", "important"); el.style.setProperty("min-height", "30px", "important");
        el.style.setProperty("padding", "0", "important"); el.style.setProperty("border", "1px solid #005a9e", "important");
        el.style.setProperty("border-radius", "8px", "important"); el.style.setProperty("cursor", "pointer", "important");
        el.style.setProperty("display", "inline-flex", "important"); el.style.setProperty("align-items", "center", "important");
        el.style.setProperty("justify-content", "center", "important"); el.style.setProperty("box-sizing", "border-box", "important");
        el.style.setProperty("opacity", "1", "important"); el.style.setProperty("filter", "none", "important");
        el.style.setProperty("box-shadow", "0 2px 6px rgba(0,90,158,.35), inset 0 1px 0 rgba(255,255,255,.35)", "important");
        if (classeExtra === "tjsp-editor-btn-assinar") { el.style.setProperty("background", "linear-gradient(135deg,#005a9e,#0078d4)", "important"); }
        else { el.style.setProperty("background", "linear-gradient(135deg,#004b8d,#00a2ed)", "important"); }
    }

    function criarBotaoToolbar(svgHtml, titulo, classeExtra, callback) {
        var btn = document.createElement("span");
        btn.className = "tjsp-editor-toolbar-btn " + classeExtra; btn.innerHTML = svgHtml; btn.title = titulo;
        btn.setAttribute("role", "button"); btn.setAttribute("tabindex", "0"); btn.setAttribute("aria-label", titulo);
        aplicarEstiloInlineBotaoToolbar(btn, classeExtra);
        Array.prototype.forEach.call(btn.querySelectorAll("svg"), function (svg) {
            svg.style.setProperty("width", "18px", "important"); svg.style.setProperty("height", "18px", "important");
            svg.style.setProperty("stroke", "#ffffff", "important"); svg.style.setProperty("opacity", "1", "important");
            svg.style.setProperty("filter", "drop-shadow(0 1px 1px rgba(0,0,0,.28))", "important");
        });
        btn.addEventListener("mousedown", function (event) { event.preventDefault(); event.stopPropagation(); });
        btn.addEventListener("mouseenter", function () { btn.style.setProperty("filter", "saturate(1.18) brightness(1.10)", "important"); btn.style.setProperty("transform", "translateY(-1px)", "important"); });
        btn.addEventListener("mouseleave", function () { btn.style.setProperty("filter", "none", "important"); btn.style.setProperty("transform", "translateY(0)", "important"); });
        btn.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); callback(); } });
        btn.addEventListener("click", function (event) { event.preventDefault(); event.stopPropagation(); callback(); });
        return btn;
    }

    function instalarBotoesNoEditor(editor) {
        var barra, grupo, id, idExistente, grupoExistente;
        if (!editorEhOperacional(editor)) { return; }
        barra = localizarBarraDoEditor(editor);
        if (!barra) {
            // Diagnostico pra caso os botoes ainda sumam intermitentemente depois do
            // fix em editorEhOperacional: se for isso, este log aparece no Console
            // (F12) na aba/editor problematico e diz exatamente onde parou.
            console.warn("[TJSP] instalarBotoesNoEditor: editor operacional mas sem .cke ancestral (barra de ferramentas nao encontrada) — aria-label=" + editor.getAttribute("aria-label"));
            return;
        }

        idExistente = editor.getAttribute("data-tjsp-toolbar-id");
        if (idExistente) {
            grupoExistente = document.getElementById(idExistente);
            // So pula a instalacao se o grupo de botoes AINDA existir de verdade
            // dentro da barra atual. Na aba Discussoes o CKEditor recria a barra de
            // ferramentas com frequencia (destruindo o grupo antigo), mas o editor
            // pode manter a marcacao antiga — sem essa checagem, o script pensava que
            // ja tinha instalado e nunca reinstalava, fazendo os botoes sumirem.
            if (grupoExistente && barra.contains(grupoExistente)) { return; }
        }

        contadorToolbar += 1; id = "tjsp-editor-toolbar-" + contadorToolbar;
        // Monta o grupo de botoes ANTES de marcar o editor como "ja instalado" —
        // se algo aqui lancar excecao, o atributo nao fica setado, e a proxima
        // tentativa (MutationObserver ou intervalo de seguranca) pode tentar de novo
        // em vez de considerar (erroneamente) que ja foi instalado pra sempre.
        grupo = document.createElement("span"); grupo.id = id; grupo.className = "tjsp-editor-toolbar-group";
        grupo.appendChild(criarBotaoToolbar(criarSvgCaneta(), "Assinar resposta", "tjsp-editor-btn-assinar", function () { inserirAssinaturaNoEditor(editor); }));
        grupo.appendChild(criarBotaoToolbar(criarSvgImagem(), "Formatar resposta", "tjsp-editor-btn-imagens", function () { formatarConteudoNoEditor(editor); }));
        grupo.appendChild(criarBotaoToolbar(criarSvgEngrenagem(), "Gerenciar assinaturas", "tjsp-editor-btn-config", function () { abrirModalAssinaturas(null); }));
        barra.appendChild(grupo);
        editor.setAttribute("data-tjsp-toolbar-id", id);
    }

    function instalarBotoesEditores() {
        var editores = document.querySelectorAll("[contenteditable='true'].cke_wysiwyg_div, [contenteditable='true'][role='textbox'], .cke_wysiwyg_div[contenteditable='true']"), i;
        for (i = 0; i < editores.length; i++) {
            // Try/catch por editor: um erro ao instalar num editor (ex.: Descricao)
            // nao pode impedir a tentativa nos editores seguintes na mesma lista
            // (ex.: o editor da aba Discussoes, que normalmente vem depois na ordem).
            try { instalarBotoesNoEditor(editores[i]); }
            catch (e) { console.error("[TJSP] Erro ao instalar botoes no editor " + i + " (aria-label=" + editores[i].getAttribute("aria-label") + "):", e); }
        }
    }

    function deveMostrarPesquisaChamado() { return /^\/saw\//i.test(location.pathname); }
    function sanitizarNumeroChamado(valor) { return String(valor || "").replace(/\D+/g, ""); }
    function montarUrlChamado(numeroChamado) { return location.origin + "/saw/Request/" + numeroChamado + "/general#" + HASH_DESTAQUE_ABERTURA; }

    function sinalizarPesquisaChamadoInvalida(input) {
        if (!input) { return; }
        input.classList.remove("tjsp-request-search-invalid"); void input.offsetWidth;
        input.classList.add("tjsp-request-search-invalid");
        window.setTimeout(function () { input.classList.remove("tjsp-request-search-invalid"); }, 450);
    }

    // ============================================================
    // CONSULTA RÁPIDA — MODAL SOMENTE LEITURA (Descrição, Dados do usuário,
    // Discussões, Anexos). Sem editor, sem campo de resolução: existe
    // especificamente pra consultar um chamado sem risco de responder no
    // lugar errado quando você já está com outro chamado aberto pra responder.
    // ============================================================
    function obterRestBaseConsulta() {
        var entradas = performance.getEntriesByType("resource"), i, m;
        for (i = 0; i < entradas.length; i++) {
            m = String(entradas[i].name || "").match(/^(https?:\/\/[^/]+\/rest\/\d+)/i);
            if (m) { return m[1]; }
        }
        return location.origin + "/rest/213963628";
    }

    function obterTokenXsrfConsulta() {
        var nomes = ["XSRF-TOKEN", "X-XSRF-TOKEN", "CSRF-TOKEN", "X-CSRF-TOKEN"], partes, i, pos, nome, valor, armazenamentos, j;
        partes = String(document.cookie || "").split(";");
        for (i = 0; i < partes.length; i++) {
            pos = partes[i].indexOf("=");
            if (pos < 0) { continue; }
            nome = partes[i].slice(0, pos).trim();
            if (nomes.indexOf(nome) < 0) { continue; }
            valor = partes[i].slice(pos + 1).trim();
            try { return decodeURIComponent(valor); } catch (e) { return valor; }
        }
        armazenamentos = [window.sessionStorage, window.localStorage];
        for (i = 0; i < armazenamentos.length; i++) {
            for (j = 0; j < nomes.length; j++) {
                try { valor = armazenamentos[i].getItem(nomes[j]); if (valor) { return valor; } } catch (e) {}
            }
        }
        return "";
    }

    function montarCabecalhosConsulta() {
        var cabecalhos = { "Accept": "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest", "X-Requested-By": "XMLHttpRequest" }, token = obterTokenXsrfConsulta();
        if (token) { cabecalhos["X-XSRF-TOKEN"] = token; cabecalhos["X-CSRF-TOKEN"] = token; }
        return cabecalhos;
    }

    function buscarJsonConsulta(url) {
        return fetch(url, { method: "GET", credentials: "same-origin", headers: montarCabecalhosConsulta() }).then(function (resposta) {
            return resposta.text().then(function (bruto) {
                var dados;
                try { dados = bruto ? JSON.parse(bruto) : {}; } catch (e) { dados = { raw: bruto }; }
                if (!resposta.ok) { throw new Error((dados && (dados.message || dados.developer_message)) || ("HTTP " + resposta.status)); }
                return dados;
            });
        });
    }

    function escapeHtmlConsulta(valor) {
        return String(valor === null || valor === undefined ? "" : valor)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function decodificarEntidadesHtmlConsulta(texto) {
        // A API do SMAX retorna Comments/Description com o HTML ja escapado como
        // texto (ex.: "&lt;p&gt;Ola&lt;/p&gt;" em vez de "<p>Ola</p>"). Sem esse
        // passo, caixa.innerHTML abaixo decodifica so uma vez e sobra "<p>" como
        // TEXTO visivel na tela em vez de virar paragrafo de verdade — era isso
        // que deixava o conteudo de Discussoes (e potencialmente Descricao) com
        // as tags aparecendo cruas. Um <textarea> decodifica entidades (&lt; -> <)
        // sem nunca interpretar o resultado como elementos filhos (e' um elemento
        // de "texto puro"), entao serve tanto pra esse caso escapado quanto pra
        // HTML ja vindo cru (onde vira um no-op na pratica).
        var ta = document.createElement("textarea");
        ta.innerHTML = String(texto || "");
        return ta.value;
    }

    function sanitizarHtmlConsulta(html) {
        var caixa = document.createElement("div"), elementosPerigosos, elementos, i, j, attrs, attr;
        caixa.innerHTML = decodificarEntidadesHtmlConsulta(html);
        elementosPerigosos = caixa.querySelectorAll("script,style,iframe,object,embed,link,meta");
        for (i = 0; i < elementosPerigosos.length; i++) { elementosPerigosos[i].parentNode.removeChild(elementosPerigosos[i]); }
        elementos = caixa.querySelectorAll("*");
        for (i = 0; i < elementos.length; i++) {
            attrs = Array.prototype.slice.call(elementos[i].attributes);
            for (j = 0; j < attrs.length; j++) {
                attr = attrs[j];
                if (/^on/i.test(attr.name) || (/^(href|src)$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value))) {
                    elementos[i].removeAttribute(attr.name);
                }
            }
        }
        return caixa.innerHTML;
    }

    function montarUrlAnexoConsulta(anexo) {
        return obterRestBaseConsulta() + "/frs/file-list/" + anexo.id + "?s=" + (anexo.size || 0);
    }

    function formatarDataConsulta(valor) {
        var numero, data;
        if (!valor) { return "Não informada"; }
        numero = Number(valor);
        data = isFinite(numero) ? new Date(numero) : new Date(valor);
        return isNaN(data.getTime()) ? String(valor) : data.toLocaleString("pt-BR");
    }

    function formatarTamanhoArquivoConsulta(bytes) {
        var tamanho = Number(bytes) || 0;
        if (tamanho < 1024) { return tamanho + " B"; }
        if (tamanho < 1024 * 1024) { return (tamanho / 1024).toFixed(1) + " KB"; }
        return (tamanho / (1024 * 1024)).toFixed(1) + " MB";
    }

    function buscarDadosConsultaRapida(numeroChamado) {
        var params = new URLSearchParams({ layout: "FORM_LAYOUT.withoutResolution,FORM_LAYOUT.onlyResolution" });
        return buscarJsonConsulta(obterRestBaseConsulta() + "/entity-page/initializationDataByLayout/Request/" + numeroChamado + "?" + params.toString());
    }

    function extrairIdPessoaSubmitter(submitter) {
        var m = /^Person\/(\d+)$/.exec(String(submitter || ""));
        return m ? m[1] : "";
    }

    // Campos de lista customizados do SMAX (ex.: StatusSCCDSMAX_c) retornam o
    // codigo interno, nao o rotulo exibido nativamente na tela — o codigo e
    // literalmente o rotulo com um sufixo "_c" (ex.: "Fechado_c" -> "Fechado"),
    // e quando o rotulo tem mais de uma palavra ele vem em PascalCase sem
    // espaco (ex.: "EmAndamento_c" -> "Em Andamento").
    function normalizarRotuloConsulta(valor) {
        var texto = String(valor || "").trim();
        if (!texto) { return texto; }
        texto = texto.replace(/_c$/i, "");
        texto = texto.replace(/([a-z0-9à-ü])([A-Z])/g, "$1 $2");
        return texto;
    }

    // Padrão CNJ: NNNNNNN-DD.AAAA.J.TR.OOOO (20 dígitos). O valor salvo no
    // campo NumerodoProcesso_c vem só com os dígitos, sem separadores.
    function formatarNumeroProcessoCnj(numero) {
        var digitos = String(numero || "").replace(/\D/g, "");
        // Sem digito nenhum = campo realmente vazio (campoDadosConsulta ja mostra
        // "Não informado" nesse caso). Com digitos mas fora do padrão CNJ (ex.: "0",
        // valor residual/inválido) não é um número de processo utilizável — melhor
        // "N/A" do que mostrar o valor cru sem sentido pro usuário.
        if (!digitos) { return ""; }
        if (digitos.length !== 20) { return "N/A"; }
        return digitos.slice(0, 7) + "-" + digitos.slice(7, 9) + "." + digitos.slice(9, 13) + "." + digitos.slice(13, 14) + "." + digitos.slice(14, 16) + "." + digitos.slice(16, 20);
    }

    // Fallback quando o campo dedicado (NumerodoProcesso_c) não tem um número de
    // processo valido: procura o padrão CNJ já formatado (com hífen/pontos) direto
    // no texto da Descrição — é comum o processo estar citado ali mesmo quando o
    // campo próprio ficou vazio ou com lixo.
    function extrairProcessoDaDescricaoConsulta(descricaoHtml) {
        var texto, m;
        if (!descricaoHtml) { return ""; }
        texto = decodificarEntidadesHtmlConsulta(String(descricaoHtml)).replace(/<[^>]+>/g, " ");
        m = texto.match(/\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/);
        return m ? m[0] : "";
    }

    function normalizarDadosConsulta(payload, numeroChamado) {
        var dados = (payload && payload.EntityData) || {}, p = dados.properties || {}, rel = dados.related_properties || {};
        var requester = rel.RequestedForPerson || {}, localidade = rel.RegisteredForLocation || {}, grupo = rel.ExpertGroup || rel.AssignedToGroup || {};
        var especialista = rel.ExpertAssignee || rel.AssignedToPerson || {};
        var comentarios = [], anexos = [], numeroProcesso = "", numeroProcessoFormatado, parsedComentarios, parsedAnexos, parsedUserOptions, propsUserOptions, i, propsAnexo;

        try {
            parsedComentarios = JSON.parse(p.Comments || "{}");
            comentarios = Array.isArray(parsedComentarios.Comment) ? parsedComentarios.Comment.slice() : [];
        } catch (e) {}
        comentarios.sort(function (a, b) { return (a.CreateTime || 0) - (b.CreateTime || 0); });

        try {
            parsedAnexos = JSON.parse(p.RequestAttachments || "{}");
            if (Array.isArray(parsedAnexos.complexTypeProperties)) {
                for (i = 0; i < parsedAnexos.complexTypeProperties.length; i++) {
                    propsAnexo = parsedAnexos.complexTypeProperties[i].properties || {};
                    // Anexos ocultos (IsHidden) são imagens embutidas no corpo de
                    // comentários (screenshots colados no editor) — não são anexos
                    // "de verdade" pro usuário navegar na lista.
                    if (!propsAnexo.IsHidden && propsAnexo.file_name) { anexos.push(propsAnexo); }
                }
            }
        } catch (e) {}

        // Nº do processo fica dentro de UserOptions (JSON-string), não é um
        // campo direto de Request — mesma origem que o "Número do processo"
        // já lido no painel flutuante "Dados da solicitação" (Módulo 2).
        try {
            parsedUserOptions = JSON.parse(p.UserOptions || "{}");
            if (Array.isArray(parsedUserOptions.complexTypeProperties) && parsedUserOptions.complexTypeProperties[0]) {
                propsUserOptions = parsedUserOptions.complexTypeProperties[0].properties || {};
                numeroProcesso = propsUserOptions.NumerodoProcesso_c || "";
            }
        } catch (e) {}

        numeroProcessoFormatado = formatarNumeroProcessoCnj(numeroProcesso);
        if (numeroProcessoFormatado === "N/A") {
            numeroProcessoFormatado = extrairProcessoDaDescricaoConsulta(p.Description) || "N/A";
        }

        return {
            id: String(p.Id || numeroChamado),
            descricaoHtml: p.Description || "",
            // Confirmado via captura real do DevTools: o campo se chama "Solution",
            // nao "Resolution" (esse era o nome errado usado antes, por isso a
            // secao Solucao aparecia sempre "Nao informada").
            solucaoHtml: p.Solution || "",
            solicitanteId: requester.Id ? String(requester.Id) : "",
            solicitanteNome: requester.Name || "Não informado",
            solicitanteVip: requester.IsVIP === true || requester.IsVIP === "true",
            solicitanteUpn: requester.Upn || "",
            solicitanteMatricula: "",
            solicitanteCargo: "",
            unidade: localidade.DisplayName || localidade.FullName || "Não informada",
            gseNome: grupo.Name || "Não informado",
            especialistaNome: especialista.Name || "Não informado",
            numeroProcesso: numeroProcessoFormatado,
            statusOperacional: normalizarRotuloConsulta(p.StatusSCCDSMAX_c || p.Status || ""),
            criadoEm: p.CreateTime || p.EmsCreationTime || "",
            comentarios: comentarios,
            anexos: anexos,
            pessoasConhecidas: rel
        };
    }

    function construirMapaPessoasConhecidas(rel) {
        var mapa = {}, chaves = ["RequestedForPerson", "RequestedByPerson", "ExpertAssignee", "OwnedByPerson"], i, pessoa;
        for (i = 0; i < chaves.length; i++) {
            pessoa = rel[chaves[i]];
            if (pessoa && pessoa.Id) { mapa[String(pessoa.Id)] = pessoa.Name || ("Pessoa " + pessoa.Id); }
        }
        return mapa;
    }

    // Nem todo autor de comentário é uma das pessoas já resolvidas no payload
    // principal (ex.: um agente de outra equipe que só comentou uma vez) — pra
    // esses casos, uma segunda consulta pequena e pontual por pessoa.
    function resolverNomesFaltantesConsulta(comentarios, mapaConhecidos) {
        var idsFaltantes = [], vistos = {}, i, id;
        for (i = 0; i < comentarios.length; i++) {
            id = extrairIdPessoaSubmitter(comentarios[i].Submitter);
            if (id && !mapaConhecidos[id] && !vistos[id]) { vistos[id] = true; idsFaltantes.push(id); }
        }
        if (!idsFaltantes.length) { return Promise.resolve(mapaConhecidos); }
        return Promise.all(idsFaltantes.map(function (idPessoa) {
            return buscarJsonConsulta(obterRestBaseConsulta() + "/ems/Person/" + idPessoa + "?layout=Name").then(function (resp) {
                var props = (resp && resp.properties) || (resp && resp.entities && resp.entities[0] && resp.entities[0].properties) || {};
                mapaConhecidos[idPessoa] = props.Name || ("Pessoa " + idPessoa);
            }).catch(function () { mapaConhecidos[idPessoa] = "Pessoa " + idPessoa; });
        })).then(function () { return mapaConhecidos; });
    }

    // Matrícula e cargo não vêm no payload principal do chamado — uma consulta
    // pequena e pontual só do Person do solicitante. EmployeeNumber já era
    // usado (autocomplete do motor de busca); Title é uma tentativa — o
    // painel antigo de "Dados da solicitação" lia isso via atributo de tela
    // [data-aid="title"], não confirmado ainda como nome de campo da API.
    function buscarMatriculaSolicitante(dados) {
        if (!dados.solicitanteId) { return Promise.resolve(dados); }
        return buscarJsonConsulta(obterRestBaseConsulta() + "/ems/Person/" + dados.solicitanteId + "?layout=EmployeeNumber,Title").then(function (resp) {
            var props = (resp && resp.properties) || (resp && resp.entities && resp.entities[0] && resp.entities[0].properties) || {};
            dados.solicitanteMatricula = props.EmployeeNumber || "";
            dados.solicitanteCargo = props.Title || "";
            return dados;
        }).catch(function () { return dados; });
    }

    // Ponte pro Modulo 2 (Visualizador de Anexos, IIFE separada): o painel
    // flutuante "Dados da solicitação" usava simulação de hover no campo
    // "Solicitado para" da propria tela pra ler nome/matricula/unidade — trocado
    // por essa mesma requisicao REST que a Consulta Rapida ja usa, sem nenhuma
    // interacao simulada na tela real (elimina o "flash" do card do Angular).
    function buscarDadosFlutuantesSolicitacao(numeroChamado) {
        return buscarDadosConsultaRapida(numeroChamado).then(function (payload) {
            var dados = normalizarDadosConsulta(payload, numeroChamado);
            return buscarMatriculaSolicitante(dados);
        }).then(function (dados) {
            return {
                nome: dados.solicitanteNome !== "Não informado" ? dados.solicitanteNome : "",
                matricula: dados.solicitanteMatricula || "",
                unidade: dados.unidade !== "Não informada" ? dados.unidade : "",
                processo: dados.numeroProcesso || ""
            };
        });
    }
    window.__tjspDadosSolicitacaoBridge = { buscar: buscarDadosFlutuantesSolicitacao };

    // Rotulo nativo do "Objetivo" do comentario (campo FunctionalPurpose), a
    // classificacao que aparece como ribbon na tela real do SMAX ("Comentário do
    // usuário", "Solicitação de mais informação", "Resolução"...). Codigos
    // confirmados via captura real do DevTools; qualquer codigo novo/nao mapeado
    // cai no humanizador generico em vez de sumir sem rotulo nenhum.
    var ROTULOS_OBJETIVO_COMENTARIO_CONSULTA = {
        "EndUserComment": "Comentário do usuário",
        "RequestMoreInformation": "Solicitação de mais informação",
        "Resolution": "Resolução",
        "StatusUpdate": "Atualização de status"
    };

    function rotularObjetivoComentario(codigo) {
        var rotulo, classeExtra;
        if (!codigo) { return ""; }
        rotulo = ROTULOS_OBJETIVO_COMENTARIO_CONSULTA[codigo] || normalizarRotuloConsulta(codigo);
        classeExtra = codigo === "Resolution" ? " tjsp-consulta-tag-objetivo-resolucao" : "";
        return "<span class='tjsp-consulta-tag tjsp-consulta-tag-objetivo" + classeExtra + "'>" + escapeHtmlConsulta(rotulo) + "</span>";
    }

    function renderizarComentarioConsulta(comentario, mapaPessoas) {
        var idSubmitter, nome, tagClasse, tagTexto, objetivoHtml;
        if (!comentario.CommentFrom) {
            // So os eventos puros de auditoria (ex.: "Request has been assigned") nao
            // tem CommentFrom — mesmo com IsSystem=true, um comentario com CommentFrom
            // definido (Agent/User) e uma resposta de verdade e o SMAX nativo mostra
            // ele com o card completo (nome + ribbon de Objetivo), nao como linha de
            // sistema. Confirmado via captura real: os dois comentarios classificados
            // como "Resolução" nesse chamado tinham IsSystem=true.
            return "<div class='tjsp-consulta-comentario-sistema'>" + sanitizarHtmlConsulta(comentario.CommentBody || "") + " — " + escapeHtmlConsulta(formatarDataConsulta(comentario.CreateTime)) + "</div>";
        }
        idSubmitter = extrairIdPessoaSubmitter(comentario.Submitter);
        nome = mapaPessoas[idSubmitter] || "Colaborador";
        tagClasse = comentario.PrivacyType === "INTERNAL" ? "tjsp-consulta-tag tjsp-consulta-tag-interno" : "tjsp-consulta-tag";
        tagTexto = comentario.PrivacyType === "INTERNAL" ? "Interno" : "Visível ao usuário";
        objetivoHtml = rotularObjetivoComentario(comentario.FunctionalPurpose);
        return "<div class='tjsp-consulta-comentario" + (comentario.PrivacyType === "INTERNAL" ? " tjsp-consulta-interno" : "") + "'>" +
            "<div class='tjsp-consulta-comentario-cab'>" +
                "<span class='tjsp-consulta-comentario-nome'>" + escapeHtmlConsulta(nome) + "</span>" +
                objetivoHtml +
                "<span class='" + tagClasse + "'>" + tagTexto + "</span>" +
                "<span class='tjsp-consulta-comentario-data'>" + escapeHtmlConsulta(formatarDataConsulta(comentario.CreateTime)) + "</span>" +
            "</div>" +
            "<div class='tjsp-consulta-comentario-corpo'>" + sanitizarHtmlConsulta(comentario.CommentBody || "") + "</div>" +
            "</div>";
    }

    function renderizarAnexoConsulta(anexo, indice, listaParaVisualizador) {
        var div = document.createElement("div");
        div.className = "tjsp-consulta-anexo";
        div.innerHTML = "<span class='tjsp-consulta-anexo-nome'>📎 " + escapeHtmlConsulta(anexo.file_name) + "</span>" +
            "<span class='tjsp-consulta-anexo-tamanho'>" + formatarTamanhoArquivoConsulta(anexo.size) + "</span>";
        div.addEventListener("click", function () {
            if (window.__tjspAnexosViewer && typeof window.__tjspAnexosViewer.abrir === "function") {
                window.__tjspAnexosViewer.abrir(listaParaVisualizador, indice);
            } else {
                window.open(montarUrlAnexoConsulta(anexo), "_blank");
            }
        });
        return div;
    }

    function campoDadosConsulta(rotulo, valor, permiteCopiar, badgeHtml) {
        var texto = valor || "Não informado", botao = "";
        if (permiteCopiar && valor) {
            botao = "<button class='tjsp-consulta-copiar' type='button' data-copiar='" + escapeHtmlConsulta(texto) + "' title='Copiar'>" + criarSvgCopiar() + "</button>";
        }
        return "<div><small>" + escapeHtmlConsulta(rotulo) + "</small><span class='tjsp-consulta-campo-valor'><strong>" + escapeHtmlConsulta(texto) + "</strong>" + (badgeHtml || "") + botao + "</span></div>";
    }

    function copiarTextoConsulta(texto, botao) {
        // innerHTML (nao textContent): o botao agora tem um SVG dentro, e
        // textContent de um SVG sem texto vem vazio — reverter pra vazio apagava
        // o icone depois do "✓".
        navigator.clipboard.writeText(texto).then(function () {
            var original = botao.innerHTML;
            botao.innerHTML = "✓";
            window.setTimeout(function () { botao.innerHTML = original; }, 1200);
        }).catch(function () {});
    }

    function itemAcordeaoConsulta(id, titulo, contagem, aberto) {
        return "<div class='tjsp-consulta-acc-item" + (aberto ? " tjsp-consulta-acc-aberto" : "") + "' data-acc='" + id + "'>" +
            "<button type='button' class='tjsp-consulta-acc-head'><span>" + escapeHtmlConsulta(titulo) +
                (contagem ? " <span class='tjsp-consulta-acc-count'>" + contagem + "</span>" : "") +
            "</span><span class='tjsp-consulta-acc-chevron'>⌄</span></button>" +
            "<div class='tjsp-consulta-acc-body'><div class='tjsp-consulta-acc-inner' id='tjsp-consulta-" + id + "-lista'></div></div>" +
            "</div>";
    }

    function ativarAcordeaoConsulta(corpo) {
        Array.prototype.forEach.call(corpo.querySelectorAll(".tjsp-consulta-acc-head"), function (head) {
            head.addEventListener("click", function () {
                head.closest(".tjsp-consulta-acc-item").classList.toggle("tjsp-consulta-acc-aberto");
            });
        });
    }

    function renderizarCorpoConsultaRapida(corpo, dados, mapaPessoas) {
        var htmlDados, htmlDescricao, i, listaAnexosVisualizador, containerAnexos, containerComentarios, containerSolucao, botoesCopiar;

        // Dados da solicitação e Descrição ficam sempre expandidos (é o que se
        // quer ver de cara); Solução, Discussões e Anexos viram itens de
        // acordeão — Discussões já abre por padrão por ser o mais lido.
        htmlDados = "<section class='tjsp-consulta-secao'><h3>Dados da solicitação</h3><div class='tjsp-consulta-dados-grid'>" +
            campoDadosConsulta("Solicitante", dados.solicitanteNome, true, dados.solicitanteVip ? "<span class='tjsp-consulta-vip-badge'>⭐ VIP</span>" : "") +
            campoDadosConsulta("Cargo", dados.solicitanteCargo, false) +
            campoDadosConsulta("Matrícula", dados.solicitanteMatricula, true) +
            campoDadosConsulta("Unidade", dados.unidade, false) +
            campoDadosConsulta("GSE", dados.gseNome, false) +
            campoDadosConsulta("Designado Especialista", dados.especialistaNome, false) +
            campoDadosConsulta("Nº do processo", dados.numeroProcesso, dados.numeroProcesso !== "N/A") +
            campoDadosConsulta("Criado em", formatarDataConsulta(dados.criadoEm), false) +
            campoDadosConsulta("Status operacional", dados.statusOperacional, false) +
            "</div></section>";

        htmlDescricao = "<section class='tjsp-consulta-secao'><h3>Descrição</h3><div class='tjsp-consulta-descricao'>" +
            (dados.descricaoHtml ? sanitizarHtmlConsulta(dados.descricaoHtml) : "<span class='tjsp-consulta-vazio'>Não informada.</span>") +
            "</div></section>";

        corpo.innerHTML = htmlDados + htmlDescricao +
            itemAcordeaoConsulta("solucao", "Solução", "", false) +
            itemAcordeaoConsulta("discussoes", "Discussões", dados.comentarios.length || "", true) +
            itemAcordeaoConsulta("anexos", "Anexos", dados.anexos.length || "", false);

        ativarAcordeaoConsulta(corpo);

        botoesCopiar = corpo.querySelectorAll(".tjsp-consulta-copiar");
        for (i = 0; i < botoesCopiar.length; i++) {
            (function (btn) { btn.addEventListener("click", function () { copiarTextoConsulta(btn.getAttribute("data-copiar"), btn); }); })(botoesCopiar[i]);
        }

        containerSolucao = corpo.querySelector("#tjsp-consulta-solucao-lista");
        containerSolucao.innerHTML = dados.solucaoHtml ? sanitizarHtmlConsulta(dados.solucaoHtml) : "<span class='tjsp-consulta-vazio'>Não informada.</span>";

        containerComentarios = corpo.querySelector("#tjsp-consulta-discussoes-lista");
        containerComentarios.innerHTML = dados.comentarios.length
            ? dados.comentarios.map(function (c) { return renderizarComentarioConsulta(c, mapaPessoas); }).join("")
            : "<span class='tjsp-consulta-vazio'>Nenhuma discussão registrada.</span>";

        containerAnexos = corpo.querySelector("#tjsp-consulta-anexos-lista");
        if (!dados.anexos.length) {
            containerAnexos.innerHTML = "<span class='tjsp-consulta-vazio'>Nenhum anexo.</span>";
        } else {
            listaAnexosVisualizador = dados.anexos.map(function (a) { return { nome: a.file_name, url: montarUrlAnexoConsulta(a) }; });
            for (i = 0; i < dados.anexos.length; i++) {
                containerAnexos.appendChild(renderizarAnexoConsulta(dados.anexos[i], i, listaAnexosVisualizador));
            }
        }
    }

    function criarEstiloConsultaRapida() {
        var style;
        if (document.getElementById("tjsp-consulta-rapida-style")) { return; }
        style = document.createElement("style"); style.id = "tjsp-consulta-rapida-style";
        style.textContent = [
            "#tjsp-consulta-rapida-overlay{position:fixed;inset:0;z-index:2000000;background:rgba(8,14,22,.6);display:flex;padding:20px;font-family:Arial,sans-serif}",
            "#tjsp-consulta-rapida-modal{width:min(980px,96vw);height:min(92vh,980px);margin:auto;background:#f2f5f8;border:1px solid #cdd8e3;border-radius:12px;box-shadow:0 24px 60px rgba(16,39,64,.35);display:flex;flex-direction:column;overflow:hidden}",
            "#tjsp-consulta-rapida-header{height:60px;padding:0 18px;background:linear-gradient(180deg,#1a73c7,#12558f);border-bottom:3px solid #5aa9e6;color:#fff;display:flex;align-items:center;gap:12px;flex-shrink:0}",
            "#tjsp-consulta-rapida-header h2{margin:0;font-size:16px;flex:1;font-weight:700}",
            "#tjsp-consulta-rapida-header h2 small{opacity:.85;display:block;font-size:11px;font-weight:400;margin-top:2px}",
            "#tjsp-consulta-rapida-abrir-completo{height:32px;padding:0 12px;border:1px solid rgba(255,255,255,.4);border-radius:6px;background:rgba(255,255,255,.14);color:#fff;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}",
            "#tjsp-consulta-rapida-abrir-completo:hover{background:rgba(255,255,255,.24)}",
            "#tjsp-consulta-rapida-fechar{width:32px;height:32px;border:1px solid rgba(255,255,255,.3);border-radius:7px;background:rgba(255,255,255,.12);color:#fff;font-size:19px;cursor:pointer}",
            "#tjsp-consulta-rapida-fechar:hover{background:rgba(198,40,40,.75)}",
            "#tjsp-consulta-rapida-minimizar{width:32px;height:32px;border:1px solid rgba(255,255,255,.3);border-radius:7px;background:rgba(255,255,255,.12);color:#fff;font-size:15px;cursor:pointer;line-height:1}",
            "#tjsp-consulta-rapida-minimizar:hover{background:rgba(255,255,255,.24)}",
            "#tjsp-consulta-rapida-pill{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:1999999;display:none;align-items:center;gap:8px;padding:11px 18px;border-radius:99px;border:1px solid rgba(255,255,255,.4);background:linear-gradient(135deg,#1a73c7,#12558f);color:#fff;font-size:12.5px;font-weight:700;cursor:pointer;box-shadow:0 8px 24px rgba(16,39,64,.4);font-family:Arial,sans-serif}",
            "#tjsp-consulta-rapida-pill:hover{filter:brightness(1.08)}",
            ".tjsp-consulta-pill-dica{opacity:.85;font-weight:400}",
            "#tjsp-consulta-rapida-corpo{flex:1;overflow:auto;padding:18px}",
            "#tjsp-consulta-rapida-corpo.tjsp-consulta-carregando{display:flex;align-items:center;justify-content:center;color:#526477;font-size:13px}",
            ".tjsp-consulta-secao{background:#fff;border:1px solid #d5e0ea;border-radius:10px;padding:14px 16px;margin-bottom:16px}",
            ".tjsp-consulta-secao h3{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#12558f}",
            ".tjsp-consulta-dados-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}",
            ".tjsp-consulta-dados-grid div small{display:block;font-size:10px;text-transform:uppercase;color:#607287;margin-bottom:2px}",
            ".tjsp-consulta-dados-grid div strong{font-size:13px;color:#2f4050}",
            ".tjsp-consulta-campo-valor{display:flex;align-items:center;gap:6px}",
            ".tjsp-consulta-copiar{flex-shrink:0;width:22px;height:22px;padding:0;border:1px solid #cfe4f7;border-radius:5px;background:#eaf4fd;color:#12558f;font-size:11px;cursor:pointer;display:flex;align-items:center;justify-content:center}",
            ".tjsp-consulta-copiar svg{width:12px;height:12px;stroke:currentColor;display:block}",
            ".tjsp-consulta-vip-badge{flex-shrink:0;font-size:10px;font-weight:800;color:#8a6300;background:#ffe9a8;border-radius:4px;padding:1px 7px}",
            ".tjsp-consulta-copiar:hover{background:#d5e9fa}",
            ".tjsp-consulta-descricao{font-size:13.5px;line-height:1.6;color:#273746;overflow-wrap:anywhere}",
            ".tjsp-consulta-descricao p{margin:0 0 10px}",
            ".tjsp-consulta-comentario{border:1px solid #e3eaf0;border-left:3px solid #5aa9e6;border-radius:8px;padding:10px 12px;margin-bottom:10px;background:#f8fafc}",
            ".tjsp-consulta-comentario.tjsp-consulta-interno{border-left-color:#d13438;background:#fff7f6}",
            ".tjsp-consulta-comentario-cab{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11.5px;flex-wrap:wrap}",
            ".tjsp-consulta-comentario-nome{font-weight:700;color:#12558f}",
            ".tjsp-consulta-comentario-data{margin-left:auto;color:#7a8b9b}",
            ".tjsp-consulta-tag{font-size:10px;font-weight:700;padding:1px 7px;border-radius:99px;background:#eaf4fd;color:#12558f}",
            ".tjsp-consulta-tag-interno{background:#ffe1df;color:#a11f19}",
            ".tjsp-consulta-tag-objetivo{background:#eef2f6;color:#48586b}",
            ".tjsp-consulta-tag-objetivo-resolucao{background:#e4f5e9;color:#1c7c3f}",
            ".tjsp-consulta-comentario-corpo{font-size:13px;line-height:1.55;color:#273746;overflow-wrap:anywhere}",
            ".tjsp-consulta-comentario-corpo p{margin:0 0 6px}",
            ".tjsp-consulta-comentario-sistema{font-size:11px;color:#8a97a5;padding:4px 0;font-style:italic}",
            ".tjsp-consulta-comentario-sistema p, .tjsp-consulta-comentario-sistema div{margin:0 0 4px;display:block}",
            ".tjsp-consulta-anexo{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #d5e0ea;border-radius:6px;background:#fff;cursor:pointer;margin-bottom:8px}",
            ".tjsp-consulta-anexo:hover{background:#eaf4fd}",
            ".tjsp-consulta-anexo-nome{flex:1;font-size:12.5px;color:#273746;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
            ".tjsp-consulta-anexo-tamanho{font-size:11px;color:#7a8b9b}",
            ".tjsp-consulta-vazio{color:#7a8b9b;font-size:12.5px;font-style:italic}",
            "#tjsp-consulta-rapida-erro{padding:30px;text-align:center;color:#a11f19;font-size:13px}",
            ".tjsp-consulta-acc-item{background:#fff;border:1px solid #d5e0ea;border-radius:10px;margin-bottom:16px;overflow:hidden}",
            ".tjsp-consulta-acc-item:last-child{margin-bottom:0}",
            ".tjsp-consulta-acc-head{width:100%;appearance:none;border:0;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 16px;font:700 12px/1 Arial,sans-serif;color:#12558f;text-transform:uppercase;letter-spacing:.04em}",
            ".tjsp-consulta-acc-head span:first-child{display:flex;align-items:center;gap:8px}",
            ".tjsp-consulta-acc-count{text-transform:none;letter-spacing:normal;background:#eaf4fd;color:#12558f;font-size:10px;font-weight:800;padding:1px 7px;border-radius:99px}",
            ".tjsp-consulta-acc-chevron{color:#1a73c7;font-size:13px;transition:transform .15s ease;text-transform:none}",
            ".tjsp-consulta-acc-item.tjsp-consulta-acc-aberto .tjsp-consulta-acc-chevron{transform:rotate(180deg)}",
            ".tjsp-consulta-acc-body{max-height:0;overflow:hidden;transition:max-height .2s ease}",
            ".tjsp-consulta-acc-item.tjsp-consulta-acc-aberto .tjsp-consulta-acc-body{max-height:2000px}",
            ".tjsp-consulta-acc-inner{padding:0 16px 15px;border-top:1px solid #eef2f6;padding-top:12px}"
        ].join("\n");
        document.head.appendChild(style);
    }

    function handlerTecladoConsultaRapida(event) { if (event.key === "Escape") { fecharConsultaRapida(); } }

    function fecharConsultaRapida() {
        var overlay = document.getElementById("tjsp-consulta-rapida-overlay");
        if (overlay) { overlay.parentNode.removeChild(overlay); }
        esconderPillRestaurarConsulta();
        document.removeEventListener("keydown", handlerTecladoConsultaRapida);
    }

    // Minimizar só esconde o modal (sem remover do DOM nem perder os dados já
    // carregados) e mostra uma pill flutuante pra reabrir — assim dá pra ver
    // alguma coisa na tela de trás (ex.: o chamado que você está realmente
    // respondendo) sem perder o que já consultou.
    function minimizarConsultaRapida(numeroChamado) {
        var overlay = document.getElementById("tjsp-consulta-rapida-overlay");
        if (overlay) { overlay.style.display = "none"; }
        mostrarPillRestaurarConsulta(numeroChamado);
    }

    function mostrarPillRestaurarConsulta(numeroChamado) {
        var pill = document.getElementById("tjsp-consulta-rapida-pill");
        if (!pill) {
            pill = document.createElement("button");
            pill.id = "tjsp-consulta-rapida-pill";
            pill.type = "button";
            pill.addEventListener("click", function () {
                var overlayAtual = document.getElementById("tjsp-consulta-rapida-overlay");
                if (overlayAtual) { overlayAtual.style.display = "flex"; }
                pill.style.display = "none";
            });
            document.body.appendChild(pill);
        }
        pill.innerHTML = "📋 Consulta rápida — chamado " + escapeHtmlConsulta(numeroChamado) + " <span class='tjsp-consulta-pill-dica'>(clique pra reabrir)</span>";
        pill.style.display = "flex";
    }

    function esconderPillRestaurarConsulta() {
        var pill = document.getElementById("tjsp-consulta-rapida-pill");
        if (pill) { pill.style.display = "none"; }
    }

    function abrirConsultaRapidaModal(numeroChamado) {
        var overlay, modal, header, titulo, botaoAbrirCompleto, botaoMinimizar, botaoFechar, corpo;
        fecharConsultaRapida();
        criarEstiloConsultaRapida();

        overlay = document.createElement("div"); overlay.id = "tjsp-consulta-rapida-overlay";
        modal = document.createElement("div"); modal.id = "tjsp-consulta-rapida-modal";
        header = document.createElement("div"); header.id = "tjsp-consulta-rapida-header";
        titulo = document.createElement("h2");
        titulo.innerHTML = "Consulta rápida — Chamado " + escapeHtmlConsulta(numeroChamado) + "<small>Somente leitura — sem opção de responder</small>";
        botaoAbrirCompleto = document.createElement("button"); botaoAbrirCompleto.id = "tjsp-consulta-rapida-abrir-completo"; botaoAbrirCompleto.type = "button"; botaoAbrirCompleto.textContent = "Abrir chamado completo";
        botaoAbrirCompleto.addEventListener("click", function () { window.open(montarUrlChamado(numeroChamado), "_blank", "noopener,noreferrer"); });
        botaoMinimizar = document.createElement("button"); botaoMinimizar.id = "tjsp-consulta-rapida-minimizar"; botaoMinimizar.type = "button"; botaoMinimizar.innerHTML = "&#9472;"; botaoMinimizar.title = "Minimizar (sem perder o chamado consultado)"; botaoMinimizar.setAttribute("aria-label", "Minimizar");
        botaoMinimizar.addEventListener("click", function () { minimizarConsultaRapida(numeroChamado); });
        botaoFechar = document.createElement("button"); botaoFechar.id = "tjsp-consulta-rapida-fechar"; botaoFechar.type = "button"; botaoFechar.textContent = "×"; botaoFechar.title = "Fechar"; botaoFechar.setAttribute("aria-label", "Fechar");
        botaoFechar.addEventListener("click", fecharConsultaRapida);
        header.appendChild(titulo); header.appendChild(botaoAbrirCompleto); header.appendChild(botaoMinimizar); header.appendChild(botaoFechar);

        corpo = document.createElement("div"); corpo.id = "tjsp-consulta-rapida-corpo"; corpo.className = "tjsp-consulta-carregando";
        corpo.textContent = "Carregando dados do chamado " + numeroChamado + "...";

        modal.appendChild(header); modal.appendChild(corpo);
        overlay.appendChild(modal);
        overlay.addEventListener("click", function (event) { if (event.target === overlay) { fecharConsultaRapida(); } });
        document.body.appendChild(overlay);
        document.addEventListener("keydown", handlerTecladoConsultaRapida);

        buscarDadosConsultaRapida(numeroChamado).then(function (payload) {
            var dadosNormalizados = normalizarDadosConsulta(payload, numeroChamado);
            var mapaConhecidos = construirMapaPessoasConhecidas(dadosNormalizados.pessoasConhecidas);
            return Promise.all([
                resolverNomesFaltantesConsulta(dadosNormalizados.comentarios, mapaConhecidos),
                buscarMatriculaSolicitante(dadosNormalizados)
            ]).then(function (resultados) {
                corpo.className = "";
                renderizarCorpoConsultaRapida(corpo, dadosNormalizados, resultados[0]);
            });
        }).catch(function (erro) {
            corpo.className = "";
            corpo.innerHTML = "<div id='tjsp-consulta-rapida-erro'>Não foi possível carregar o chamado " + escapeHtmlConsulta(numeroChamado) + ".<br>" + escapeHtmlConsulta(erro && erro.message ? erro.message : String(erro)) + "</div>";
        });
    }

    function abrirChamadoPorPesquisa() {
        var input = document.getElementById("tjsp-request-search-input"), numeroChamado = sanitizarNumeroChamado(input ? input.value : "");
        if (!numeroChamado) { sinalizarPesquisaChamadoInvalida(input); return false; }
        if (input) { input.value = numeroChamado; }
        abrirConsultaRapidaModal(numeroChamado);
        return true;
    }

    function criarPesquisaChamado() {
        var existente = document.getElementById("tjsp-request-search-widget"), wrapper, label, input, botao, icone;
        if (!deveMostrarPesquisaChamado()) { if (existente) { existente.remove(); } return; }
        if (existente) { return; }
        criarEstilo();
        wrapper = document.createElement("div"); wrapper.id = "tjsp-request-search-widget"; wrapper.setAttribute("aria-label", "Consulta rápida de solicitação por número");
        label = document.createElement("span"); label.className = "tjsp-request-search-label"; label.textContent = "Consulta rápida";
        input = document.createElement("input"); input.id = "tjsp-request-search-input"; input.type = "text"; input.inputMode = "numeric"; input.autocomplete = "off"; input.placeholder = "Nº do chamado"; input.maxLength = 12; input.setAttribute("aria-label", "Número do chamado"); input.setAttribute("pattern", "[0-9]*");
        botao = document.createElement("button"); botao.id = "tjsp-request-search-button"; botao.type = "button"; botao.title = "Consultar solicitação (somente leitura)"; botao.setAttribute("aria-label", "Consultar solicitação (somente leitura)");
        icone = document.createElement("span"); icone.className = "tjsp-request-search-icon";
        icone.innerHTML = ["<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'>", "<circle cx='10.8' cy='10.8' r='6.2' stroke-width='2'/>", "<path d='M15.4 15.4L20 20' stroke-width='2.3' stroke-linecap='round'/>", "</svg>"].join("");
        botao.appendChild(icone);
        input.addEventListener("input", function () { input.value = sanitizarNumeroChamado(input.value); });
        input.addEventListener("paste", function () { window.setTimeout(function () { input.value = sanitizarNumeroChamado(input.value); }, 0); });
        input.addEventListener("keydown", function (event) { if (event.key === "Enter") { event.preventDefault(); abrirChamadoPorPesquisa(); } });
        botao.addEventListener("click", function (event) { event.preventDefault(); abrirChamadoPorPesquisa(); });
        wrapper.appendChild(label); wrapper.appendChild(input); wrapper.appendChild(botao); document.body.appendChild(wrapper);
    }

    function faviconAzulDataUrl() {
        return "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><circle cx='32' cy='32' r='29' fill='#0078d4'/><circle cx='32' cy='32' r='20' fill='none' stroke='white' stroke-width='7'/></svg>");
    }

    function manterFaviconAzul() {
        var href = faviconAzulDataUrl();
        var links = document.querySelectorAll("link[rel~='icon'], link[rel='shortcut icon']");
        var link, i;
        for (i = 0; i < links.length; i++) { links[i].parentNode.removeChild(links[i]); }
        link = document.createElement("link");
        link.rel = "icon";
        link.type = "image/svg+xml";
        link.href = href;
        document.head.appendChild(link);
    }

    function aplicarDestaqueGuiaConsultaRapida() {
        var tituloAtual, tituloLimpo, banner;
        if (location.hash.indexOf(HASH_DESTAQUE_ABERTURA) < 0) { return; }

        tituloAtual = document.title || "Solicitação";
        tituloLimpo = tituloAtual.replace(/^🔵\s*/g, "");
        if (tituloAtual.indexOf(TITULO_PREFIXO_CONSULTA) !== 0) {
            document.title = TITULO_PREFIXO_CONSULTA + tituloLimpo;
        }

        manterFaviconAzul();
        document.body.classList.add("tjsp-opened-tab-highlight-body");

        banner = document.getElementById("tjsp-opened-tab-highlight-banner");
        if (!banner && document.body) {
            banner = document.createElement("div");
            banner.id = "tjsp-opened-tab-highlight-banner";
            banner.innerHTML = "<strong>Consulta rápida</strong> — solicitação aberta por pesquisa rápida";
            document.body.appendChild(banner);
        }
    }

    function destacarGuiaAbertaPelaPesquisa() {
        if (location.hash.indexOf(HASH_DESTAQUE_ABERTURA) < 0) { return; }
        aplicarDestaqueGuiaConsultaRapida();
        if (!intervaloDestaqueGuia) {
            intervaloDestaqueGuia = window.setInterval(aplicarDestaqueGuiaConsultaRapida, 700);
        }
    }

    function aguardarEditorDiscussao() { return waitForCondition(function () { return !!localizarEditorDiscussao(); }, 15000, 300); }

    function configurarParaEObjetivo() {
        var selectPara, selectObjetivo, resultadoPara = false, resultadoObjetivo = false;
        if (!estaNaAbaDiscussoes()) { return Promise.resolve({ para: false, objetivo: false }); }
        return aguardarEditorDiscussao().then(function (ok) {
            if (!ok) { return { para: false, objetivo: false }; }
            selectPara = localizarSelectPara(); selectObjetivo = localizarSelectObjetivo();
            if (selectPara) { resultadoPara = selecionarSelectNativo(selectPara, VALOR_PARA_USUARIO); }
            return sleep(500).then(function () {
                if (selectObjetivo) { resultadoObjetivo = selecionarSelectNativo(selectObjetivo, VALOR_OBJETIVO_ATUALIZACAO); }
                return sleep(500).then(function () { return { para: resultadoPara, objetivo: resultadoObjetivo }; });
            });
        });
    }

    function preencherEditorDiscussao() {
        var editor, textoHtml, nome, instance, editable;
        if (!estaNaAbaDiscussoes()) { return false; }
        editor = localizarEditorDiscussao(); if (!editor) { return false; }
        textoHtml = montarTextoPadrao().textoHtml;
        editor.focus(); editor.innerHTML = textoHtml; dispararEventos(editor);
        try {
            if (window.CKEDITOR && window.CKEDITOR.instances) {
                for (nome in window.CKEDITOR.instances) {
                    if (Object.prototype.hasOwnProperty.call(window.CKEDITOR.instances, nome)) {
                        instance = window.CKEDITOR.instances[nome]; editable = instance.editable && instance.editable();
                        if (editable && editable.$ === editor) { instance.setData(textoHtml); instance.fire("change"); break; }
                    }
                }
            }
        } catch (e) {}
        return true;
    }

    function irParaGeral() { var url; if (estaNaAbaGeral()) { return true; } url = gerarUrlGeral(); if (!url) { return false; } location.href = url; return false; }
    function irParaDiscussoes() { var url; if (estaNaAbaDiscussoes()) { return true; } url = gerarUrlDiscussoes(); if (!url) { return false; } location.href = url; return false; }
    function garantirAbaDiscussoesAberta() { var url; if (estaNaAbaDiscussoes()) { return true; } url = gerarUrlDiscussoes(); if (url) { location.href = url; return false; } return false; }

    function etapaCapturarNomeNaGeral() {
        if (!irParaGeral()) { return Promise.resolve(false); }
        return waitForCondition(function () { var campo = document.querySelector("input[name='Usuario_c'], input[id$='_Usuario_c']"); return campo && campo.value && campo.value.trim(); }, 12000, 300).then(function () {
            var primeiroNome = obterPrimeiroNomeUsuarioNaGeral();
            if (primeiroNome) { sessionStorage.setItem(STORAGE_PRIMEIRO_NOME, primeiroNome); } else { sessionStorage.removeItem(STORAGE_PRIMEIRO_NOME); }
            sessionStorage.setItem(STORAGE_ETAPA, ETAPA_EXECUTAR_NA_DISCUSSAO); irParaDiscussoes(); return true;
        });
    }

    function etapaExecutarNaDiscussao() {
        if (!irParaDiscussoes()) { return Promise.resolve(false); }
        return waitForCondition(function () { return document.querySelector("#tab-8.active") || location.href.toLowerCase().indexOf("/discussions") >= 0; }, 12000, 300).then(function () { return aguardarEditorDiscussao(); }).then(function (editorOk) {
            if (!editorOk) { sessionStorage.removeItem(STORAGE_ETAPA); alert(["Nao encontrei o editor da aba Discussoes.", "", "O script nao clicou em Iniciar discussao por seguranca.", "", "Abra manualmente a area de comentario, se necessario, e clique novamente no robo."].join("\n")); garantirAbaDiscussoesAberta(); return false; }
            return waitForCondition(function () { return localizarSelectPara() && localizarSelectObjetivo() && localizarEditorDiscussao(); }, 12000, 300);
        }).then(function (camposOk) {
            if (!camposOk) { sessionStorage.removeItem(STORAGE_ETAPA); alert(["Nao encontrei todos os campos da aba Discussoes.", "", "Verifique se os campos Para, Objetivo e o editor de texto estao visiveis."].join("\n")); garantirAbaDiscussoesAberta(); return false; }
            sessionStorage.removeItem(STORAGE_ETAPA);
            return configurarParaEObjetivo().then(function (resultadoCampos) {
                var resultadoTexto = preencherEditorDiscussao(), primeiroNomeUsado = sessionStorage.getItem(STORAGE_PRIMEIRO_NOME) || "", mensagens = [];
                mensagens.push(resultadoCampos.para ? "Campo Para ajustado para Usuario." : "Nao consegui ajustar automaticamente o campo Para.");
                mensagens.push(resultadoCampos.objetivo ? "Campo Objetivo ajustado para Atualizacao de status." : "Nao consegui ajustar automaticamente o campo Objetivo.");
                mensagens.push(resultadoTexto ? "Texto inserido no editor da discussao." : "Nao consegui encontrar ou preencher o editor de texto.");
                mensagens.push(primeiroNomeUsado ? "Usuario capturado na aba Geral: " + primeiroNomeUsado + "." : "Nao consegui identificar o usuario na aba Geral. Usei saudacao generica.");
                alert(["Automacao concluida.", "", mensagens.join("\n"), "", "A aba Discussoes permanecera aberta para conferencia manual antes de enviar ou adicionar."].join("\n")); garantirAbaDiscussoesAberta(); return true;
            });
        });
    }

    function continuarFluxoPendente() {
        var etapa;
        if (fluxoEmAndamento) { return; }
        etapa = sessionStorage.getItem(STORAGE_ETAPA); if (!etapa) { return; }
        fluxoEmAndamento = true;
        sleep(1200).then(function () {
            if (etapa === ETAPA_CAPTURAR_NOME_NA_GERAL) { return etapaCapturarNomeNaGeral(); }
            if (etapa === ETAPA_EXECUTAR_NA_DISCUSSAO) { return etapaExecutarNaDiscussao(); }
            return false;
        }).catch(function (erro) { console.error("[TJSP] Erro no fluxo pendente:", erro); alert("Ocorreu um erro durante a automacao. Veja o Console para detalhes."); sessionStorage.removeItem(STORAGE_ETAPA); }).then(function () { fluxoEmAndamento = false; });
    }

    function iniciarFluxoCompleto() {
        if (fluxoEmAndamento) { return; }
        fluxoEmAndamento = true;
        sessionStorage.removeItem(STORAGE_PRIMEIRO_NOME); sessionStorage.setItem(STORAGE_ETAPA, ETAPA_CAPTURAR_NOME_NA_GERAL);
        etapaCapturarNomeNaGeral().catch(function (erro) { console.error("[TJSP] Erro ao iniciar fluxo:", erro); alert("Ocorreu um erro ao iniciar a automacao. Veja o Console para detalhes."); sessionStorage.removeItem(STORAGE_ETAPA); }).then(function () { fluxoEmAndamento = false; });
    }

    function criarEstilo() {
        var style;
        if (document.getElementById("tjsp-auto-robot-style")) { return; }
        style = document.createElement("style"); style.id = "tjsp-auto-robot-style";
        style.textContent = [
            "#tjsp-auto-robot-widget{position:fixed;top:76px;right:24px;z-index:999999;font-family:Arial,sans-serif}",
            "#tjsp-auto-robot-button{width:52px;height:52px;border-radius:50%;border:0;background:linear-gradient(135deg,#005a9e,#0078d4);color:#fff;font-size:27px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.28);display:flex;align-items:center;justify-content:center}",
            "#tjsp-auto-robot-button:hover{background:linear-gradient(135deg,#004578,#005a9e);transform:scale(1.06)}",
            "#tjsp-auto-options-menu{position:absolute;top:62px;right:0;min-width:260px;background:#fff;border:1px solid #d0d7de;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.22);overflow:hidden}",
            "#tjsp-auto-options-menu.tjsp-auto-hidden{display:none}",
            ".tjsp-auto-menu-header{padding:10px 13px;font-size:13px;font-weight:700;color:#333;background:#f5f7fa;border-bottom:1px solid #e5e7eb}",
            ".tjsp-auto-menu-option{width:100%;border:0;background:#fff;padding:12px 14px;text-align:left;font-size:13px;color:#222;cursor:pointer;display:flex;align-items:center;gap:8px}",
            ".tjsp-auto-menu-option:hover{background:#eef6ff;color:#005a9e}",
            ".tjsp-auto-menu-option-icon{font-size:16px}",
            "#tjsp-request-search-widget{position:fixed;top:7px;right:385px;z-index:1000000;height:42px;display:flex;align-items:center;gap:8px;padding:5px 7px 5px 12px;border:1px solid rgba(255,255,255,.42);border-radius:14px;background:linear-gradient(135deg,#005a9e,#0078d4 58%,#00a2ed);box-shadow:0 5px 16px rgba(0,60,110,.32),inset 0 1px 0 rgba(255,255,255,.36);font-family:Arial,sans-serif;box-sizing:border-box}",
            "#tjsp-request-search-widget:before{content:'';position:absolute;inset:1px;border-radius:13px;border:1px solid rgba(255,255,255,.20);pointer-events:none}",
            "#tjsp-request-search-widget .tjsp-request-search-label{font-size:12px;font-weight:700;color:#fff;white-space:nowrap;letter-spacing:.01em;text-shadow:0 1px 1px rgba(0,0,0,.24)}",
            "#tjsp-request-search-input{width:130px;height:30px;border:1px solid rgba(255,255,255,.72);border-radius:9px;padding:0 10px;font-size:13px;color:#123;background:rgba(255,255,255,.96);outline:none;box-sizing:border-box;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease}",
            "#tjsp-request-search-input:focus{border-color:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.28),0 0 0 5px rgba(0,120,212,.22);background:#fff}",
            "#tjsp-request-search-input::placeholder{color:#6b7785}",
            "#tjsp-request-search-button{width:32px;height:32px;min-width:32px;border:1px solid rgba(255,255,255,.60);border-radius:10px;background:linear-gradient(135deg,#003f75,#0067b8);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;box-shadow:0 2px 7px rgba(0,50,100,.35),inset 0 1px 0 rgba(255,255,255,.35);transition:filter .15s ease,box-shadow .15s ease,transform .10s ease;box-sizing:border-box}",
            "#tjsp-request-search-button:hover{filter:saturate(1.18) brightness(1.12);box-shadow:0 3px 10px rgba(0,50,100,.45),inset 0 1px 0 rgba(255,255,255,.45);transform:translateY(-1px)}",
            "#tjsp-request-search-button:active{transform:translateY(0);box-shadow:0 1px 3px rgba(0,50,100,.35),inset 0 1px 2px rgba(0,0,0,.18)}",
            "#tjsp-request-search-button svg{width:17px;height:17px;display:block;stroke:#fff;filter:drop-shadow(0 1px 1px rgba(0,0,0,.25))}",
            "#tjsp-request-search-input.tjsp-request-search-invalid{border-color:#ffdad6!important;box-shadow:0 0 0 3px rgba(255,255,255,.25),0 0 0 5px rgba(201,42,42,.25)!important;animation:tjspRequestSearchShake .28s ease-in-out}",
            "@keyframes tjspRequestSearchShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}",
            "#tjsp-opened-tab-highlight-banner{position:fixed;top:52px;left:50%;transform:translateX(-50%);z-index:1000000;background:linear-gradient(135deg,#005a9e,#0078d4);color:#fff;border:1px solid rgba(255,255,255,.42);border-radius:999px;padding:9px 18px;font-family:Arial,sans-serif;font-size:13px;font-weight:700;box-shadow:0 8px 24px rgba(0,90,158,.36)}",
            "body.tjsp-opened-tab-highlight-body:after{content:'';position:fixed;inset:0;z-index:999997;border:4px solid #0078d4;box-shadow:inset 0 0 0 2px rgba(255,255,255,.7),inset 0 0 30px rgba(0,120,212,.22);pointer-events:none}",
            "@media(max-width:1200px){#tjsp-request-search-widget{right:260px}#tjsp-request-search-widget .tjsp-request-search-label{display:none}#tjsp-request-search-input{width:118px}}",
            ".tjsp-editor-toolbar-group{display:inline-flex!important;align-items:center!important;gap:6px!important;margin-left:9px!important;padding-left:9px!important;border-left:1px solid #b8c7d8!important;vertical-align:middle!important;height:30px!important}",
            ".tjsp-editor-toolbar-btn{width:30px!important;height:30px!important;min-width:30px!important;min-height:30px!important;padding:0!important;border:1px solid #005a9e!important;border-radius:8px!important;cursor:pointer!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:0 2px 6px rgba(0,90,158,.35),inset 0 1px 0 rgba(255,255,255,.35)!important;transition:filter .15s ease,box-shadow .15s ease,transform .10s ease!important;position:relative!important;overflow:hidden!important;opacity:1!important;filter:none!important;box-sizing:border-box!important}",
            ".tjsp-editor-toolbar-btn svg{width:18px!important;height:18px!important;display:block!important;stroke:#fff!important;stroke-width:2!important;filter:drop-shadow(0 1px 1px rgba(0,0,0,.28))!important;opacity:1!important}",
            ".tjsp-editor-toolbar-btn:hover{filter:saturate(1.18) brightness(1.10)!important;box-shadow:0 3px 10px rgba(0,90,158,.45),inset 0 1px 0 rgba(255,255,255,.45)!important;transform:translateY(-1px)!important}",
            ".tjsp-editor-toolbar-btn:active{transform:translateY(0)!important;box-shadow:0 1px 3px rgba(0,50,100,.35),inset 0 1px 2px rgba(0,0,0,.18)!important}",
            ".tjsp-editor-btn-assinar{background:linear-gradient(135deg,#005a9e,#0078d4)!important}",
            ".tjsp-editor-btn-imagens{background:linear-gradient(135deg,#004b8d,#00a2ed)!important}",
            ".cke_image_resizer,.cke_widget_drag_handler_container,[data-cke-widget-resizer],.cke_widget_wrapper .cke_image_resizer,.cke_widget_selected .cke_image_resizer{display:none!important;visibility:hidden!important;opacity:0!important;width:0!important;height:0!important;border:0!important;padding:0!important;margin:0!important}"
        ].join("\n");
        document.head.appendChild(style);
    }

    function criarOpcao(id, iconeHtml, texto, callback) {
        var btn = document.createElement("button"); btn.id = id; btn.type = "button"; btn.className = "tjsp-auto-menu-option";
        btn.innerHTML = "<span class='tjsp-auto-menu-option-icon'>" + iconeHtml + "</span><span>" + texto + "</span>";
        btn.addEventListener("click", function (event) { event.stopPropagation(); var menu = document.getElementById("tjsp-auto-options-menu"); if (menu) { menu.classList.add("tjsp-auto-hidden"); } callback(); });
        return btn;
    }

    function criarBotao() {
        var widgetExistente, botaoAntigo, wrapperAntigo, widget, botaoRobo, menu, cabecalho;
        if (!ROBO_OPCOES_HABILITADO) { widgetExistente = document.getElementById("tjsp-auto-robot-widget"); if (widgetExistente) { widgetExistente.remove(); } return; }
        if (!estaEmTelaDeChamado()) { widgetExistente = document.getElementById("tjsp-auto-robot-widget"); if (widgetExistente) { widgetExistente.remove(); } return; }
        if (document.getElementById("tjsp-auto-robot-widget")) { return; }
        botaoAntigo = document.getElementById("btn-tjsp-informar-recebimento"); if (botaoAntigo) { wrapperAntigo = botaoAntigo.closest("#wrapper-tjsp-informar-recebimento") || botaoAntigo; wrapperAntigo.remove(); }
        criarEstilo(); widget = document.createElement("div"); widget.id = "tjsp-auto-robot-widget";
        botaoRobo = document.createElement("button"); botaoRobo.id = "tjsp-auto-robot-button"; botaoRobo.type = "button"; botaoRobo.textContent = "🤖"; botaoRobo.title = "Exibir opcoes automatizadas"; botaoRobo.setAttribute("aria-label", "Exibir opcoes automatizadas");
        menu = document.createElement("div"); menu.id = "tjsp-auto-options-menu"; menu.className = "tjsp-auto-hidden";
        cabecalho = document.createElement("div"); cabecalho.className = "tjsp-auto-menu-header"; cabecalho.textContent = "Opcoes automatizadas"; menu.appendChild(cabecalho);
        menu.appendChild(criarOpcao("tjsp-auto-option-informar-recebimento", "📨", "Informar recebimento do chamado", iniciarFluxoCompleto));
        botaoRobo.addEventListener("click", function (event) { event.stopPropagation(); menu.classList.toggle("tjsp-auto-hidden"); });
        document.addEventListener("click", function (event) { if (!widget.contains(event.target)) { menu.classList.add("tjsp-auto-hidden"); } });
        widget.appendChild(botaoRobo); widget.appendChild(menu); document.body.appendChild(widget);
    }

    function executarProtegido(fn, rotulo) {
        try { fn(); } catch (e) { console.error("[TJSP] Erro em " + rotulo + ":", e); }
    }

    function executarCicloAtualizacao() {
        executarProtegido(criarBotao, "criarBotao");
        executarProtegido(criarPesquisaChamado, "criarPesquisaChamado");
        executarProtegido(instalarBotoesEditores, "instalarBotoesEditores");
        executarProtegido(continuarFluxoPendente, "continuarFluxoPendente");
        executarProtegido(destacarGuiaAbertaPelaPesquisa, "destacarGuiaAbertaPelaPesquisa");
    }

    function iniciar() {
        var observer;
        criarEstilo();
        executarCicloAtualizacao();
        observer = new MutationObserver(executarCicloAtualizacao);
        observer.observe(document.body, { childList: true, subtree: true });
        // Rede de seguranca: caso alguma janela de mutacoes seja perdida (ex.: outro
        // script no mesmo site provocando recriacoes de DOM fora do lote observado),
        // este intervalo garante que os botoes do editor sejam reinstalados mesmo assim.
        // instalarBotoesEditores() e idempotente (nao duplica se ja instalado).
        window.setInterval(function () { executarProtegido(instalarBotoesEditores, "instalarBotoesEditores (intervalo)"); }, 1500);
        // Ganchos de depuracao temporarios — permitem testar manualmente pelo Console
        // (window.__tjspInstalarBotoesEditores() / window.__tjspContarGrupos()) sem
        // precisar esperar o ciclo automatico, pra isolar se o problema e a instalacao
        // em si ou o agendamento das tentativas. Podem ser removidos depois de resolvido.
        window.__tjspInstalarBotoesEditores = instalarBotoesEditores;
        window.__tjspContarGrupos = function () { return document.querySelectorAll(".tjsp-editor-toolbar-group").length; };
        console.log("[TJSP] Robo de automacoes carregado. Versao 1.15.1.");
    }

    if (document.readyState === "loading") { document.addEventListener("DOMContentLoaded", iniciar); } else { iniciar(); }
}());

// ============================================================
// MODULO: SMAX - Visualizador de Anexos (integrado a partir da v0.20)
// Mantido em IIFE proprio (escopo isolado) para nao colidir com nomes
// do modulo do Robo de Automacoes acima.
// ============================================================
(function () {
    'use strict';

    // ============================================================
    // CONFIGURAÇÕES
    // ============================================================
    const DEBUG = true;
    const LOG_PREFIX = '[SMAX-Preview]';
    const REGEX_TELA_CHAMADO = /\/saw\/Request\/\d+\//;
    const SELETOR_ANEXO = 'a[ng-href*="/frs/file-list/"], a[href*="/frs/file-list/"]';
    const COR_AZUL = '#1a73c7';          // azul vivo, igual ao da barra superior/"Consulta rápida" do SMAX
    const COR_AZUL_ESCURO = '#12558f';
    const COR_ACCENT = '#5aa9e6';        // azul mais claro, para hovers/destaques (mesma família, sem laranja/vermelho)
    const COR_AZUL_NATIVO = '#0B6EE0';   // cor exata do botao "Pesquisa completa no acervo SMAX" (outro script do
                                          // autor) — usada so nos icones flutuantes de Anexos/Dados pra ficarem
                                          // visualmente consistentes com esse botao, que ja tem cara de nativo da pagina
    const ICONE_COPIAR = "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'><rect x='9' y='9' width='11' height='11' rx='2' stroke-width='1.8'/><path d='M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1' stroke-width='1.8' stroke-linecap='round'/></svg>";
    const ICONE_COPIADO = "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' focusable='false'><path d='M5 13l4 4L19 7' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/></svg>";
    const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const REGEX_PROCESSO = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/; // padrão CNJ — ajustar se o formato real for diferente

    function log(...args) {
        if (DEBUG) console.log(LOG_PREFIX, ...args);
    }

    // Configura o worker do PDF.js (se biblioteca estiver carregada)
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        log('PDF.js carregado. Versão:', pdfjsLib.version);
    } else {
        log('⚠️ PDF.js não carregou. PDFs cairão em fallback (iframe/nova guia).');
    }

    // ============================================================
    // ESTILOS DO MODAL
    // ============================================================
    function injetarEstilos() {
        if (document.getElementById('smax-preview-styles')) return;
        const style = document.createElement('style');
        style.id = 'smax-preview-styles';
        style.textContent = `
            #smax-preview-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(8, 14, 22, 0.88);
                z-index: 2100000;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: smaxFadeIn 0.2s ease-out;
                font-family: 'Segoe UI', Roboto, Arial, sans-serif;
            }
            @keyframes smaxFadeIn { from { opacity: 0; } to { opacity: 1; } }

            /* Envelope que agrupa o modal + setas — as setas ficam ancoradas
               nas bordas do modal em vez de flutuar soltas na tela */
            #smax-preview-shell {
                position: relative;
                width: 92vw;
                height: 94vh;
                max-width: 1500px;
            }
            #smax-preview-modal {
                background: #fff;
                border-radius: 10px;
                width: 100%;
                height: 100%;
                display: flex;
                flex-direction: column;
                box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255,255,255,0.06);
                overflow: hidden;
            }
            #smax-preview-header {
                background: linear-gradient(180deg, ${COR_AZUL} 0%, ${COR_AZUL_ESCURO} 100%);
                border-bottom: 3px solid ${COR_ACCENT};
                color: #fff;
                padding: 11px 16px;
                display: flex;
                align-items: center;
                gap: 10px;
                flex-shrink: 0;
            }
            #smax-preview-title {
                flex: 1;
                font-weight: 600;
                font-size: 15px;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                letter-spacing: 0.2px;
            }
            #smax-preview-contador {
                font-size: 12px;
                font-weight: 700;
                color: ${COR_AZUL_ESCURO};
                background: #fff;
                padding: 3px 12px;
                border-radius: 999px;
                white-space: nowrap;
                box-shadow: 0 1px 4px rgba(0,0,0,0.2);
            }
            .smax-preview-btn {
                background: rgba(255, 255, 255, 0.12);
                color: #fff;
                border: 1px solid rgba(255, 255, 255, 0.35);
                padding: 6px 13px;
                border-radius: 5px;
                cursor: pointer;
                font-size: 13px;
                font-family: inherit;
                transition: background 0.15s, border-color 0.15s;
            }
            .smax-preview-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.28); border-color: rgba(255,255,255,0.6); }
            .smax-preview-btn:disabled { opacity: 0.4; cursor: not-allowed; }
            .smax-preview-btn-close {
                background: rgba(198, 40, 40, 0.85);
                border-color: rgba(255,255,255,0.25);
                font-weight: 600;
                padding: 6px 14px;
            }
            .smax-preview-btn-close:hover { background: #c62828; border-color: rgba(255,255,255,0.4); }

            /* Setas de navegação entre anexos — ancoradas nas bordas do modal.
               Fundo azul sólido + anel branco pra ficarem bem visíveis sobre o overlay escuro. */
            .smax-nav-arrow {
                position: absolute;
                top: 50%;
                transform: translateY(-50%);
                background: ${COR_AZUL};
                color: #fff;
                border: 3px solid #fff;
                width: 46px;
                height: 46px;
                border-radius: 50%;
                font-size: 24px;
                line-height: 1;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.15s, transform 0.15s;
                box-shadow: 0 4px 16px rgba(0,0,0,0.5);
                z-index: 1000000;
            }
            .smax-nav-arrow:hover:not(:disabled) { background: ${COR_AZUL_ESCURO}; transform: translateY(-50%) scale(1.08); }
            .smax-nav-arrow:disabled { opacity: 0.35; cursor: not-allowed; }
            .smax-nav-arrow.smax-nav-hidden { display: none; }
            .smax-nav-prev { left: -22px; }
            .smax-nav-next { right: -22px; }

            /* Barra de controles do PDF */
            #smax-pdf-toolbar {
                background: ${COR_AZUL_ESCURO};
                color: #fff;
                padding: 7px 12px;
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
                flex-shrink: 0;
                border-bottom: 1px solid rgba(255,255,255,0.08);
            }
            #smax-pdf-toolbar button {
                background: rgba(255,255,255,0.1);
                color: #fff;
                border: 1px solid rgba(255,255,255,0.25);
                padding: 4px 10px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                transition: background 0.15s, border-color 0.15s;
            }
            #smax-pdf-toolbar button:hover:not(:disabled) { background: rgba(245, 166, 35, 0.25); border-color: ${COR_ACCENT}; }
            #smax-pdf-toolbar button:disabled { opacity: 0.4; cursor: not-allowed; }
            #smax-pdf-toolbar .smax-sep { flex: 1; }
            #smax-pdf-toolbar input[type="number"] {
                width: 55px;
                padding: 3px 6px;
                border: 1px solid rgba(255,255,255,0.3);
                border-radius: 4px;
                background: rgba(255,255,255,0.95);
                color: #000;
                font-size: 13px;
                text-align: center;
            }
            #smax-pdf-toolbar input[type="number"]:focus {
                outline: none;
                border-color: ${COR_ACCENT};
                box-shadow: 0 0 0 2px rgba(245, 166, 35, 0.3);
            }

            #smax-preview-body {
                flex: 1;
                overflow: auto;
                background: #4a5765;
                display: flex;
                align-items: flex-start;
                justify-content: center;
                position: relative;
                padding: 15px 0;
            }
            #smax-preview-body.smax-center-content {
                align-items: center;
            }
            #smax-preview-body iframe {
                width: 100%;
                height: 100%;
                border: none;
                background: #fff;
            }
            #smax-preview-body img,
            #smax-preview-body canvas.smax-img-canvas {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
                display: block;
                background: #fff;
                box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            }
            #smax-pdf-container {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 12px;
                padding: 0 15px;
            }
            #smax-pdf-container canvas {
                background: #fff;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                max-width: 100%;
                height: auto;
            }
            .smax-docx-wrap {
                max-width: 900px;
                width: 100%;
                margin: 0 auto;
            }
            .smax-docx-aviso {
                background: #eaf4fd;
                border: 1px solid #b8dcf5;
                color: #0c4a7a;
                font-size: 12.5px;
                padding: 8px 14px;
                border-radius: 6px 6px 0 0;
                margin: 0;
            }
            .smax-docx-content {
                background: #fff;
                padding: 40px 60px;
                width: 100%;
                box-sizing: border-box;
                box-shadow: 0 4px 12px rgba(0,0,0,0.4);
                font-family: 'Calibri', 'Segoe UI', sans-serif;
                line-height: 1.6;
                color: #222;
            }
            .smax-docx-wrap .smax-docx-content { border-radius: 0 0 4px 4px; }
            .smax-docx-content h1, .smax-docx-content h2, .smax-docx-content h3 {
                color: ${COR_AZUL_ESCURO};
                margin-top: 1em;
            }
            .smax-docx-content table { border-collapse: collapse; margin: 10px 0; }
            .smax-docx-content table td, .smax-docx-content table th {
                border: 1px solid #bbb;
                padding: 6px 10px;
            }
            .smax-loading {
                text-align: center;
                color: #fff;
                font-size: 15px;
            }
            .smax-spinner {
                width: 48px;
                height: 48px;
                border: 5px solid rgba(255,255,255,0.2);
                border-top-color: ${COR_ACCENT};
                border-radius: 50%;
                animation: smaxSpin 0.9s linear infinite;
                margin: 0 auto 15px;
            }
            @keyframes smaxSpin { to { transform: rotate(360deg); } }
            .smax-erro, .smax-sem-preview {
                background: #fff;
                border-radius: 8px;
                padding: 25px 35px;
                max-width: 550px;
                text-align: center;
                color: #333;
                box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            }
            .smax-erro { border-top: 4px solid #c62828; }
            .smax-erro h3 { color: #c62828; margin: 0 0 12px; }
            .smax-sem-preview { border-top: 4px solid ${COR_ACCENT}; }
            .smax-sem-preview h3 { color: ${COR_AZUL_ESCURO}; margin: 0 0 12px; }
            .smax-erro button, .smax-sem-preview button {
                background: ${COR_AZUL};
                color: #fff;
                border: none;
                padding: 10px 20px;
                border-radius: 5px;
                cursor: pointer;
                font-size: 14px;
                margin-top: 15px;
                margin-right: 8px;
                transition: background 0.15s;
            }
            .smax-erro button:hover, .smax-sem-preview button:hover { background: ${COR_AZUL_ESCURO}; }

            /* Ícone flutuante de anexos — atalho pra abrir os anexos sem descer a tela.
               position:absolute (não fixed) de propósito: rola JUNTO com a página em vez
               de grudar na tela, pra não sobrepor outros ícones/menus quando o usuário
               rola pra baixo. Ajuste TOP/LEFT abaixo se não encaixar direito na sua
               resolução/zoom (calibrado pra ficar perto do cabeçalho "Detalhes"). */
            #smax-anexos-flutuante {
                position: absolute;
                top: 188px;
                left: 430px;
                width: 44px;
                height: 44px;
                border-radius: 50%;
                background: ${COR_AZUL_NATIVO};
                color: #fff;
                border: 2px solid #fff;
                box-shadow: 0 4px 14px rgba(0,0,0,0.3);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 999997;
                transition: transform 0.15s, box-shadow 0.15s;
                padding: 0;
            }
            #smax-anexos-flutuante::before {
                content: '';
                position: absolute;
                top: -6px; left: -6px; right: -6px; bottom: -6px;
                border-radius: 50%;
                border: 2px solid ${COR_AZUL_NATIVO};
                opacity: 0.6;
                animation: smaxAnexosPulso 2.2s ease-out infinite;
                pointer-events: none;
            }
            @keyframes smaxAnexosPulso {
                0% { transform: scale(0.85); opacity: 0.6; }
                100% { transform: scale(1.35); opacity: 0; }
            }
            #smax-anexos-flutuante svg { width: 20px; height: 20px; position: relative; }
            #smax-anexos-flutuante:hover { transform: scale(1.08); box-shadow: 0 6px 18px rgba(0,0,0,0.4); }
            #smax-anexos-badge {
                position: absolute;
                top: -5px;
                right: -5px;
                background: #fff;
                color: ${COR_AZUL_ESCURO};
                font-size: 11px;
                font-weight: 700;
                min-width: 18px;
                height: 18px;
                border-radius: 999px;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0 4px;
                box-shadow: 0 1px 4px rgba(0,0,0,0.35);
            }
            #smax-anexos-popover {
                position: absolute;
                top: 234px;
                left: 430px;
                background: #fff;
                border-radius: 8px;
                box-shadow: 0 12px 32px rgba(0,0,0,0.4);
                width: 300px;
                max-height: 55vh;
                overflow-y: auto;
                z-index: 999997;
                border: 1px solid #d8e3f0;
                font-family: 'Segoe UI', Roboto, Arial, sans-serif;
            }
            #smax-anexos-popover-header {
                background: ${COR_AZUL};
                color: #fff;
                padding: 10px 14px;
                font-size: 13px;
                font-weight: 600;
                border-radius: 8px 8px 0 0;
                position: sticky;
                top: 0;
            }
            .smax-anexos-item {
                display: flex;
                align-items: center;
                gap: 9px;
                padding: 10px 14px;
                cursor: pointer;
                font-size: 13px;
                color: #222;
                border-bottom: 1px solid #eef2f7;
                transition: background 0.12s;
            }
            .smax-anexos-item:last-child { border-bottom: none; }
            .smax-anexos-item:hover { background: #eaf4fd; }
            .smax-anexos-item-icone { flex-shrink: 0; font-size: 15px; }
            .smax-anexos-item-nome {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            /* Ícone flutuante de dados da solicitação (mesmo padrão do de anexos,
               ao lado dele) */
            #smax-dados-flutuante {
                position: absolute;
                top: 188px;
                left: 484px;
                width: 44px;
                height: 44px;
                border-radius: 50%;
                background: ${COR_AZUL_NATIVO};
                color: #fff;
                border: 2px solid #fff;
                box-shadow: 0 4px 14px rgba(0,0,0,0.3);
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 999997;
                transition: transform 0.15s, box-shadow 0.15s;
                padding: 0;
            }
            #smax-dados-flutuante svg { width: 20px; height: 20px; }
            #smax-dados-flutuante:hover { transform: scale(1.08); box-shadow: 0 6px 18px rgba(0,0,0,0.4); }
            #smax-dados-painel {
                position: absolute;
                top: 234px;
                left: 484px;
                background: #fff;
                border-radius: 8px;
                box-shadow: 0 12px 32px rgba(0,0,0,0.4);
                width: 300px;
                z-index: 999997;
                border: 1px solid #d8e3f0;
                font-family: 'Segoe UI', Roboto, Arial, sans-serif;
            }
            #smax-dados-painel-header {
                background: ${COR_AZUL};
                color: #fff;
                padding: 10px 14px;
                font-size: 13px;
                font-weight: 600;
                border-radius: 8px 8px 0 0;
            }
            #smax-dados-painel-corpo { padding: 8px 12px 12px; }
            .smax-dados-carregando, .smax-dados-vazio {
                text-align: center;
                color: #556;
                font-size: 13px;
                padding: 16px 6px;
            }
            .smax-dados-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 2px;
                border-bottom: 1px solid #eef2f7;
            }
            .smax-dados-item:last-of-type { border-bottom: none; }
            .smax-dados-item-texto { flex: 1; min-width: 0; display: flex; flex-direction: column; }
            .smax-dados-item-rotulo { font-size: 11px; color: #7a8699; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
            .smax-dados-item-valor {
                font-size: 13px;
                color: #222;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .smax-dados-copiar {
                flex-shrink: 0;
                background: #eaf4fd;
                border: 1px solid #cfe4f7;
                border-radius: 5px;
                width: 28px;
                height: 28px;
                cursor: pointer;
                font-size: 13px;
                color: ${COR_AZUL_ESCURO};
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.12s;
            }
            .smax-dados-copiar:hover { background: #d5e9fa; }
            .smax-dados-copiar svg { width: 14px; height: 14px; stroke: currentColor; display: block; }
            #smax-dados-copiar-tudo {
                width: 100%;
                margin-top: 10px;
                background: ${COR_AZUL};
                color: #fff;
                border: none;
                padding: 8px;
                border-radius: 5px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                transition: background 0.15s;
            }
            #smax-dados-copiar-tudo:hover { background: ${COR_AZUL_ESCURO}; }
        `;
        document.head.appendChild(style);
    }

    // ============================================================
    // DETECÇÃO DE TIPO DE ARQUIVO
    // ============================================================
    function detectarTipo(nomeArquivo) {
        const ext = (nomeArquivo.split('.').pop() || '').toLowerCase();
        if (ext === 'pdf') return 'pdf';
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'imagem';
        if (ext === 'docx') return 'docx';
        if (ext === 'doc') return 'doc-legado'; // formato binário antigo, mammoth só lê .docx
        if (['txt', 'log', 'csv'].includes(ext)) return 'texto';
        return 'desconhecido';
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // ============================================================
    // BUSCA DO ARQUIVO (via $http do Angular quando disponível)
    // ============================================================
    function obterHttpAngular() {
        try {
            if (typeof angular === 'undefined') return null;
            const el = document.querySelector('[ng-app]') || document.body;
            const injector = angular.element(el).injector();
            if (!injector) return null;
            return injector.get('$http');
        } catch (e) {
            log('Não foi possível obter $http do Angular, vou usar fetch puro:', e);
            return null;
        }
    }

    async function buscarArquivoComoBlob(url) {
        const http = obterHttpAngular();
        if (http) {
            try {
                const resp = await http.get(url, { responseType: 'blob' });
                log('Arquivo obtido via $http do Angular (mesmos headers/CSRF do app).');
                return resp.data;
            } catch (err) {
                log('Falha ao buscar via $http do Angular, tentando fetch puro:', err);
            }
        }
        const resp = await fetch(url, { credentials: 'include' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} - ${resp.statusText}`);
        return await resp.blob();
    }

    // ============================================================
    // ESTADO GLOBAL DO MODAL
    // ============================================================
    let blobUrlAtual = null;
    let blobBrutoAtual = null;  // Blob cru do anexo atual (qualquer tipo) — usado por Baixar/Nova guia
    let pdfDocAtual = null;
    let pdfPaginaAtual = 1;
    let pdfZoomAtual = 1.3;
    let renderTaskAtual = null;
    let listaAnexosAtual = [];   // [{ nome, url, elemento }]
    let indiceAnexoAtual = -1;

    // ============================================================
    // ABERTURA / FECHAMENTO DO MODAL
    // ============================================================
    function abrirModal(lista, indice) {
        fecharModal();
        listaAnexosAtual = lista;
        indiceAnexoAtual = indice;
        injetarEstilos();
        construirEsqueletoModal();
        carregarAnexoAtual();
    }

    function fecharModal() {
        const overlay = document.getElementById('smax-preview-overlay');
        if (overlay) overlay.remove();
        if (blobUrlAtual) {
            URL.revokeObjectURL(blobUrlAtual);
            blobUrlAtual = null;
        }
        blobBrutoAtual = null;
        if (renderTaskAtual) {
            try { renderTaskAtual.cancel(); } catch (e) {}
            renderTaskAtual = null;
        }
        pdfDocAtual = null;
        pdfPaginaAtual = 1;
        listaAnexosAtual = [];
        indiceAnexoAtual = -1;
        document.removeEventListener('keydown', handlerTeclado);
    }

    function construirEsqueletoModal() {
        const overlay = document.createElement('div');
        overlay.id = 'smax-preview-overlay';
        overlay.innerHTML = `
<div id="smax-preview-shell">
<button id="smax-nav-prev" class="smax-nav-arrow smax-nav-prev" title="Anexo anterior (Alt+&larr;)">&#8249;</button>
<button id="smax-nav-next" class="smax-nav-arrow smax-nav-next" title="Próximo anexo (Alt+&rarr;)">&#8250;</button>
<div id="smax-preview-modal">
<div id="smax-preview-header">
<span id="smax-preview-title"></span>
<span id="smax-preview-contador"></span>
<button class="smax-preview-btn" id="smax-btn-baixar">⬇ Baixar</button>
<button class="smax-preview-btn" id="smax-btn-nova-guia">🗗 Nova guia</button>
<button class="smax-preview-btn smax-preview-btn-close" id="smax-btn-fechar">✖ Fechar</button>
</div>
<div id="smax-preview-body" class="smax-center-content"></div>
</div>
</div>
        `;
        document.body.appendChild(overlay);

        overlay.addEventListener('click', (e) => { if (e.target === overlay) fecharModal(); });
        document.getElementById('smax-btn-fechar').addEventListener('click', fecharModal);
        document.getElementById('smax-btn-baixar').addEventListener('click', () => {
            const item = listaAnexosAtual[indiceAnexoAtual];
            if (!item) return;
            // Usa o blob ja buscado (mesma requisicao autenticada que gerou o
            // preview) em vez da URL crua do SMAX: um <a href> direto pra essa URL
            // nao carrega os headers que o $http/fetch usaram, entao o servidor
            // rejeitava e nada baixava — mesmo nas telas de "nao e possivel
            // pre-visualizar", onde o arquivo na verdade ja tinha sido buscado com
            // sucesso, so nao estava sendo reaproveitado aqui.
            const urlParaBaixar = blobBrutoAtual ? URL.createObjectURL(blobBrutoAtual) : item.url;
            const link = document.createElement('a');
            link.href = urlParaBaixar;
            link.download = item.nome;
            document.body.appendChild(link);
            link.click();
            link.remove();
            if (blobBrutoAtual) { setTimeout(() => URL.revokeObjectURL(urlParaBaixar), 4000); }
        });
        document.getElementById('smax-btn-nova-guia').addEventListener('click', () => {
            const item = listaAnexosAtual[indiceAnexoAtual];
            if (!item) return;
            if (blobUrlAtual) { window.open(blobUrlAtual, '_blank'); return; }
            if (blobBrutoAtual) { window.open(URL.createObjectURL(blobBrutoAtual), '_blank'); return; }
            window.open(item.url, '_blank');
        });
        document.getElementById('smax-nav-prev').addEventListener('click', () => trocarAnexo(-1));
        document.getElementById('smax-nav-next').addEventListener('click', () => trocarAnexo(1));

        document.addEventListener('keydown', handlerTeclado);
    }

    function handlerTeclado(e) {
        if (e.key === 'Escape') { fecharModal(); return; }

        // Alt+Seta sempre troca de anexo, mesmo dentro de um PDF paginado
        if (e.altKey && e.key === 'ArrowRight') { trocarAnexo(1); e.preventDefault(); return; }
        if (e.altKey && e.key === 'ArrowLeft') { trocarAnexo(-1); e.preventDefault(); return; }

        if (pdfDocAtual) {
            if (e.key === 'ArrowRight' || e.key === 'PageDown') { irParaPagina(pdfPaginaAtual + 1); e.preventDefault(); }
            if (e.key === 'ArrowLeft' || e.key === 'PageUp') { irParaPagina(pdfPaginaAtual - 1); e.preventDefault(); }
            return;
        }

        // Sem paginação (imagem/docx/txt): seta pura já troca de anexo
        if (e.key === 'ArrowRight') { trocarAnexo(1); e.preventDefault(); }
        if (e.key === 'ArrowLeft') { trocarAnexo(-1); e.preventDefault(); }
    }

    // ============================================================
    // NAVEGAÇÃO ENTRE ANEXOS
    // ============================================================
    function trocarAnexo(delta) {
        if (!listaAnexosAtual.length) return;
        const novoIndice = indiceAnexoAtual + delta;
        if (novoIndice < 0 || novoIndice >= listaAnexosAtual.length) return;
        indiceAnexoAtual = novoIndice;
        carregarAnexoAtual();
    }

    function atualizarCabecalho() {
        const item = listaAnexosAtual[indiceAnexoAtual];
        if (!item) return;
        const title = document.getElementById('smax-preview-title');
        const contador = document.getElementById('smax-preview-contador');
        if (title) title.textContent = '📄 ' + item.nome;
        if (contador) {
            contador.textContent = listaAnexosAtual.length > 1
                ? `${indiceAnexoAtual + 1} / ${listaAnexosAtual.length}`
                : '';
        }
    }

    function atualizarSetasNavegacao() {
        const prev = document.getElementById('smax-nav-prev');
        const next = document.getElementById('smax-nav-next');
        if (!prev || !next) return;
        const mostrar = listaAnexosAtual.length > 1;
        prev.classList.toggle('smax-nav-hidden', !mostrar);
        next.classList.toggle('smax-nav-hidden', !mostrar);
        prev.disabled = indiceAnexoAtual <= 0;
        next.disabled = indiceAnexoAtual >= listaAnexosAtual.length - 1;
    }

    function carregarAnexoAtual() {
        const item = listaAnexosAtual[indiceAnexoAtual];
        if (!item) return;

        // Limpa estado específico do arquivo anterior (mas mantém o modal aberto)
        const oldToolbar = document.getElementById('smax-pdf-toolbar');
        if (oldToolbar) oldToolbar.remove();
        if (renderTaskAtual) { try { renderTaskAtual.cancel(); } catch (e) {} renderTaskAtual = null; }
        pdfDocAtual = null;
        pdfPaginaAtual = 1;
        if (blobUrlAtual) { URL.revokeObjectURL(blobUrlAtual); blobUrlAtual = null; }
        blobBrutoAtual = null;

        const body = document.getElementById('smax-preview-body');
        body.classList.add('smax-center-content');
        body.innerHTML = `
            <div class="smax-loading">
                <div class="smax-spinner"></div>
                <div>Carregando <b>${escapeHtml(item.nome)}</b>...</div>
            </div>
        `;

        atualizarCabecalho();
        atualizarSetasNavegacao();

        carregarERenderizar(item.nome, item.url);
    }

    async function carregarERenderizar(nomeArquivo, url) {
        const body = document.getElementById('smax-preview-body');
        const tipo = detectarTipo(nomeArquivo);
        log('Carregando:', nomeArquivo, '| tipo:', tipo, '| URL:', url);

        try {
            const blob = await buscarArquivoComoBlob(url);
            log('Blob recebido:', blob.type, blob.size, 'bytes');

            if (blob.type === 'text/html' || blob.type === 'application/json') {
                throw new Error(`O servidor devolveu "${blob.type}" em vez do arquivo — provável sessão expirada ou sem permissão. Recarregue a página (F5) e tente de novo.`);
            }

            // Guarda o blob cru assim que a busca autenticada deu certo — vale pra
            // TODOS os tipos (inclusive os que caem em "sem preview"/.doc legado
            // logo abaixo), pra Baixar/Nova guia poderem reaproveitar sem refazer a
            // requisição sem os headers de autenticação.
            blobBrutoAtual = blob;

            if (tipo === 'pdf') {
                await renderizarPdf(blob, url);
            } else if (tipo === 'imagem') {
                const ext = nomeArquivo.split('.').pop().toLowerCase();
                const mime = blob.type.startsWith('image/') ? blob.type : (ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
                const blobTipado = new Blob([blob], { type: mime });
                // usado pelos botões "Baixar" / "Nova guia" (navegação de aba, não sofre com img-src)
                blobUrlAtual = URL.createObjectURL(blobTipado);
                await renderizarImagem(blobTipado, nomeArquivo);
            } else if (tipo === 'docx') {
                await renderizarDocx(blob, body);
            } else if (tipo === 'doc-legado') {
                mostrarDocLegado(nomeArquivo);
            } else if (tipo === 'texto') {
                const texto = await blob.text();
                body.classList.remove('smax-center-content');
                body.innerHTML = '';
                const pre = document.createElement('pre');
                pre.className = 'smax-docx-content';
                pre.style.whiteSpace = 'pre-wrap';
                pre.style.fontFamily = 'Consolas, Monaco, monospace';
                pre.style.fontSize = '13px';
                pre.textContent = texto;
                body.appendChild(pre);
            } else {
                mostrarSemPreview(nomeArquivo);
            }
        } catch (err) {
            console.error(LOG_PREFIX, 'Erro ao carregar arquivo:', err);
            mostrarErro(err.message, url, nomeArquivo);
        }
    }

    // ============================================================
    // RENDERIZAÇÃO DE IMAGEM (via createImageBitmap + canvas)
    // ============================================================
    async function renderizarImagem(blobTipado, nomeArquivo) {
        const body = document.getElementById('smax-preview-body');
        body.classList.add('smax-center-content');
        try {
            // Decodifica o Blob inteiramente em memória — não passa por img-src/CSP
            const bitmap = await createImageBitmap(blobTipado);
            body.innerHTML = '';
            const canvas = document.createElement('canvas');
            canvas.className = 'smax-img-canvas';
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
            bitmap.close();
            body.appendChild(canvas);
        } catch (err) {
            log('createImageBitmap falhou, caindo para <img src="blob:...">:', err);
            body.innerHTML = '';
            const img = document.createElement('img');
            img.alt = nomeArquivo;
            img.src = blobUrlAtual;
            body.appendChild(img);
        }
    }

    // ============================================================
    // RENDERIZAÇÃO PDF (via PDF.js)
    // ============================================================
    async function renderizarPdf(blob, urlOriginal) {
        const body = document.getElementById('smax-preview-body');

        if (typeof pdfjsLib === 'undefined') {
            log('PDF.js indisponível, usando fallback iframe.');
            return fallbackIframePdf(blob);
        }

        try {
            const arrayBuffer = await blob.arrayBuffer();
            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
            pdfDocAtual = await loadingTask.promise;
            log('PDF carregado. Páginas:', pdfDocAtual.numPages);

            const modal = document.getElementById('smax-preview-modal');
            const oldToolbar = document.getElementById('smax-pdf-toolbar');
            if (oldToolbar) oldToolbar.remove();

            const toolbar = document.createElement('div');
            toolbar.id = 'smax-pdf-toolbar';
            toolbar.innerHTML = `
<button id="smax-pdf-prev" title="Página anterior (←)">◀</button>
<span>Pág.</span>
<input type="number" id="smax-pdf-page-input" min="1" max="${pdfDocAtual.numPages}" value="1">
<span>/ ${pdfDocAtual.numPages}</span>
<button id="smax-pdf-next" title="Próxima página (→)">▶</button>
<span class="smax-sep"></span>
<button id="smax-pdf-zoom-out" title="Diminuir zoom">−</button>
<span id="smax-pdf-zoom-label">${Math.round(pdfZoomAtual * 100)}%</span>
<button id="smax-pdf-zoom-in" title="Aumentar zoom">+</button>
<button id="smax-pdf-zoom-fit" title="Ajustar à largura">↔ Ajustar</button>
            `;
            modal.insertBefore(toolbar, body);

            body.classList.remove('smax-center-content');
            body.innerHTML = '<div id="smax-pdf-container"></div>';

            document.getElementById('smax-pdf-prev').addEventListener('click', () => irParaPagina(pdfPaginaAtual - 1));
            document.getElementById('smax-pdf-next').addEventListener('click', () => irParaPagina(pdfPaginaAtual + 1));
            document.getElementById('smax-pdf-page-input').addEventListener('change', (e) => {
                irParaPagina(parseInt(e.target.value, 10) || 1);
            });
            document.getElementById('smax-pdf-zoom-in').addEventListener('click', () => alterarZoom(pdfZoomAtual + 0.2));
            document.getElementById('smax-pdf-zoom-out').addEventListener('click', () => alterarZoom(pdfZoomAtual - 0.2));
            document.getElementById('smax-pdf-zoom-fit').addEventListener('click', () => ajustarZoomLargura());

            pdfPaginaAtual = 1;
            await renderizarPaginaPdf(1);
        } catch (err) {
            console.error(LOG_PREFIX, 'Erro no PDF.js:', err);
            log('Tentando fallback iframe...');
            fallbackIframePdf(blob);
        }
    }

    async function renderizarPaginaPdf(numPagina) {
        if (!pdfDocAtual) return;
        if (numPagina < 1 || numPagina > pdfDocAtual.numPages) return;
        pdfPaginaAtual = numPagina;

        const container = document.getElementById('smax-pdf-container');
        if (!container) return;

        try {
            if (renderTaskAtual) { try { renderTaskAtual.cancel(); } catch(e){} }
            const page = await pdfDocAtual.getPage(numPagina);
            const viewport = page.getViewport({ scale: pdfZoomAtual });

            container.innerHTML = '';
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            container.appendChild(canvas);

            renderTaskAtual = page.render({ canvasContext: ctx, viewport });
            await renderTaskAtual.promise;
            renderTaskAtual = null;

            const input = document.getElementById('smax-pdf-page-input');
            if (input) input.value = numPagina;
            const btnPrev = document.getElementById('smax-pdf-prev');
            const btnNext = document.getElementById('smax-pdf-next');
            if (btnPrev) btnPrev.disabled = numPagina <= 1;
            if (btnNext) btnNext.disabled = numPagina >= pdfDocAtual.numPages;
        } catch (err) {
            if (err && err.name === 'RenderingCancelledException') return;
            console.error(LOG_PREFIX, 'Erro ao renderizar página:', err);
        }
    }

    function irParaPagina(n) {
        if (!pdfDocAtual) return;
        n = Math.max(1, Math.min(pdfDocAtual.numPages, n));
        renderizarPaginaPdf(n);
    }

    function alterarZoom(novoZoom) {
        pdfZoomAtual = Math.max(0.4, Math.min(4, novoZoom));
        const label = document.getElementById('smax-pdf-zoom-label');
        if (label) label.textContent = Math.round(pdfZoomAtual * 100) + '%';
        renderizarPaginaPdf(pdfPaginaAtual);
    }

    async function ajustarZoomLargura() {
        if (!pdfDocAtual) return;
        const page = await pdfDocAtual.getPage(pdfPaginaAtual);
        const viewport = page.getViewport({ scale: 1 });
        const container = document.getElementById('smax-pdf-container');
        const larguraDisp = container.clientWidth - 30;
        alterarZoom(larguraDisp / viewport.width);
    }

    function fallbackIframePdf(blob) {
        const body = document.getElementById('smax-preview-body');
        const blobPdf = blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' });
        blobUrlAtual = URL.createObjectURL(blobPdf);
        body.classList.remove('smax-center-content');
        body.innerHTML = '';
        const iframe = document.createElement('iframe');
        iframe.src = blobUrlAtual;
        body.appendChild(iframe);
    }

    // ============================================================
    // DOCX
    // ============================================================
    async function renderizarDocx(blob, body) {
        if (typeof mammoth === 'undefined') {
            mostrarErro('Biblioteca mammoth.js não foi carregada. Verifique o @require no cabeçalho.');
            return;
        }
        const arrayBuffer = await blob.arrayBuffer();
        const resultado = await mammoth.convertToHtml({ arrayBuffer });
        body.classList.remove('smax-center-content');
        body.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'smax-docx-wrap';
        wrap.innerHTML = `
<p class="smax-docx-aviso">ℹ️ Pré-visualização simplificada — a formatação pode diferir um pouco do arquivo original. Use "Baixar" para ver com fidelidade total no Word.</p>
        `;
        const div = document.createElement('div');
        div.className = 'smax-docx-content';
        div.innerHTML = resultado.value || '<p><i>Documento vazio ou sem conteúdo renderizável.</i></p>';
        wrap.appendChild(div);
        body.appendChild(wrap);
    }

    // ============================================================
    // ERROS E SEM PREVIEW
    // ============================================================
    function mostrarErro(mensagem, url, nomeArquivo) {
        const body = document.getElementById('smax-preview-body');
        if (!body) return;
        body.classList.add('smax-center-content');
        body.innerHTML = `
<div class="smax-erro">
<h3>⚠️ Não foi possível carregar o anexo</h3>
<p>${escapeHtml(mensagem || '')}</p>
<p style="font-size:12px;color:#666;">Você ainda pode tentar abrir o arquivo pelos botões abaixo.</p>
<button id="smax-erro-baixar">⬇ Baixar</button>
<button id="smax-erro-nova-guia">🔍 Nova guia</button>
</div>
        `;
        document.getElementById('smax-erro-baixar').addEventListener('click', () => document.getElementById('smax-btn-baixar').click());
        document.getElementById('smax-erro-nova-guia').addEventListener('click', () => document.getElementById('smax-btn-nova-guia').click());
    }

    function mostrarSemPreview(nomeArquivo) {
        const body = document.getElementById('smax-preview-body');
        if (!body) return;
        body.classList.add('smax-center-content');
        body.innerHTML = `
<div class="smax-sem-preview">
<h3>📎 Pré-visualização não disponível</h3>
<p>O arquivo <b>${escapeHtml(nomeArquivo)}</b> não tem visualizador integrado neste script.</p>
<p style="font-size:13px;color:#666;">Tipos suportados: PDF, imagens (PNG/JPG/GIF/WEBP), DOCX e TXT.</p>
<button id="smax-btn-baixar-fallback">⬇ Baixar arquivo</button>
</div>
        `;
        document.getElementById('smax-btn-baixar-fallback').addEventListener('click', () => document.getElementById('smax-btn-baixar').click());
    }

    function mostrarDocLegado(nomeArquivo) {
        const body = document.getElementById('smax-preview-body');
        if (!body) return;
        body.classList.add('smax-center-content');
        body.innerHTML = `
<div class="smax-sem-preview">
<h3>📄 Formato .doc antigo</h3>
<p><b>${escapeHtml(nomeArquivo)}</b> está no formato binário antigo do Word (.doc), que este visualizador não consegue interpretar — só arquivos .docx modernos.</p>
<p style="font-size:13px;color:#666;">Baixe o arquivo e abra no Word para visualizar.</p>
<button id="smax-btn-baixar-doclegado">⬇ Baixar arquivo</button>
</div>
        `;
        document.getElementById('smax-btn-baixar-doclegado').addEventListener('click', () => document.getElementById('smax-btn-baixar').click());
    }

    // ============================================================
    // COLETA DE ANEXOS DA TELA + INTERCEPTAÇÃO DE CLIQUES
    // ============================================================
    function estaEmTelaDeChamado() {
        return REGEX_TELA_CHAMADO.test(location.href);
    }

    function coletarAnexosDaTela() {
        const links = Array.from(document.querySelectorAll(SELETOR_ANEXO));
        return links.map(link => {
            // link.href (propriedade, não getAttribute) já vem resolvida pelo próprio
            // navegador, respeitando o contexto real do documento (iframe, <base>, etc.).
            // Calcular isso na mão com new URL(href, location.href) dava uma URL errada
            // aqui, porque a tela roda dentro de um iframe com base diferente da página
            // externa — por isso o fetch/$http sempre recebia uma página de erro.
            if (!link.href) return null;
            return {
                nome: (link.textContent || 'anexo').trim(),
                url: link.href,
                elemento: link
            };
        }).filter(Boolean);
    }

    function interceptarClique(e) {
        if (!estaEmTelaDeChamado()) return;
        const link = e.target.closest(SELETOR_ANEXO);
        if (!link) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey) return; // permite ctrl+clique manual

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const lista = coletarAnexosDaTela();
        let indice = lista.findIndex(a => a.elemento === link);

        if (indice === -1) {
            // Fallback: não achou na varredura da tela, monta um item avulso
            const url = link.href;
            const nome = (link.textContent || 'anexo').trim();
            log('Anexo não encontrado na varredura, abrindo avulso:', nome, '→', url);
            abrirModal([{ nome, url, elemento: link }], 0);
            return;
        }

        log(`Anexo interceptado: ${lista[indice].nome} (${indice + 1}/${lista.length}) → ${lista[indice].url}`);
        abrirModal(lista, indice);
    }

    document.addEventListener('click', interceptarClique, true);

    // ============================================================
    // ÍCONE FLUTUANTE DE ANEXOS (atalho, sem precisar descer a tela)
    // ============================================================
    let botaoAnexosEl = null;
    let popoverAnexosEl = null;

    // Âncora dinâmica pros ícones flutuantes: em vez de uma posição fixa em pixels
    // (que quebra quando algo — como o painel de "Consulta rápida" — empurra o
    // conteúdo do chamado pra baixo), calculamos a posição com base num elemento
    // real da tela do chamado, recalculado a cada atualização.
    function calcularAncoraIcones() {
        // O cabeçalho da seção "Detalhes" — pl-entity-page-component-header-text é
        // usado por vários cabeçalhos de seção na tela, então filtramos pelo texto
        // "Detalhes" especificamente (com fallback pro primeiro achado, caso o texto
        // mude por algum motivo).
        const cabecalhos = Array.from(document.querySelectorAll('.pl-entity-page-component-header-text'));
        const ancora = cabecalhos.find(el => el.textContent.trim().startsWith('Detalhes')) || cabecalhos[0];
        if (!ancora) return null;
        const rect = ancora.getBoundingClientRect();
        // Se a seção estiver escondida (ex: modo minimizado ao rolar), o navegador
        // reporta tudo como zero — ignoramos a âncora nesse caso e mantemos a última
        // posição válida, em vez de recalcular pra um valor errado.
        if (rect.width === 0 && rect.height === 0) return null;
        return { top: rect.top + window.scrollY, left: rect.left + window.scrollX, width: rect.width, height: rect.height };
    }

    function posicionarIconesFlutuantes() {
        const ancora = calcularAncoraIcones();
        if (!ancora) return; // sem âncora válida agora, mantém a última posição conhecida

        // Posiciona ao lado direito do texto "Detalhes", centralizado na mesma altura.
        const topBotoes = Math.max(ancora.top + (ancora.height / 2) - 22, 8) + 'px';
        const topPaineis = (ancora.top + ancora.height + 20) + 'px';
        const leftAnexos = (ancora.left + ancora.width + 16) + 'px';
        const leftDados = (ancora.left + ancora.width + 70) + 'px';

        if (botaoAnexosEl) { botaoAnexosEl.style.top = topBotoes; botaoAnexosEl.style.left = leftAnexos; }
        if (botaoDadosEl) { botaoDadosEl.style.top = topBotoes; botaoDadosEl.style.left = leftDados; }
        if (popoverAnexosEl) { popoverAnexosEl.style.top = topPaineis; popoverAnexosEl.style.left = leftAnexos; }
        if (painelDadosEl) { painelDadosEl.style.top = topPaineis; painelDadosEl.style.left = leftDados; }
    }

    function atualizarBotaoFlutuante() {
        const emTela = estaEmTelaDeChamado();
        const lista = emTela ? coletarAnexosDaTela() : [];

        if (!emTela || lista.length === 0) {
            if (botaoAnexosEl) { botaoAnexosEl.remove(); botaoAnexosEl = null; }
            fecharPopoverAnexos();
            return;
        }

        if (!botaoAnexosEl) {
            injetarEstilos();
            botaoAnexosEl = document.createElement('button');
            botaoAnexosEl.id = 'smax-anexos-flutuante';
            botaoAnexosEl.title = 'Anexos desta solicitação';
            botaoAnexosEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg><span id="smax-anexos-badge"></span>';
            botaoAnexosEl.addEventListener('click', (e) => {
                e.stopPropagation();
                alternarPopoverAnexos();
            });
            document.body.appendChild(botaoAnexosEl);
        }

        const badge = document.getElementById('smax-anexos-badge');
        if (badge) badge.textContent = String(lista.length);
        posicionarIconesFlutuantes();
    }

    function alternarPopoverAnexos() {
        if (popoverAnexosEl) {
            fecharPopoverAnexos();
        } else {
            abrirPopoverAnexos();
        }
    }

    function abrirPopoverAnexos() {
        const lista = coletarAnexosDaTela();
        if (!lista.length) return;

        popoverAnexosEl = document.createElement('div');
        popoverAnexosEl.id = 'smax-anexos-popover';

        const header = document.createElement('div');
        header.id = 'smax-anexos-popover-header';
        header.textContent = `📎 Anexos (${lista.length})`;
        popoverAnexosEl.appendChild(header);

        lista.forEach((item, idx) => {
            const tipo = detectarTipo(item.nome);
            const icone = tipo === 'pdf' ? '📕' : tipo === 'imagem' ? '🖼️' : (tipo === 'docx' || tipo === 'doc-legado') ? '📝' : '📎';
            const linha = document.createElement('div');
            linha.className = 'smax-anexos-item';
            linha.innerHTML = `<span class="smax-anexos-item-icone">${icone}</span><span class="smax-anexos-item-nome">${escapeHtml(item.nome)}</span>`;
            linha.addEventListener('click', (e) => {
                e.stopPropagation();
                fecharPopoverAnexos();
                abrirModal(lista, idx);
            });
            popoverAnexosEl.appendChild(linha);
        });

        document.body.appendChild(popoverAnexosEl);
        posicionarIconesFlutuantes();
        setTimeout(() => document.addEventListener('click', handlerFecharPopoverAoClicarFora, true), 0);
    }

    function fecharPopoverAnexos() {
        if (popoverAnexosEl) { popoverAnexosEl.remove(); popoverAnexosEl = null; }
        document.removeEventListener('click', handlerFecharPopoverAoClicarFora, true);
    }

    function handlerFecharPopoverAoClicarFora(e) {
        if (popoverAnexosEl && !popoverAnexosEl.contains(e.target) && e.target !== botaoAnexosEl) {
            fecharPopoverAnexos();
        }
    }

    // ============================================================
    // ÍCONE FLUTUANTE DE DADOS DA SOLICITAÇÃO (solicitante + processo)
    // ============================================================
    let botaoDadosEl = null;
    let painelDadosEl = null;

    // Cache por chamado: busca uma vez em segundo plano (assim que a tela abre) e
    // reaproveita o resultado sempre que o painel for aberto de novo, sem repetir a
    // simulação de hover a cada clique. Só busca de novo se o chamado mudar.
    let dadosSolicitacaoCache = null;
    let promessaDadosSolicitacao = null;
    let urlCacheAtual = null;
    let tentativasAutomaticas = 0;
    const MAX_TENTATIVAS_AUTOMATICAS = 2; // evita ficar tentando sozinho pra sempre em segundo plano

    // forcar=true (usado quando o usuário clica no ícone) sempre tenta buscar de novo
    // se ainda não tiver um resultado válido guardado — mesmo que as tentativas
    // automáticas em segundo plano já tenham desistido antes.
    function garantirDadosSolicitacaoCache(forcar) {
        if (location.href !== urlCacheAtual) {
            urlCacheAtual = location.href;
            dadosSolicitacaoCache = null;
            promessaDadosSolicitacao = null;
            tentativasAutomaticas = 0;
        }
        if (dadosSolicitacaoCache && dadosSolicitacaoCache.pessoa) return Promise.resolve(dadosSolicitacaoCache);
        if (promessaDadosSolicitacao) return promessaDadosSolicitacao;
        if (!forcar && tentativasAutomaticas >= MAX_TENTATIVAS_AUTOMATICAS) {
            return Promise.resolve(dadosSolicitacaoCache || { pessoa: null, processo: extrairNumeroProcesso() });
        }
        tentativasAutomaticas++;

        promessaDadosSolicitacao = (async () => {
            const { pessoa, processoCampo } = await obterDadosSolicitante();
            const processo = processoCampo || extrairNumeroProcesso();
            const resultado = { pessoa, processo };
            if (pessoa) dadosSolicitacaoCache = resultado; // só fixa no cache se deu certo — permite tentar de novo se falhou
            promessaDadosSolicitacao = null;
            return resultado;
        })();
        return promessaDadosSolicitacao;
    }

    function atualizarBotaoDados() {
        const emTela = estaEmTelaDeChamado();
        // Só mostra depois que o formulário do chamado realmente renderizou (mesma
        // checagem usada pra posicionar os ícones) — evita o botão "piscar" antes da
        // página do chamado terminar de carregar, igual já acontecia com o de anexos
        // (que só aparece quando acha um anexo de verdade na tela).
        const formularioRenderizado = emTela && !!document.querySelector('.pl-entity-page-component-header-text');

        if (!formularioRenderizado) {
            if (botaoDadosEl) { botaoDadosEl.remove(); botaoDadosEl = null; }
            fecharPainelDados();
            return;
        }

        if (!botaoDadosEl) {
            injetarEstilos();
            botaoDadosEl = document.createElement('button');
            botaoDadosEl.id = 'smax-dados-flutuante';
            botaoDadosEl.title = 'Dados da solicitação (solicitante + processo)';
            botaoDadosEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>';
            botaoDadosEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (painelDadosEl) { fecharPainelDados(); } else { abrirPainelDados(); }
            });
            document.body.appendChild(botaoDadosEl);
        }

        // Dispara a busca em segundo plano assim que a tela do chamado é detectada,
        // pra já estar pronta (ou quase) quando o usuário clicar no ícone. Antes essa
        // busca automática era restrita à aba Geral porque simulava clique/hover em
        // elementos da tela (risco de efeito colateral se disparada em segundo plano
        // enquanto o usuário compõe uma resposta em Discussões). Agora é uma
        // requisição REST pura, sem tocar em nada da tela — pode rodar em qualquer aba.
        garantirDadosSolicitacaoCache();
        posicionarIconesFlutuantes();
    }

    async function abrirPainelDados() {
        painelDadosEl = document.createElement('div');
        painelDadosEl.id = 'smax-dados-painel';
        painelDadosEl.innerHTML = `
<div id="smax-dados-painel-header">📋 Dados da solicitação</div>
<div id="smax-dados-painel-corpo">
<div class="smax-dados-carregando">Carregando dados do solicitante...</div>
</div>
        `;
        document.body.appendChild(painelDadosEl);
        posicionarIconesFlutuantes();
        setTimeout(() => document.addEventListener('click', handlerFecharPainelDadosAoClicarFora, true), 0);

        const dados = await garantirDadosSolicitacaoCache(true);
        renderizarPainelDados(dados.pessoa, dados.processo);
    }

    function fecharPainelDados() {
        if (painelDadosEl) { painelDadosEl.remove(); painelDadosEl = null; }
        document.removeEventListener('click', handlerFecharPainelDadosAoClicarFora, true);
    }

    function handlerFecharPainelDadosAoClicarFora(e) {
        if (painelDadosEl && !painelDadosEl.contains(e.target) && e.target !== botaoDadosEl) {
            fecharPainelDados();
        }
    }

    function extrairNumeroChamadoAtual() {
        const m = location.pathname.match(/\/saw\/Request\/(\d+)/i);
        return m ? m[1] : null;
    }

    // Nome/matrícula/unidade vinham antes simulando hover no campo "Solicitado
    // para" da propria tela pra abrir o card do Angular e ler o texto de dentro
    // dele — trocado pela mesma requisição REST que a Consulta Rápida (Módulo 1)
    // já usa, via ponte em window.__tjspDadosSolicitacaoBridge. Sem simulação de
    // clique/hover nenhuma na tela real: elimina o "flash" do card e o efeito
    // colateral de mexer no "Mostrar mais" da aba Geral enquanto o usuário
    // compõe uma resposta em Discussões.
    async function obterDadosSolicitante() {
        const numeroChamado = extrairNumeroChamadoAtual();
        if (!numeroChamado || !window.__tjspDadosSolicitacaoBridge) {
            return { pessoa: null, processoCampo: extrairNumeroProcesso() };
        }
        try {
            const dados = await window.__tjspDadosSolicitacaoBridge.buscar(numeroChamado);
            const pessoa = dados.nome ? { nome: dados.nome, matricula: dados.matricula, unidade: dados.unidade } : null;
            const processoCampo = (dados.processo && dados.processo !== 'N/A') ? dados.processo : extrairNumeroProcesso();
            return { pessoa, processoCampo };
        } catch (err) {
            log('Falha ao buscar dados da solicitação via REST:', err);
            return { pessoa: null, processoCampo: extrairNumeroProcesso() };
        }
    }

    function extrairNumeroProcesso() {
        const texto = document.body.innerText || '';
        const match = texto.match(REGEX_PROCESSO);
        return match ? match[0] : null;
    }

    function renderizarPainelDados(dadosPessoa, processo) {
        const corpo = document.getElementById('smax-dados-painel-corpo');
        if (!corpo) return;

        if (!dadosPessoa) {
            corpo.innerHTML = '<div class="smax-dados-vazio">Não consegui localizar os dados do solicitante nesta tela.</div>';
            return;
        }

        const linhas = [
            { rotulo: 'Solicitante', valor: dadosPessoa.nome || '—' },
            { rotulo: 'Matrícula', valor: dadosPessoa.matricula || '—' },
            { rotulo: 'Unidade', valor: dadosPessoa.unidade || '—' },
            { rotulo: 'Processo', valor: processo || 'não encontrado no texto' }
        ];

        corpo.innerHTML = linhas.map((l, i) => `
<div class="smax-dados-item">
<div class="smax-dados-item-texto">
<span class="smax-dados-item-rotulo">${escapeHtml(l.rotulo)}</span>
<span class="smax-dados-item-valor" title="${escapeHtml(l.valor)}">${escapeHtml(l.valor)}</span>
</div>
<button class="smax-dados-copiar" data-idx="${i}" title="Copiar">${ICONE_COPIAR}</button>
</div>
        `).join('') + '<button id="smax-dados-copiar-tudo">Copiar tudo</button>';

        linhas.forEach((l, i) => {
            const btn = corpo.querySelector(`.smax-dados-copiar[data-idx="${i}"]`);
            if (btn) btn.addEventListener('click', () => copiarTexto(l.valor, btn));
        });

        const btnTudo = document.getElementById('smax-dados-copiar-tudo');
        const resumo = linhas.map(l => `${l.rotulo}: ${l.valor}`).join('\n');
        if (btnTudo) btnTudo.addEventListener('click', () => copiarTexto(resumo, btnTudo));
    }

    function copiarTexto(texto, botao) {
        // innerHTML (nao textContent) pra funcionar tanto no botao "Copiar tudo"
        // (texto puro) quanto nos botoes-icone .smax-dados-copiar (agora SVG em vez
        // de emoji) — textContent de um botao com SVG dentro vem vazio, e reverter
        // pra vazio apagava o icone depois do "✓".
        navigator.clipboard.writeText(texto).then(() => {
            const original = botao.innerHTML;
            botao.innerHTML = '✓';
            setTimeout(() => { botao.innerHTML = original; }, 1200);
        }).catch(err => log('Falha ao copiar para a área de transferência:', err));
    }

    // A tela é uma SPA Angular — o conteúdo troca sem recarregar a página, então
    // "load"/"DOMContentLoaded" não bastam pra saber quando um novo chamado abriu.
    // Observamos mudanças no DOM (com debounce) pra reavaliar os botões flutuantes.
    let debounceBotaoFlutuante = null;
    const observadorPagina = new MutationObserver(() => {
        clearTimeout(debounceBotaoFlutuante);
        debounceBotaoFlutuante = setTimeout(() => {
            atualizarBotaoFlutuante();
            atualizarBotaoDados();
        }, 400);
    });
    observadorPagina.observe(document.body, { childList: true, subtree: true });
    atualizarBotaoFlutuante();
    atualizarBotaoDados();

    log('✅ Script de visualização de anexos ativo. Versão 0.20');
    log('   Busca de arquivo via $http do Angular (fallback: fetch). Imagens via createImageBitmap+canvas.');
    log('   PDF via PDF.js com worker pré-carregado por @require (sem depender de rede em tempo de execução).');
    log('   Navegação entre anexos: setas laterais no modal ou Alt+←/Alt+→');
    log('   Ícone flutuante de anexos (📎) ativo no canto superior esquerdo, quando há anexos no chamado.');

    // Ponte pro Módulo 1 (Robô de Automações — outra IIFE, escopo separado):
    // permite que a Consulta Rápida abra anexos no mesmo visualizador, em vez
    // de duplicar toda essa lógica de PDF.js/mammoth/canvas noutro lugar.
    window.__tjspAnexosViewer = { abrir: abrirModal, fechar: fecharModal };
})();
