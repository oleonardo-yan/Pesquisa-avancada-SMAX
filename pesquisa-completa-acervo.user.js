// ==UserScript==
// @name         TJSP Suporte - Pesquisa Completa no Acervo SMAX
// @namespace    http://tampermonkey.net/
// @version      0.16.0
// @description  Busca exaustiva (sem corte de relevância) no acervo completo das GSEs, com filtros avançados, busca por termos (Descrição/Solução/Discussão) OU por semelhança (BM25, 100% local, sem IA), navegação entre resultados, modo expandido, seleção para exportação e exportação em CSV/JSON/TXT/HTML.
// @author       Leonardo
// @match        https://suporte.tjsp.jus.br/saw/Requests*
// @grant        none
// ==/UserScript==

/*
 * COMO FUNCIONA:
 * 1. O SMAX bloqueia filtro de texto em Description/Solution (campo "não
 *    pesquisável" — confirmado ao vivo, erro 500 "IllegalArgumentException").
 *    Por isso a consulta ao servidor filtra SÓ por AssignedToGroup (campo
 *    estruturado, permitido); o texto é comparado inteiramente no navegador,
 *    depois que os dados já chegaram.
 * 2. O SMAX também recusa qualquer consulta cujo total combinado ultrapasse
 *    10.000 entidades (erro 400 "query.num.of.entities.exceeded" — também
 *    confirmado ao vivo). Solução: medir o total de CADA GSE individualmente
 *    e agrupar dinamicamente em lotes que fiquem sempre abaixo do teto (uma
 *    GSE muito movimentada pode ficar sozinha; várias paradas podem ir juntas
 *    no mesmo lote), paginando cada lote em paralelo até esgotar.
 * 3. Tudo fica em memória nesta aba — nada é salvo em disco, nada é enviado
 *    a lugar nenhum. As exportações (CSV/JSON/TXT/HTML) geram o arquivo
 *    localmente no navegador, sob demanda, só quando você clica.
 * 4. A busca por semelhança compara o texto colado com cada solicitação já
 *    carregada usando BM25 (o mesmo tipo de algoritmo de ranking por
 *    relevância usado por buscadores de texto como o Elasticsearch) — roda
 *    inteiramente no navegador, sem nenhuma chamada de rede ou de IA.
 */

(function () {
    "use strict";

    const VERSION = "0.16.0";
    const CONCURRENCY = 10; // era 6 — mais requisições em paralelo, teste se o SMAX aguenta bem
    const PAGE_SIZE = 500; // era 250 — menos idas e vindas pra carregar o mesmo tanto de dados
    const PAGE_RESULTS = 15;
    const BATCH_SAFETY_LIMIT = 9500; // teto real do SMAX é 10.000; margem de segurança
    const OPEN_SELECTED_CAP = 15; // limite ao abrir várias abas de uma vez (evita bloqueio de pop-up)
    const THEME_STORAGE_KEY = "tjspArchivoTema"; // "dark" ou "light", por navegador/pessoa
    const STATS_VIEW_STORAGE_KEY = "tjspArchivoStatsView"; // "table" ou "grid"
    const PREFS_STORAGE_KEY = "tjspArchivoPreferencias"; // combinações de filtro da Busca Estatística, só neste navegador
    const PREFS_SHARE_PREFIX = "TJSP-PREF1:"; // marca o código de compartilhamento (copiar/colar) e sua versão de formato
    const PREFS_VISIBLE_FAVORITES = 3; // só as favoritas viram chip fixo — o resto fica em "Ver todas"

    // Busca por semelhança (BM25) — 100% local, sem chamada de rede/IA.
    const BM25_K1 = 1.4;
    const BM25_B = 0.75;
    const SEMANTIC_MIN_TOKEN_LEN = 3;
    const SEMANTIC_DEFAULT_LIMIT = 50;
    const STOPWORDS_PT = new Set([
        "a", "ao", "aos", "aquela", "aquelas", "aquele", "aqueles", "aquilo", "as", "até", "com", "como",
        "da", "das", "de", "dela", "delas", "dele", "deles", "depois", "do", "dos", "e", "ela", "elas",
        "ele", "eles", "em", "entre", "era", "eram", "essa", "essas", "esse", "esses", "esta", "estas",
        "este", "estes", "estava", "estavam", "está", "estão", "eu", "foi", "foram", "fosse", "há",
        "isso", "isto", "já", "lhe", "lhes", "mais", "mas", "me", "mesmo", "meu", "meus", "minha", "minhas",
        "muito", "muita", "muitos", "muitas", "na", "nas", "nem", "no", "nos", "nossa", "nossas", "nosso",
        "nossos", "num", "numa", "não", "nós", "o", "os", "ou", "para", "pela", "pelas", "pelo", "pelos",
        "perante", "pois", "por", "porque", "porquê", "pra", "pro", "qual", "quando", "que", "quem",
        "se", "sem", "ser", "seu", "seus", "sob", "sobre", "somos", "sua", "suas", "são", "também",
        "te", "tem", "têm", "tendo", "ter", "teu", "teus", "teve", "tinha", "tinham", "tive", "tu", "tua",
        "tuas", "um", "uma", "umas", "uns", "você", "vocês", "vos"
    ]);
    const ARCHIVE_LAYOUT_BASE = [
        "Id", "Description", "Solution", "CreateTime",
        "RequestedForPerson", "RequestedForPerson.Name", "RequestedForPerson.IsVIP",
        "AssignedToPerson", "AssignedToPerson.Name",
        "AssignedToGroup", "AssignedToGroup.Name",
        "RegisteredForLocation", "RegisteredForLocation.DisplayName",
        "StatusSCCDSMAX_c", "Status"
    ].join(",");

    const GSES = [
        ["51642955", "GSE - SGS - EPROC 1G - ACIV"],
        ["51642761", "GSE - SGS - EPROC 1G - AEXCRIM"],
        ["51642956", "GSE - SGS - EPROC 1G - ACRIM"],
        ["51644373", "GSE - SGS - EPROC 1G - CEJUSCS"],
        ["51643315", "GSE - SGS - EPROC 1G - CERT"],
        ["51642766", "GSE - SGS - EPROC 1G - CLMAND"],
        ["51642767", "GSE - SGS - EPROC 1G - COLREC"],
        ["51642772", "GSE - SGS - EPROC 1G - DISTR"],
        ["51643432", "GSE - SGS - EPROC 1G - OFJUST"],
        ["51642957", "GSE - SGS - EPROC 1G - JUIESP"],
        ["51643437", "GSE - SGS - EPROC 1G - OAJUDS"],
        ["51642954", "GSE - SGS - EPROC - PLANTAO"],
        ["66561429", "GSE - SGS - EPROC - MIGRACAO 1G"],
        ["67109543", "GSE - SGS - EPROC 1G - HOMOLOGACAO"],
        ["61730998", "GSE - SGS - EPROC - CONFIG"]
    ];
    const GSE_NAME = Object.fromEntries(GSES);

    let host, ui;
    let archive = [];
    let archiveLoadedAt = null;
    let archiveLoading = false;
    let archiveCancelled = false;
    let results = [];
    let currentPage = 1;
    let sortMode = "recent";
    let lastQueryTerms = [];
    let activeIndex = -1;
    let focusedIndex = -1;
    let searchMode = "terms";
    let archiveIncludesDiscussion = false;
    let lastSearchIncludedDiscussion = false;
    let loadedSignature = null;
    let liveSearchDuringLoad = null;
    let statsViewMode = "table"; // "table" (padrão) ou "grid" — só usado na Busca Estatística
    let statsPreferences = []; // preferências de filtro salvas (Busca Estatística), carregadas do localStorage no init
    let semanticIndex = null;
    let semanticScores = new Map();
    let semanticMaxScore = 1;
    const selectedIds = new Set();

    // ============================================================
    // REDE
    // ============================================================
    function getRestBase() {
        for (const entry of performance.getEntriesByType("resource")) {
            const match = String(entry.name || "").match(/^(https?:\/\/[^/]+\/rest\/\d+)/i);
            if (match) return match[1];
        }
        return location.origin + "/rest/213963628";
    }

    function getXsrfToken() {
        const names = ["XSRF-TOKEN", "X-XSRF-TOKEN", "CSRF-TOKEN", "X-CSRF-TOKEN"];
        for (const part of String(document.cookie || "").split(";")) {
            const pos = part.indexOf("=");
            if (pos < 0) continue;
            const name = part.slice(0, pos).trim();
            if (!names.includes(name)) continue;
            const value = part.slice(pos + 1).trim();
            try { return decodeURIComponent(value); } catch (_) { return value; }
        }
        for (const storage of [sessionStorage, localStorage]) {
            for (const name of [...names, "xsrfToken", "csrfToken"]) {
                try { const value = storage.getItem(name); if (value) return value; } catch (_) {}
            }
        }
        return "";
    }

    function requestHeaders() {
        const headers = { "Accept": "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest", "X-Requested-By": "XMLHttpRequest" };
        const token = getXsrfToken();
        if (token) { headers["X-XSRF-TOKEN"] = token; headers["X-CSRF-TOKEN"] = token; }
        return headers;
    }

    async function fetchJson(url, options) {
        const response = await fetch(url, Object.assign({ method: "GET", credentials: "same-origin", headers: requestHeaders() }, options || {}));
        const raw = await response.text();
        let data;
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
        if (!response.ok) {
            const error = new Error((data.message) || (data.developer_message) || data.raw || `HTTP ${response.status}`);
            error.messageKey = data.message_key || "";
            throw error;
        }
        return data;
    }

    // O SMAX recusa QUALQUER consulta (mesmo pedindo 1 registro, ou uma página
    // de 250) quando o total de entidades que o filtro encontra passa de
    // 10.000 — confirmado ao vivo: uma única GSE (ACIV) já ultrapassa isso
    // sozinha. Detectamos esse erro específico pela chave estruturada (mais
    // confiável que comparar o texto traduzido da mensagem).
    function isExceededError(error) {
        return !!error && (error.messageKey === "query.num.of.entities.exceeded" || /excedeu o m.ximo/i.test(error.message || ""));
    }

    // Preserva o item original no erro (item.item) para que falhas possam ser
    // atribuídas à GSE/página correta em vez de somem sem explicação.
    async function concurrentMap(items, worker, onProgress) {
        const output = new Array(items.length);
        let cursor = 0, done = 0;
        async function runner() {
            while (!archiveCancelled) {
                const index = cursor++;
                if (index >= items.length) return;
                try { output[index] = await worker(items[index]); }
                catch (error) { output[index] = { error, item: items[index] }; }
                if (onProgress) onProgress(++done, items.length);
            }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, runner));
        return output;
    }

    // ============================================================
    // MEDIÇÃO DE VOLUME + PLANEJAMENTO DE LOTES
    //
    // "Unidade" = um pedaço pesquisável com contagem confirmada abaixo do
    // teto: normalmente uma GSE inteira, mas quando uma GSE sozinha já passa
    // de 10.000 (caso real: ACIV), ela é dividida recursivamente por período
    // até cada pedaço caber. As unidades finais são então empacotadas em
    // lotes (várias unidades combinadas por "ou") para minimizar requisições.
    // ============================================================
    function combineClauses(clauses) {
        return clauses.length === 1 ? clauses[0] : "(" + clauses.join(" or ") + ")";
    }

    async function fetchFilterCount(filterClause) {
        const params = new URLSearchParams({ filter: filterClause, layout: "Id", meta: "totalCount", size: "1", skip: "0" });
        const payload = await fetchJson(`${getRestBase()}/ems/Request?${params}`);
        return Number((payload.meta && payload.meta.total_count) || 0);
    }

    // Restrição opcional por pessoa (Solicitado para / Designado Especialista),
    // preenchida só quando o usuário escolhe uma sugestão do autocomplete (que
    // resolve o ID exato da pessoa — o filtro nativo exige ID, não nome parcial).
    // Vazio = comportamento de sempre (carrega tudo das GSEs selecionadas).
    function personConstraintClause() {
        const clauses = [];
        const specialistId = ui.specialist.dataset.personId;
        const requesterId = ui.requestedFor.dataset.personId;
        if (specialistId) clauses.push(`AssignedToPerson = '${specialistId}'`);
        if (requesterId) clauses.push(`RequestedForPerson = '${requesterId}'`);
        return clauses.length ? clauses.join(" and ") : "";
    }

    function baseGseClause(gseId) {
        const extra = personConstraintClause();
        return extra ? `(AssignedToGroup = '${gseId}') and (${extra})` : `(AssignedToGroup = '${gseId}')`;
    }

    async function fetchGseTotal(gseId) {
        return fetchFilterCount(baseGseClause(gseId));
    }

    // A contagem por GSE é leve, então vale uma segunda tentativa automática
    // antes de desistir — falhas de rede transitórias não devem excluir uma
    // GSE inteira da carga silenciosamente. Erros de "excedeu o máximo" não
    // são reretentados aqui (são determinísticos, não transitórios) — sobem
    // direto para quem chamou tratar via divisão por data.
    async function fetchGseTotalWithRetry(gseId) {
        try { return await fetchGseTotal(gseId); }
        catch (error) {
            if (isExceededError(error)) throw error;
            await new Promise(resolve => setTimeout(resolve, 500));
            return await fetchGseTotal(gseId);
        }
    }

    const ARCHIVE_EARLIEST_TIME = new Date(2010, 0, 1).getTime();
    const ARCHIVE_LATEST_TIME = Date.now() + 86400000;
    const MIN_SPLIT_RANGE_MS = 6 * 60 * 60 * 1000; // não divide abaixo de 6h — evita recursão sem fim

    function dateRangeClause(gseId, from, to) {
        const extra = personConstraintClause();
        const base = `(AssignedToGroup = '${gseId}') and (CreateTime >= ${from} and CreateTime < ${to})`;
        return extra ? `${base} and (${extra})` : base;
    }

    // Bisecção recursiva: tenta contar o intervalo inteiro; se o SMAX recusar
    // por excesso, parte o intervalo ao meio e tenta cada metade, repetindo
    // até cada pedaço confirmar uma contagem real abaixo do teto.
    async function splitByDateUntilSafe(gseId, label, from, to, depth) {
        const clause = dateRangeClause(gseId, from, to);
        try {
            const total = await fetchFilterCount(clause);
            return [{ filterClause: clause, total, label }];
        } catch (error) {
            if (!isExceededError(error) || (to - from) <= MIN_SPLIT_RANGE_MS || (depth || 0) > 24) {
                // Não deu pra confirmar isoladamente (intervalo já mínimo); segue
                // mesmo assim com uma estimativa conservadora do teto.
                return [{ filterClause: clause, total: BATCH_SAFETY_LIMIT, label: `${label} (período muito denso, estimado)` }];
            }
            const mid = from + Math.floor((to - from) / 2);
            const left = await splitByDateUntilSafe(gseId, label, from, mid, (depth || 0) + 1);
            const right = await splitByDateUntilSafe(gseId, label, mid, to, (depth || 0) + 1);
            return left.concat(right);
        }
    }

    // Empacotamento guloso: ordena unidades da maior pra menor e vai enchendo
    // lotes sem ultrapassar o teto de segurança. Uma unidade sozinha maior que
    // o teto vira seu próprio lote (fica sinalizada, mas a tentativa segue).
    function planBatches(units) {
        const sorted = units.slice().sort((a, b) => b.total - a.total);
        const batches = [];
        for (const entry of sorted) {
            let target = batches.find(batch => batch.total + entry.total <= BATCH_SAFETY_LIMIT);
            if (!target) { target = { clauses: [], labels: [], total: 0 }; batches.push(target); }
            target.clauses.push(entry.filterClause);
            target.labels.push(entry.label);
            target.total += entry.total;
        }
        return batches;
    }

    // ============================================================
    // CARGA DO ACERVO (paginação paralela por lote)
    // ============================================================
    function htmlToText(html) {
        const box = document.createElement("div");
        box.innerHTML = String(html || "");
        box.querySelectorAll("script,style").forEach(node => node.remove());
        box.querySelectorAll("img").forEach(node => node.replaceWith(document.createTextNode("\n[Imagem anexada]\n")));
        box.querySelectorAll("br").forEach(node => node.replaceWith(document.createTextNode("\n")));
        box.querySelectorAll("li").forEach(node => {
            node.insertBefore(document.createTextNode("• "), node.firstChild);
            node.appendChild(document.createTextNode("\n"));
        });
        box.querySelectorAll("p,div,tr,section,article,h1,h2,h3,h4,h5,h6").forEach(node => node.appendChild(document.createTextNode("\n\n")));
        return (box.textContent || "")
            .replace(/ /g, " ")
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n[ \t]+/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .replace(/[ \t]{2,}/g, " ")
            .trim();
    }

    // Comments vem como JSON-string (mesmo formato já confirmado na Consulta
    // Rápida): {"Comment":[{IsSystem,CommentBody,CreateTime,...}]}. Mensagens
    // de sistema ("Request has been assigned" etc.) são descartadas — só
    // texto humano entra na busca por Discussão, senão o "match" fica poluído
    // por frases repetidas em praticamente todo chamado.
    function parseDiscussion(rawComments) {
        let parsed;
        try { parsed = JSON.parse(rawComments || "{}"); } catch (_) { return ""; }
        const comments = Array.isArray(parsed.Comment) ? parsed.Comment : [];
        return comments
            .filter(comment => !comment.IsSystem && comment.CommentBody)
            .sort((a, b) => (a.CreateTime || 0) - (b.CreateTime || 0))
            .map(comment => htmlToText(comment.CommentBody))
            .filter(Boolean)
            .join("\n\n");
    }

    function normalizeRecord(entity) {
        const p = entity.properties || {};
        const related = entity.related_properties || {};
        const groupId = String((p.AssignedToGroup && (p.AssignedToGroup.Id || p.AssignedToGroup)) || "");
        const requester = related.RequestedForPerson || {};
        const location = related.RegisteredForLocation || {};
        return {
            id: String(p.Id || ""),
            description: htmlToText(p.Description),
            solution: htmlToText(p.Solution),
            discussion: parseDiscussion(p.Comments),
            requestedFor: requester.Name || String(p["RequestedForPerson.Name"] || "Não informado"),
            isVip: requester.IsVIP === true || requester.IsVIP === "true",
            assignedSpecialist: (related.AssignedToPerson && related.AssignedToPerson.Name) || String(p["AssignedToPerson.Name"] || "Não informado"),
            unidade: location.DisplayName || String(p["RegisteredForLocation.DisplayName"] || "") || "Não informada",
            // Status e Status Operacional são campos DIFERENTES e vêm
            // preenchidos ao mesmo tempo (confirmado ao vivo: "Em andamento"
            // e "Aguardando Atendimento" simultâneos) — cada um com seu
            // próprio filtro, sem sobrepor um no outro.
            status: String(p.Status || "").trim(),
            statusOperacional: String(p.StatusSCCDSMAX_c || "").trim(),
            groupId,
            groupName: GSE_NAME[groupId] || groupId || "Não informado",
            created: p.CreateTime || ""
        };
    }

    async function fetchBatchPage(filterClause, skip, layout) {
        const params = new URLSearchParams({ filter: filterClause, layout, order: "CreateTime desc", size: String(PAGE_SIZE), skip: String(skip) });
        const payload = await fetchJson(`${getRestBase()}/ems/Request?${params}`);
        const entities = Array.isArray(payload.entities) ? payload.entities : [];
        return entities.map(normalizeRecord).filter(item => item.id);
    }

    async function loadArchive() {
        if (archiveLoading) return;
        archiveLoading = true;
        archiveCancelled = false;
        archive = [];
        semanticIndex = null;
        selectedIds.clear();
        // Comments só entra no layout (e portanto no download) quando a caixa
        // "Discussão" está marcada NA HORA de carregar — evita o custo extra
        // de payload em cargas onde ninguém vai buscar nesse campo.
        const includeDiscussion = ui.fieldDiscussion.checked;
        const layout = includeDiscussion ? `${ARCHIVE_LAYOUT_BASE},Comments` : ARCHIVE_LAYOUT_BASE;
        archiveIncludesDiscussion = includeDiscussion;
        loadedSignature = computeLoadSignature();
        ui.loadButton.disabled = true;
        ui.cancelLoad.hidden = false;
        ui.search.disabled = true;
        ui.semanticSearch.disabled = true;
        ui.exportButton.disabled = true;
        ui.copyButton.disabled = true;
        const personNote = [
            ui.specialist.dataset.personId ? `Designado Especialista: ${ui.specialist.value}` : "",
            ui.requestedFor.dataset.personId ? `Solicitado para: ${ui.requestedFor.value}` : ""
        ].filter(Boolean).join(" · ");
        setStatus(personNote ? `Medindo o volume (restrito a ${personNote})...` : "Medindo o volume de cada GSE selecionada...", "info");
        setProgress("Consultando totais por GSE...", 2);

        try {
            const groupIds = selectedGseIds();
            if (!groupIds.length) throw new Error("Selecione ao menos um GSE no painel de filtros.");

            let countsDone = 0;
            const perGseUnits = await concurrentMap(groupIds, async id => {
                const label = GSE_NAME[id] || id;
                try {
                    const total = await fetchGseTotalWithRetry(id);
                    countsDone++;
                    setProgress(`Medindo volume: ${countsDone} de ${groupIds.length} GSEs`, 2 + Math.round((countsDone / groupIds.length) * 8));
                    return [{ filterClause: baseGseClause(id), total, label }];
                } catch (error) {
                    if (!isExceededError(error)) throw error;
                    setProgress(`${label} tem mais de 10.000 solicitações — dividindo por período...`, 2 + Math.round((countsDone / groupIds.length) * 8));
                    const units = await splitByDateUntilSafe(id, label, ARCHIVE_EARLIEST_TIME, ARCHIVE_LATEST_TIME, 0);
                    countsDone++;
                    setProgress(`Medindo volume: ${countsDone} de ${groupIds.length} GSEs`, 2 + Math.round((countsDone / groupIds.length) * 8));
                    return units;
                }
            });
            if (archiveCancelled) throw new Error("Carga cancelada.");

            const units = [];
            const failedCounts = [];
            perGseUnits.forEach(entry => {
                if (Array.isArray(entry)) units.push(...entry);
                else if (entry && entry.error) failedCounts.push(entry);
            });

            const batches = planBatches(units);
            const grandTotal = units.reduce((sum, item) => sum + item.total, 0);

            const warnings = [];
            if (failedCounts.length) {
                const details = failedCounts.map(entry => {
                    const name = GSE_NAME[entry.item] || entry.item;
                    const reason = entry.error && entry.error.message ? entry.error.message : "erro desconhecido";
                    return `${name} [${reason}]`;
                }).join("; ");
                warnings.push(`Não foi possível medir (ficaram de fora): ${details}`);
            }
            const oversized = batches.filter(batch => batch.total > BATCH_SAFETY_LIMIT);
            if (oversized.length) {
                warnings.push(`${oversized.length} lote(s) sozinho(s) passam da margem de segurança (${BATCH_SAFETY_LIMIT.toLocaleString("pt-BR")})`);
            }

            setProgress(`Carregando acervo: 0 de ${grandTotal.toLocaleString("pt-BR")} solicitações`, 10);

            const totalPages = batches.reduce((sum, batch) => sum + Math.max(1, Math.ceil(batch.total / PAGE_SIZE)), 0) || 1;
            let pagesDone = 0;
            let loadedCount = 0;
            const failedBatches = [];

            for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
                if (archiveCancelled) break;
                const batch = batches[batchIndex];
                const combinedFilter = combineClauses(batch.clauses);
                const pageCount = Math.max(1, Math.ceil(batch.total / PAGE_SIZE));
                const pageIndexes = Array.from({ length: pageCount }, (_, index) => index * PAGE_SIZE);
                try {
                    const pages = await concurrentMap(pageIndexes, async skip => {
                        const records = await fetchBatchPage(combinedFilter, skip, layout);
                        pagesDone++;
                        loadedCount += records.length;
                        setProgress(`Carregando acervo (lote ${batchIndex + 1} de ${batches.length}): ${loadedCount.toLocaleString("pt-BR")} solicitações`, 10 + Math.round((pagesDone / totalPages) * 88));
                        return records;
                    });
                    pages.forEach(page => { if (Array.isArray(page)) archive.push(...page); });
                    if (liveSearchDuringLoad) { try { liveSearchDuringLoad(); } catch (_) {} }
                } catch (error) {
                    failedBatches.push(batch.labels.join(", "));
                }
            }

            if (archiveCancelled) { setStatus("Carga cancelada pelo usuário.", "warning"); return; }

            const byId = new Map();
            archive.forEach(item => byId.set(item.id, item));
            archive = Array.from(byId.values());
            archiveLoadedAt = new Date();

            setProgress(`Acervo carregado: ${archive.length.toLocaleString("pt-BR")} solicitações`, 100);
            if (failedBatches.length) warnings.push(`Falha ao carregar: ${failedBatches.join(" | ")}`);
            const warningNote = warnings.length ? ` ⚠ ${warnings.join(" · ")}. Clique em "Carregar acervo completo" de novo para tentar reaver o que faltou.` : "";
            setStatus(`Acervo pronto (${archive.length.toLocaleString("pt-BR")} solicitações, ${batches.length} lote(s)) — carregado às ${archiveLoadedAt.toLocaleTimeString("pt-BR")}.${warningNote}`, warnings.length ? "warning" : "success");
            ui.search.disabled = false;
            ui.semanticSearch.disabled = false;
            ui.copyButton.disabled = !archive.length;
            ui.exportButton.disabled = !archive.length;
            renderStats();
        } catch (error) {
            setStatus(error.message || String(error), "error");
        } finally {
            archiveLoading = false;
            ui.loadButton.disabled = false;
            ui.cancelLoad.hidden = true;
        }
    }

    function selectedGseIds() {
        return Array.from(ui.gseList.querySelectorAll("input[data-gse]:checked")).map(input => input.value);
    }

    // "Assinatura" do que está carregado — tudo que muda o que precisa vir do
    // servidor (GSEs, pessoa filtrada, se Discussão entra no layout). Muda
    // filtro de texto/data/VIP NÃO entra aqui, porque esses são aplicados
    // 100% em cima do que já está em memória, sem precisar recarregar nada.
    function computeLoadSignature() {
        const gseIds = selectedGseIds().slice().sort().join(",");
        const specialistId = ui.specialist.dataset.personId || "";
        const requesterId = ui.requestedFor.dataset.personId || "";
        const discussion = ui.fieldDiscussion.checked ? "1" : "0";
        return `${gseIds}|${specialistId}|${requesterId}|${discussion}`;
    }

    // Chamado no início de "Pesquisar"/"Buscar casos semelhantes" — só
    // recarrega quando de fato precisa (nada carregado ainda, ou os filtros
    // que afetam o servidor mudaram desde a última carga). Se um callback é
    // passado (busca por termos), ele é acionado a cada lote que chega
    // durante a carga, pra mostrar resultados parciais em vez de deixar a
    // tela em branco até tudo terminar.
    async function ensureArchiveLoaded(onBatchComplete) {
        if (!archive.length || loadedSignature !== computeLoadSignature()) {
            liveSearchDuringLoad = onBatchComplete || null;
            try { await loadArchive(); }
            finally { liveSearchDuringLoad = null; }
        }
    }

    // ============================================================
    // PESQUISA TEXTUAL (operadores lógicos)
    // ============================================================
    function normalize(value, ignoreCase, ignoreAccents) {
        let text = String(value || "");
        if (ignoreAccents) try { text = text.normalize("NFD").replace(/[̀-ͯ]/g, ""); } catch (_) {}
        return ignoreCase ? text.toLocaleLowerCase("pt-BR") : text;
    }

    function tokenize(query, defaultJoin) {
        const output = [];
        const regex = /"([^"]*)"|\(|\)|\b(?:AND|OR|NOT|E|OU|NAO|NÃO)\b|-?[^\s()]+/giu;
        let match;
        while ((match = regex.exec(query))) {
            const raw = match[0], upper = raw.toLocaleUpperCase("pt-BR");
            if (match[1] != null) output.push({ type: "TERM", value: match[1] });
            else if (raw === "(" || raw === ")") output.push({ type: raw });
            else if (["AND", "E"].includes(upper)) output.push({ type: "AND" });
            else if (["OR", "OU"].includes(upper)) output.push({ type: "OR" });
            else if (["NOT", "NAO", "NÃO"].includes(upper)) output.push({ type: "NOT" });
            else if (raw.startsWith("-") && raw.length > 1) output.push({ type: "NOT" }, { type: "TERM", value: raw.slice(1) });
            else output.push({ type: "TERM", value: raw });
        }
        const withDefault = [];
        for (const token of output) {
            const previous = withDefault[withDefault.length - 1];
            if (previous && ["TERM", ")"].includes(previous.type) && ["TERM", "(", "NOT"].includes(token.type)) withDefault.push({ type: defaultJoin });
            withDefault.push(token);
        }
        return withDefault;
    }

    function toRpn(tokens) {
        const output = [], stack = [], priority = { OR: 1, AND: 2, NOT: 3 };
        for (const token of tokens) {
            if (token.type === "TERM") output.push(token);
            else if (token.type === "(") stack.push(token);
            else if (token.type === ")") {
                while (stack.length && stack[stack.length - 1].type !== "(") output.push(stack.pop());
                if (!stack.length) throw new Error("Parênteses não balanceados.");
                stack.pop();
            } else {
                while (stack.length && stack[stack.length - 1].type !== "(" && priority[stack[stack.length - 1].type] >= priority[token.type]) output.push(stack.pop());
                stack.push(token);
            }
        }
        while (stack.length) {
            const token = stack.pop();
            if (token.type === "(") throw new Error("Parênteses não balanceados.");
            output.push(token);
        }
        return output;
    }

    function compileMatcher(query, mode, ignoreCase, ignoreAccents) {
        const trimmed = query.trim();
        if (!trimmed) throw new Error("Digite um termo ou expressão de pesquisa.");
        if (mode === "exact") {
            // O usuário costuma digitar (ou inserir via botão) as aspas mesmo já
            // estando no modo "Expressão exata" — sem remover, a comparação
            // nunca batia, porque a descrição/solução nunca contém aspas
            // literais ao redor da frase.
            const phrase = normalize(trimmed.replace(/^"|"$/g, ""), ignoreCase, ignoreAccents);
            if (!phrase) throw new Error("Digite um termo ou expressão de pesquisa.");
            return text => text.includes(phrase);
        }
        const normalized = normalize(trimmed, ignoreCase, ignoreAccents);
        if (!normalized) throw new Error("Digite um termo ou expressão de pesquisa.");
        const expression = toRpn(tokenize(query, "OR").map(token => token.type === "TERM" ? Object.assign({}, token, { value: normalize(token.value, ignoreCase, ignoreAccents) }) : token));
        return text => {
            const stack = [];
            for (const token of expression) {
                if (token.type === "TERM") stack.push(text.includes(token.value));
                else if (token.type === "NOT") stack.push(!stack.pop());
                else { const right = stack.pop(), left = stack.pop(); stack.push(token.type === "AND" ? left && right : left || right); }
            }
            if (stack.length !== 1) throw new Error("Expressão lógica inválida.");
            return stack[0];
        };
    }

    // termos "positivos" da consulta (ignora NÃO/operadores), usados só pra
    // destacar visualmente onde o termo aparece dentro do texto do resultado.
    function extractHighlightTerms(query, mode) {
        if (mode === "exact") {
            const phrase = query.trim().replace(/^"|"$/g, "");
            return phrase ? [phrase] : [];
        }
        const tokens = tokenize(query, "OR");
        const terms = [];
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].type === "TERM" && tokens[i - 1] && tokens[i - 1].type === "NOT") continue;
            if (tokens[i].type === "TERM") terms.push(tokens[i].value);
        }
        return Array.from(new Set(terms.filter(Boolean)));
    }

    // ============================================================
    // FILTROS AVANÇADOS (pessoas + data)
    // ============================================================
    function parseDateInput(value, endOfDay) {
        if (!value) return null;
        const parts = value.split("-").map(Number);
        if (parts.length !== 3) return null;
        return new Date(parts[0], parts[1] - 1, parts[2], endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0).getTime();
    }

    function personMatches(actual, expected, ignoreCase, ignoreAccents) {
        if (!expected.trim()) return true;
        return normalize(actual, ignoreCase, ignoreAccents).includes(normalize(expected.trim(), ignoreCase, ignoreAccents));
    }

    function advancedFiltersMatch(item) {
        const ignoreCase = ui.ignoreCase.checked;
        const ignoreAccents = ui.ignoreAccents.checked;
        if (!personMatches(item.requestedFor, ui.requestedFor.value, ignoreCase, ignoreAccents)) return false;
        if (!personMatches(item.assignedSpecialist, ui.specialist.value, ignoreCase, ignoreAccents)) return false;
        if (ui.vipOnly.checked && !item.isVip) return false;
        if (ui.statusFilter && !personMatches(item.status, ui.statusFilter.value, ignoreCase, ignoreAccents)) return false;
        if (ui.statusOperacionalFilter && !personMatches(item.statusOperacional, ui.statusOperacionalFilter.value, ignoreCase, ignoreAccents)) return false;
        if (ui.unidadeFilter && !personMatches(item.unidade, ui.unidadeFilter.value, ignoreCase, ignoreAccents)) return false;
        const mode = ui.dateMode.value;
        if (mode === "any") return true;
        const created = Number(item.created);
        if (!Number.isFinite(created)) return false;
        if (mode === "days") {
            const days = Number(ui.dateDays.value);
            if (!days || days <= 0) return true;
            return created >= Date.now() - days * 86400000;
        }
        const from = parseDateInput(ui.dateFrom.value, false);
        const to = parseDateInput(ui.dateTo.value, true);
        if (mode === "on") return from != null && created >= from && created <= parseDateInput(ui.dateFrom.value, true);
        if (mode === "after") return from != null && created >= from;
        if (mode === "before") return to != null && created <= to;
        if (mode === "between") return from != null && to != null && created >= from && created <= to;
        return true;
    }

    function updateDateControls() {
        const mode = ui.dateMode.value;
        ui.dateFromWrap.hidden = !["on", "after", "between"].includes(mode);
        ui.dateToWrap.hidden = !["before", "between"].includes(mode);
        ui.dateDaysWrap.hidden = mode !== "days";
        ui.dateFromLabel.textContent = mode === "between" ? "Data inicial" : mode === "after" ? "A partir de" : "Data";
        ui.dateToLabel.textContent = mode === "between" ? "Data final" : "Até";
    }

    function insertOperator(value) {
        const input = ui.query, start = input.selectionStart == null ? input.value.length : input.selectionStart, end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
        if (value === '""') { input.value = input.value.slice(0, start) + '"' + input.value.slice(start, end) + '"' + input.value.slice(end); input.setSelectionRange(start + 1, end + 1); }
        else if (value === "()") { input.value = input.value.slice(0, start) + "(" + input.value.slice(start, end) + ")" + input.value.slice(end); input.setSelectionRange(start + 1, end + 1); }
        else { input.value = input.value.slice(0, start) + value + input.value.slice(end); input.setSelectionRange(start + value.length, start + value.length); }
        input.focus();
    }

    // ============================================================
    // AUTOCOMPLETE DE PESSOA (Solicitado para / Designado Especialista)
    // Ao escolher uma sugestão, resolve o ID exato da pessoa — usado tanto
    // para restringir o carregamento no servidor (personConstraintClause)
    // quanto continua funcionando como filtro de texto pós-carga se digitado
    // livremente sem selecionar nada da lista.
    // ============================================================
    function installPersonAutocomplete(input, shadow, scopeByGse) {
        const MIN_CHARS = 2;
        const DEBOUNCE_MS = 320;
        const control = input.closest(".control");
        const hint = control.querySelector(".person-hint");
        const originalHint = hint ? hint.textContent : "";
        const menu = document.createElement("div");
        menu.className = "specialist-menu";
        menu.hidden = true;
        control.appendChild(menu);

        let timer = null, controller = null, options = [], active = -1, sequence = 0;

        function showMessage(html) {
            menu.innerHTML = `<div class="specialist-message">${html}</div>`;
            menu.hidden = false;
            options = [];
            active = -1;
        }
        function closeMenu() { menu.hidden = true; active = -1; }

        function render(persons) {
            options = persons;
            active = persons.length ? 0 : -1;
            if (!persons.length) { showMessage(scopeByGse ? "Nenhuma pessoa localizada nos GSEs selecionados." : "Nenhuma pessoa localizada com esse nome."); return; }
            menu.innerHTML = "";
            persons.forEach((person, index) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "specialist-option" + (index === active ? " active" : "");
                button.dataset.index = String(index);
                // Contas externas (cidadãos) guardam o CPF/documento tanto em
                // Upn quanto em EmployeeNumber — não é matrícula funcional de
                // verdade. Detectamos isso pelo Upn ser só dígitos (username
                // de servidor nunca é puramente numérico) — é o mesmo sinal
                // usado tanto pro rótulo (ID em vez de Matrícula) quanto pra
                // tag "Externo".
                const looksExternal = /^\d+$/.test(person.upn || "");
                const strong = document.createElement("strong");
                strong.textContent = person.name;
                if (person.isVip) {
                    const vip = document.createElement("span");
                    vip.className = "specialist-vip";
                    vip.textContent = "VIP";
                    strong.append(" ", vip);
                }
                const origin = document.createElement("span");
                origin.className = looksExternal ? "specialist-external" : "specialist-internal";
                origin.textContent = looksExternal ? "Externo" : "Interno";
                strong.append(" ", origin);
                const detail = document.createElement("span");
                const idLabel = looksExternal ? "ID" : "Matrícula";
                detail.textContent = person.employeeNumber ? `${idLabel} ${person.employeeNumber}` : "";
                button.append(strong, detail);
                button.addEventListener("mousedown", event => { event.preventDefault(); choose(index); });
                menu.appendChild(button);
            });
            menu.hidden = false;
        }

        function updateActive(next) {
            if (!options.length) return;
            active = (next + options.length) % options.length;
            menu.querySelectorAll(".specialist-option").forEach((button, index) => button.classList.toggle("active", index === active));
            const activeEl = menu.querySelector(`[data-index="${active}"]`);
            if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
        }

        function choose(index) {
            const person = options[index];
            if (!person) return;
            input.value = person.name;
            input.dataset.personId = person.id;
            if (hint) { hint.textContent = `✓ ${person.name} selecionado(a) — carregamento será restrito a essa pessoa`; hint.classList.add("confirmed"); }
            closeMenu();
            input.focus();
        }

        async function searchPersons(query) {
            let groups = [];
            if (scopeByGse) {
                groups = selectedGseIds();
                if (!groups.length) { showMessage("Selecione ao menos um GSE primeiro."); return; }
            }
            if (controller) controller.abort();
            controller = new AbortController();
            const current = ++sequence;
            showMessage('<span class="specialist-spinner"></span>Consultando pessoas no SMAX...');

            // O solicitante ("Solicitado para") não é membro do GSE — só o
            // especialista é (PersonToGroup existe pra ele, não pra quem abriu
            // o chamado). Por isso só restringimos por grupo quando o campo é
            // o de especialista; solicitante busca por nome em toda a base.
            const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
            const nameClauses = words.map(word => `(PersonalDetails wordstartswith ('${word.replace(/'/g, "''")}'))`).join(" and ");
            const filter = scopeByGse ? `((PersonToGroup[Id in (${groups.join(",")})]) and (${nameClauses}))` : `(${nameClauses})`;
            const params = new URLSearchParams({
                filter, layout: "Name,Upn,IsDeleted,Email,EmployeeNumber,IsVIP", meta: "totalCount", order: "Name asc", size: "30"
            });

            // O SMAX devolve em ordem alfabética, não por relevância — "Robson
            // Alves de Souza" aparecia antes de "Robson Souza Alves" mesmo
            // sendo o segundo o match mais próximo do que foi digitado.
            // Reordenamos aqui: nome cujas primeiras palavras batem com a
            // busca NA MESMA ORDEM (prefixo) vem primeiro; nome idêntico ao
            // que foi digitado vem no topo de todos.
            const queryWords = words.map(word => normalize(word, true, true));
            function personMatchScore(name) {
                const normName = normalize(name, true, true);
                const nameWords = normName.split(/\s+/).filter(Boolean);
                let score = normName === queryWords.join(" ") ? 1000 : 0;
                let orderedPrefix = 0;
                for (let i = 0; i < queryWords.length; i++) {
                    if (nameWords[i] && nameWords[i].startsWith(queryWords[i])) orderedPrefix++;
                    else break;
                }
                score += orderedPrefix * 100;
                queryWords.forEach(qw => { if (nameWords.some(nw => nw.startsWith(qw))) score += 10; });
                return score - nameWords.length;
            }

            try {
                const payload = await fetchJson(`${getRestBase()}/ems/Person?${params}`, { signal: controller.signal });
                if (current !== sequence) return;
                const byId = new Map();
                (Array.isArray(payload.entities) ? payload.entities : []).forEach(entity => {
                    const p = entity.properties || {};
                    const person = {
                        id: String(p.Id || ""), name: String(p.Name || "").trim(),
                        upn: String(p.Upn || "").trim(), email: String(p.Email || "").trim(),
                        employeeNumber: String(p.EmployeeNumber || "").trim(),
                        isVip: p.IsVIP === true || p.IsVIP === "true"
                    };
                    if (person.id && person.name && !byId.has(person.id)) byId.set(person.id, person);
                });
                const ranked = Array.from(byId.values()).sort((a, b) => personMatchScore(b.name) - personMatchScore(a.name));
                render(ranked);
            } catch (error) {
                if (error.name === "AbortError") return;
                showMessage("Não foi possível consultar pessoas: " + String(error.message || error));
            }
        }

        input.addEventListener("input", () => {
            delete input.dataset.personId;
            if (hint) { hint.textContent = originalHint; hint.classList.remove("confirmed"); }
            clearTimeout(timer);
            const query = input.value.trim();
            if (query.length < MIN_CHARS) { closeMenu(); return; }
            timer = setTimeout(() => searchPersons(query), DEBOUNCE_MS);
        });
        input.addEventListener("keydown", event => {
            if (menu.hidden) return;
            if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); updateActive(active + 1); }
            else if (event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); updateActive(active - 1); }
            else if (event.key === "Enter") { if (active >= 0) { event.preventDefault(); event.stopPropagation(); choose(active); } }
            else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); }
        });
        input.addEventListener("focus", () => { if (options.length && input.value.trim().length >= MIN_CHARS) menu.hidden = false; });
        shadow.addEventListener("mousedown", event => { if (!event.composedPath().includes(control)) closeMenu(); });
        if (scopeByGse) {
            shadow.querySelectorAll(".gse-list input[data-gse]").forEach(checkbox => {
                checkbox.addEventListener("change", () => {
                    options = []; closeMenu();
                    delete input.dataset.personId;
                    if (hint) { hint.textContent = originalHint; hint.classList.remove("confirmed"); }
                });
            });
        }
    }

    // ============================================================
    // BUSCA POR SEMELHANÇA (BM25) — 100% local, sem chamada de rede/IA.
    // Compara o texto colado (descrição do chamado atual) com cada
    // solicitação já carregada em memória, usando o mesmo tipo de algoritmo
    // de ranking por relevância usado por buscadores de texto como o
    // Elasticsearch. Nada sai do navegador nessa etapa.
    // ============================================================
    // Stemmer leve (não é o RSLP completo): normaliza plural simples e
    // advérbios em "-mente" pra aumentar recall sem arriscar juntar palavras
    // sem relação nenhuma entre si.
    function stemLight(token) {
        if (token.length > 4 && token.endsWith("mente")) return token.slice(0, -5);
        if (token.length > 4 && (token.endsWith("ões") || token.endsWith("ãos"))) return token.slice(0, -3) + "ao";
        if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
        return token;
    }

    function tokenizeForIndex(rawText) {
        const normalized = normalize(rawText, true, true);
        const matches = normalized.match(/[a-z0-9]+/g) || [];
        const out = [];
        for (const token of matches) {
            if (token.length < SEMANTIC_MIN_TOKEN_LEN || STOPWORDS_PT.has(token)) continue;
            out.push(stemLight(token));
        }
        return out;
    }

    // Índice invertido: termo -> Map(índice do chamado no acervo -> frequência).
    // Construído sob demanda (uma vez por carga do acervo, na primeira busca
    // por semelhança) — evita gastar tempo indexando se o recurso não for usado.
    function buildSemanticIndex() {
        const postings = new Map();
        const docLen = new Array(archive.length);
        let totalLen = 0;
        for (let idx = 0; idx < archive.length; idx++) {
            const item = archive[idx];
            const terms = tokenizeForIndex(`${item.description} ${item.solution} ${item.discussion}`);
            docLen[idx] = terms.length;
            totalLen += terms.length;
            const tf = new Map();
            for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
            tf.forEach((count, term) => {
                let bucket = postings.get(term);
                if (!bucket) { bucket = new Map(); postings.set(term, bucket); }
                bucket.set(idx, count);
            });
        }
        semanticIndex = { postings, docLen, avgDocLen: totalLen / (archive.length || 1), N: archive.length, builtForLength: archive.length };
    }

    function ensureSemanticIndex() {
        if (!semanticIndex || semanticIndex.builtForLength !== archive.length) buildSemanticIndex();
    }

    // BM25: pondera termos raros no acervo (IDF alto) mais que termos comuns,
    // e normaliza pelo tamanho de cada chamado (chamados muito longos não
    // vencem só por terem mais palavras). Piso no IDF evita score negativo
    // para termos muito comuns que escaparam da lista de stopwords.
    function computeBm25Scores(queryTerms) {
        const { postings, docLen, avgDocLen, N } = semanticIndex;
        const scores = new Map();
        const termWeights = new Map();
        Array.from(new Set(queryTerms)).forEach(term => {
            const bucket = postings.get(term);
            if (!bucket) return;
            const df = bucket.size;
            const idf = Math.max(0.01, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
            termWeights.set(term, idf);
            bucket.forEach((tf, idx) => {
                const dl = docLen[idx] || 0;
                const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / (avgDocLen || 1)));
                scores.set(idx, (scores.get(idx) || 0) + idf * (tf * (BM25_K1 + 1)) / (denom || 1));
            });
        });
        return { scores, termWeights };
    }

    // Adia o trabalho pesado um tick (setTimeout 0) só pra garantir que a
    // mensagem "Indexando..." pinte na tela antes do cálculo síncrono travar
    // a thread por um instante em acervos muito grandes.
    async function performSemanticSearch() {
        const text = ui.semanticQuery.value.trim();
        if (!text) { setStatus("Cole a descrição do chamado atual no campo de busca por semelhança.", "warning"); return; }
        await ensureArchiveLoaded();
        if (!archive.length) return;
        setStatus("Indexando o acervo para busca por semelhança (só na primeira busca após carregar)...", "info");
        ui.semanticSearch.disabled = true;
        setTimeout(() => {
            try { runSemanticSearch(text); }
            finally { ui.semanticSearch.disabled = false; }
        }, 20);
    }

    function runSemanticSearch(text) {
        searchMode = "semantic";
        lastSearchIncludedDiscussion = archiveIncludesDiscussion;
        ensureSemanticIndex();
        const queryTerms = tokenizeForIndex(text);
        if (!queryTerms.length) { setStatus("Não encontramos termos relevantes nesse texto (tente descrever com mais detalhes).", "warning"); return; }
        const { scores, termWeights } = computeBm25Scores(queryTerms);
        const limit = Number(ui.semanticLimit.value) || SEMANTIC_DEFAULT_LIMIT;
        const ranked = Array.from(scores.entries())
            .map(([idx, score]) => ({ item: archive[idx], score }))
            .filter(entry => entry.item && advancedFiltersMatch(entry.item))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        lastQueryTerms = Array.from(termWeights.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term]) => term);
        semanticScores = new Map(ranked.map(entry => [entry.item.id, entry.score]));
        semanticMaxScore = ranked.length ? ranked[0].score : 1;
        results = ranked.map(entry => entry.item);
        currentPage = 1;
        focusedIndex = -1;
        if (ui.focusOverlay) ui.focusOverlay.hidden = true;
        sortMode = "similarity";
        ui.sortSelect.value = "similarity";
        activeIndex = results.length ? 0 : -1;
        renderResults();
        setStatus(results.length
            ? `${results.length.toLocaleString("pt-BR")} caso(s) semelhante(s) encontrado(s) em ${archive.length.toLocaleString("pt-BR")} solicitações carregadas — busca 100% local, nada enviado pra fora.`
            : "Nenhum caso semelhante encontrado (tente descrever com outras palavras).", results.length ? "success" : "warning");
    }

    // Lê os controles e compila o comparador — pode ser chamado uma vez e
    // reaproveitado tanto pro resultado final quanto pras atualizações
    // parciais que acontecem enquanto o acervo ainda está carregando.
    function prepareTermSearch() {
        const query = ui.query.value;
        const searchDescription = ui.fieldDescription.checked;
        const searchSolution = ui.fieldSolution.checked;
        const searchDiscussion = ui.fieldDiscussion.checked;
        if (!searchDescription && !searchSolution && !searchDiscussion) throw new Error('Selecione ao menos um campo em "Buscar em".');
        const mode = ui.mode.value;
        const ignoreCase = ui.ignoreCase.checked;
        const ignoreAccents = ui.ignoreAccents.checked;
        const matcher = compileMatcher(query, mode, ignoreCase, ignoreAccents);
        lastQueryTerms = extractHighlightTerms(query, mode);
        return { matcher, searchDescription, searchSolution, searchDiscussion, ignoreCase, ignoreAccents };
    }

    function applyTermSearch(prepared, isPartial) {
        const { matcher, searchDescription, searchSolution, searchDiscussion, ignoreCase, ignoreAccents } = prepared;
        lastSearchIncludedDiscussion = searchDiscussion;
        results = archive.filter(item => {
            const textMatch =
                (searchDescription && matcher(normalize(item.description, ignoreCase, ignoreAccents))) ||
                (searchSolution && matcher(normalize(item.solution, ignoreCase, ignoreAccents))) ||
                (searchDiscussion && matcher(normalize(item.discussion, ignoreCase, ignoreAccents)));
            return textMatch && advancedFiltersMatch(item);
        });
        currentPage = 1;
        focusedIndex = -1;
        if (ui.focusOverlay) ui.focusOverlay.hidden = true;
        applySort();
        activeIndex = results.length ? 0 : -1;
        renderResults();
        const discussionWarning = searchDiscussion && !archiveIncludesDiscussion
            ? ' ⚠ Discussão não foi incluída — o acervo carregado não tem esse campo. Marque "Discussão" ANTES de clicar em "Pesquisar" e recarregue.'
            : "";
        const partialNote = isPartial ? " (carregando o restante em segundo plano...)" : "";
        setStatus(`${results.length.toLocaleString("pt-BR")} resultado(s) em ${archive.length.toLocaleString("pt-BR")} solicitações carregadas${partialNote}.${discussionWarning}`, discussionWarning ? "warning" : (results.length ? "success" : "warning"));
    }

    async function performSearch() {
        try {
            searchMode = "terms";
            if (sortMode === "similarity") { sortMode = "recent"; ui.sortSelect.value = "recent"; }
            const prepared = prepareTermSearch();
            await ensureArchiveLoaded(() => applyTermSearch(prepared, true));
            if (!archive.length) return;
            applyTermSearch(prepared, false);
        } catch (error) {
            setStatus(error.message || String(error), "error");
        }
    }

    // Busca Estatística: nenhum termo de texto, só os filtros estruturados
    // (Solicitado para / Designado Especialista / VIP / período, no painel
    // "Filtros avançados" compartilhado, mais a GSE aqui). Reaproveita o
    // mesmo pipeline de resultados/paginação/exportação da busca por termos.
    function applyStatsFilter(isPartial) {
        lastQueryTerms = [];
        lastSearchIncludedDiscussion = false;
        results = archive.filter(item => advancedFiltersMatch(item));
        currentPage = 1;
        focusedIndex = -1;
        if (ui.focusOverlay) ui.focusOverlay.hidden = true;
        applySort();
        activeIndex = results.length ? 0 : -1;
        renderResults();
        const partialNote = isPartial ? " (carregando o restante em segundo plano...)" : "";
        setStatus(`${results.length.toLocaleString("pt-BR")} solicitação(ões) com esses filtros, em ${archive.length.toLocaleString("pt-BR")} carregadas${partialNote}.`, results.length ? "success" : "warning");
    }

    async function performStatsSearch() {
        try {
            searchMode = "stats";
            if (sortMode === "similarity") { sortMode = "recent"; ui.sortSelect.value = "recent"; }
            await ensureArchiveLoaded(() => applyStatsFilter(true));
            if (!archive.length) return;
            applyStatsFilter(false);
        } catch (error) {
            setStatus(error.message || String(error), "error");
        }
    }

    function countOccurrences(item) {
        if (!lastQueryTerms.length) return 0;
        const ignoreCase = ui.ignoreCase.checked, ignoreAccents = ui.ignoreAccents.checked;
        const text = normalize(`${item.description} ${item.solution} ${item.discussion}`, ignoreCase, ignoreAccents);
        return lastQueryTerms.reduce((sum, term) => {
            const needle = normalize(term, ignoreCase, ignoreAccents);
            if (!needle) return sum;
            return sum + text.split(needle).length - 1;
        }, 0);
    }

    function applySort() {
        if (sortMode === "recent") results.sort((a, b) => Number(b.created) - Number(a.created));
        else if (sortMode === "oldest") results.sort((a, b) => Number(a.created) - Number(b.created));
        else if (sortMode === "relevance") results.sort((a, b) => countOccurrences(b) - countOccurrences(a));
        else if (sortMode === "similarity") results.sort((a, b) => (semanticScores.get(b.id) || 0) - (semanticScores.get(a.id) || 0));
    }

    // ============================================================
    // ESTATÍSTICAS DO ACERVO CARREGADO
    // ============================================================
    function renderStats() {
        if (!archive.length) { ui.statsStrip.hidden = true; return; }
        ui.statsStrip.hidden = false;
        const byGse = new Map();
        let newest = -Infinity, oldest = Infinity;
        archive.forEach(item => {
            byGse.set(item.groupName, (byGse.get(item.groupName) || 0) + 1);
            const created = Number(item.created);
            if (Number.isFinite(created)) { if (created > newest) newest = created; if (created < oldest) oldest = created; }
        });
        const ranked = Array.from(byGse.entries()).sort((a, b) => b[1] - a[1]);
        const maxCount = ranked.length ? ranked[0][1] : 1;
        ui.statsCount.textContent = `${archive.length.toLocaleString("pt-BR")} solicitações`;
        ui.statsLoadedAt.textContent = archiveLoadedAt ? `carregado às ${archiveLoadedAt.toLocaleTimeString("pt-BR")}` : "";
        ui.statsRange.textContent = Number.isFinite(oldest) && Number.isFinite(newest)
            ? `de ${formatDate(oldest)} até ${formatDate(newest)}`
            : "";
        ui.statsGseList.innerHTML = ranked.map(([name, count]) => `
            <div class="gse-bar-row">
                <span class="gse-bar-label" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                <div class="gse-bar-track"><div class="gse-bar-fill" style="width:${Math.max(4, Math.round((count / maxCount) * 100))}%"></div></div>
                <span class="gse-bar-count">${count.toLocaleString("pt-BR")}</span>
            </div>`).join("");
    }

    // ============================================================
    // SELEÇÃO (checklist persistente entre páginas e buscas)
    // ============================================================
    function isSelected(id) { return selectedIds.has(id); }

    function setSelection(id, checked) {
        if (checked) selectedIds.add(id); else selectedIds.delete(id);
        updateSelectionUi();
    }

    function selectPage() {
        const start = (currentPage - 1) * PAGE_RESULTS;
        results.slice(start, start + PAGE_RESULTS).forEach(item => selectedIds.add(item.id));
        updateSelectionUi();
        renderResults();
    }

    function selectAllResults() {
        results.forEach(item => selectedIds.add(item.id));
        updateSelectionUi();
        renderResults();
    }

    function clearSelection() {
        selectedIds.clear();
        updateSelectionUi();
        renderResults();
        if (focusedIndex >= 0) openFocus(focusedIndex);
    }

    function updateSelectionUi() {
        const count = selectedIds.size;
        ui.selectionCount.textContent = count ? `${count.toLocaleString("pt-BR")} selecionada(s)` : "";
        ui.clearSelectionButton.hidden = !count;
        ui.openSelectedButton.disabled = !count;
    }

    function openSelectedInTabs() {
        const ids = Array.from(selectedIds);
        if (!ids.length) return;
        ids.slice(0, OPEN_SELECTED_CAP).forEach(id => window.open(`${location.origin}/saw/Request/${encodeURIComponent(id)}/general`, "_blank"));
        setStatus(ids.length > OPEN_SELECTED_CAP
            ? `Abertas as primeiras ${OPEN_SELECTED_CAP} de ${ids.length} selecionadas (limite de segurança contra bloqueio de pop-up).`
            : `${ids.length} chamado(s) aberto(s) em novas abas.`, "success");
    }

    // ============================================================
    // EXPORTAÇÃO (CSV / JSON / TXT / HTML) — respeita a seleção, se houver
    // ============================================================
    function exportRows() {
        if (selectedIds.size) return archive.filter(item => selectedIds.has(item.id));
        return results.length ? results : archive;
    }

    function downloadFile(filename, content, mime) {
        const blob = new Blob([content], { type: mime + ";charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    function csvEscape(value) {
        const text = String(value == null ? "" : value);
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }

    function exportCsv() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const header = ["ID", "Data de criação", "Solicitado para", "VIP", "Designado Especialista", "GSE", "Descrição", "Solução", "Discussão"];
        const lines = [header.map(csvEscape).join(",")];
        rows.forEach(item => {
            lines.push([item.id, formatDate(item.created), item.requestedFor, item.isVip ? "Sim" : "Não", item.assignedSpecialist, item.groupName, item.description, item.solution, item.discussion].map(csvEscape).join(","));
        });
        downloadFile(`acervo-smax-${timestamp()}.csv`, "﻿" + lines.join("\r\n"), "text/csv");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em CSV.`, "success");
    }

    function exportJson() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        downloadFile(`acervo-smax-${timestamp()}.json`, JSON.stringify(rows, null, 2), "application/json");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em JSON.`, "success");
    }

    function exportTxt() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const parts = rows.map(item => [
            `Chamado: ${item.id}${item.isVip ? "  [VIP]" : ""}`,
            `Data de criação: ${formatDate(item.created)}`,
            `Solicitado para: ${item.requestedFor}`,
            `Designado Especialista: ${item.assignedSpecialist}`,
            `GSE: ${item.groupName}`,
            `Descrição: ${item.description || "Não informado"}`,
            `Solução: ${item.solution || "Não informado"}`,
            `Discussão: ${item.discussion || "Não informado"}`,
            "-".repeat(60)
        ].join("\n"));
        downloadFile(`acervo-smax-${timestamp()}.txt`, parts.join("\n\n"), "text/plain");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em TXT.`, "success");
    }

    function exportHtml() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const cards = rows.map(item => `
            <article style="border:1px solid #d5e0ea;border-left:4px solid #0b6ee0;border-radius:8px;padding:14px 16px;margin-bottom:14px;background:#fff">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    <a href="${escapeHtml(location.origin)}/saw/Request/${encodeURIComponent(item.id)}/general" style="color:#0b6ee0;font-weight:800;text-decoration:none;font-size:15px">${escapeHtml(item.id)}</a>
                    ${item.isVip ? '<span style="font-size:10px;font-weight:800;color:#8a6300;background:#ffe9a8;border-radius:4px;padding:2px 7px">⭐ VIP</span>' : ""}
                    <span style="margin-left:auto;font-size:11px;color:#7a8b9b">${escapeHtml(formatDate(item.created))}</span>
                </div>
                <div style="margin-bottom:8px"><strong style="display:block;font-size:10.5px;text-transform:uppercase;color:#0b6ee0;margin-bottom:3px">Descrição</strong><p style="margin:0;white-space:pre-wrap">${escapeHtml(item.description || "Não informado")}</p></div>
                <div><strong style="display:block;font-size:10.5px;text-transform:uppercase;color:#0b6ee0;margin-bottom:3px">Solução</strong><p style="margin:0;white-space:pre-wrap">${escapeHtml(item.solution || "Não informado")}</p></div>
                ${item.discussion ? `<div style="margin-top:8px"><strong style="display:block;font-size:10.5px;text-transform:uppercase;color:#0b6ee0;margin-bottom:3px">Discussão</strong><p style="margin:0;white-space:pre-wrap">${escapeHtml(item.discussion)}</p></div>` : ""}
                <footer style="display:flex;gap:16px;margin-top:10px;padding-top:8px;border-top:1px solid #eef2f6;font-size:11.5px;color:#526477">
                    <span>Solicitado para: ${escapeHtml(item.requestedFor)}</span><span>Especialista: ${escapeHtml(item.assignedSpecialist)}</span><span>${escapeHtml(item.groupName)}</span>
                </footer>
            </article>`).join("");
        const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Acervo SMAX — Exportação</title></head>
            <body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f2f5f8;color:#273746;margin:0;padding:28px">
                <h1 style="color:#0b6ee0;margin:0 0 4px">Pesquisa no Acervo SMAX</h1>
                <p style="color:#526477;margin:0 0 20px">Exportado em ${escapeHtml(new Date().toLocaleString("pt-BR"))} · ${rows.length.toLocaleString("pt-BR")} solicitação(ões) · Imprima esta página (Ctrl+P) para gerar um PDF.</p>
                ${cards}
            </body></html>`;
        downloadFile(`acervo-smax-${timestamp()}.html`, html, "text/html");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em HTML (abra e use Ctrl+P para PDF).`, "success");
    }

    async function copySummary() {
        const rows = exportRows();
        if (!rows.length) return setStatus("Nada para copiar ainda.", "warning");
        const text = rows.map(item => `${item.id}${item.isVip ? " [VIP]" : ""} — ${item.requestedFor} — ${formatDate(item.created)} — ${item.groupName}`).join("\n");
        try {
            await navigator.clipboard.writeText(text);
            setStatus(`Resumo de ${rows.length.toLocaleString("pt-BR")} solicitação(ões) copiado para a área de transferência.`, "success");
        } catch (_) {
            setStatus("Não foi possível acessar a área de transferência do navegador.", "error");
        }
    }

    async function copyOne(item) {
        try {
            await navigator.clipboard.writeText(`${item.id}${item.isVip ? " [VIP]" : ""} — ${item.requestedFor} — ${formatDate(item.created)} — ${item.groupName}`);
            setStatus(`Resumo de ${item.id} copiado.`, "success");
        } catch (_) {
            setStatus("Não foi possível acessar a área de transferência do navegador.", "error");
        }
    }

    function timestamp() {
        const now = new Date();
        const pad = n => String(n).padStart(2, "0");
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    }

    // ============================================================
    // FORMATAÇÃO / DESTAQUE
    // ============================================================
    function setStatus(message, type) { ui.status.textContent = message || ""; ui.status.className = "status " + (type || ""); }
    function setProgress(message, percent) { ui.progressText.textContent = message; ui.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`; ui.progress.hidden = false; }

    function escapeHtml(value) {
        return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    // A busca por semelhança guarda os termos já sem acento (pro índice
    // BM25); pra destacar corretamente no texto original (que tem acento),
    // cada letra vira uma classe de caracteres aceitando as variantes
    // acentuadas — assim "cartorio" ainda encontra e marca "cartório".
    const HIGHLIGHT_ACCENT_CLASS = { a: "aàáâã", e: "eèéê", i: "iìí", o: "oòóôõ", u: "uùú", c: "cç" };
    function accentInsensitivePattern(term) {
        return term.split("").map(ch => {
            const variant = HIGHLIGHT_ACCENT_CLASS[ch.toLocaleLowerCase("pt-BR")];
            return variant ? `[${variant}${variant.toLocaleUpperCase("pt-BR")}]` : escapeRegExp(ch);
        }).join("");
    }

    function highlight(text) {
        const escaped = escapeHtml(text || "Não informado");
        if (!lastQueryTerms.length) return escaped;
        const pattern = lastQueryTerms.map(term => accentInsensitivePattern(escapeHtml(term))).filter(Boolean).join("|");
        if (!pattern) return escaped;
        try { return escaped.replace(new RegExp(`(${pattern})`, "giu"), "<mark>$1</mark>"); } catch (_) { return escaped; }
    }

    function formatDate(value) {
        if (!value) return "Não informada";
        const number = Number(value), date = Number.isFinite(number) ? new Date(number) : new Date(value);
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("pt-BR");
    }

    function contentBlock(label, text) {
        const long = String(text || "").length > 650;
        return `<div class="field${long ? " collapsed" : ""}"><strong>${label}</strong><p>${highlight(text)}</p>${long ? '<button class="expand-text" type="button">Mostrar mais</button>' : ""}</div>`;
    }

    // ============================================================
    // NAVEGADOR ENTRE RESULTADOS + MODO EXPANDIDO
    // ============================================================
    function updateNavigator() {
        const valid = activeIndex >= 0 && activeIndex < results.length;
        ui.previousResult.disabled = !valid || activeIndex === 0;
        ui.nextResult.disabled = !valid || activeIndex === results.length - 1;
        ui.focusResult.disabled = !valid;
        ui.resultCounter.textContent = valid ? `${activeIndex + 1} de ${results.length}` : (results.length ? "" : "Nenhum resultado");
    }

    function activateResult(index, scroll) {
        if (!results.length) return;
        activeIndex = Math.max(0, Math.min(index, results.length - 1));
        const neededPage = Math.floor(activeIndex / PAGE_RESULTS) + 1;
        if (neededPage !== currentPage) { currentPage = neededPage; renderResults(); }
        else {
            ui.results.querySelectorAll("[data-index]").forEach(card => card.classList.toggle("active", Number(card.dataset.index) === activeIndex));
            updateNavigator();
        }
        if (scroll) {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                const card = ui.results.querySelector(`[data-index="${activeIndex}"]`);
                if (card) ui.results.scrollTo({ top: Math.max(0, card.offsetTop - ui.results.offsetTop - 10), behavior: "smooth" });
            }));
        }
    }

    function moveResult(delta) {
        if (!results.length) return;
        activateResult(activeIndex < 0 ? 0 : activeIndex + delta, true);
        if (focusedIndex >= 0) openFocus(activeIndex);
    }

    function openFocus(index) {
        if (!results[index]) return;
        activeIndex = index;
        focusedIndex = index;
        const item = results[index];
        const url = `${location.origin}/saw/Request/${encodeURIComponent(item.id)}/general`;
        ui.focusBody.innerHTML = `
            <header class="focus-header">
                <div>
                    <span class="focus-position">Chamado ${index + 1} de ${results.length}${item.isVip ? " · ⭐ VIP" : ""}</span>
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.id)}</a>
                    <small>Criado em ${escapeHtml(formatDate(item.created))} · ${escapeHtml(item.groupName)}</small>
                </div>
                <label class="focus-select"><input type="checkbox" class="focus-checkbox" ${isSelected(item.id) ? "checked" : ""}>Selecionar</label>
                <button class="focus-close" type="button">×</button>
            </header>
            <nav class="focus-nav">
                <button class="focus-prev" type="button" ${index === 0 ? "disabled" : ""}>Anterior</button>
                <span>${index + 1} de ${results.length}</span>
                <button class="focus-next" type="button" ${index === results.length - 1 ? "disabled" : ""}>Próximo</button>
                <small>Use ↑ e ↓ para navegar</small>
            </nav>
            <div class="focus-scroll">
                <section><h3>Descrição</h3><div>${highlight(item.description)}</div></section>
                <section><h3>Solução</h3><div>${highlight(item.solution)}</div></section>
                ${lastSearchIncludedDiscussion && item.discussion ? `<section><h3>Discussão</h3><div>${highlight(item.discussion)}</div></section>` : ""}
                <footer>
                    <div><small>Solicitado para</small><strong>${escapeHtml(item.requestedFor)}</strong></div>
                    <div><small>Designado Especialista</small><strong>${escapeHtml(item.assignedSpecialist)}</strong></div>
                    <div><small>GSE</small><strong>${escapeHtml(item.groupName)}</strong></div>
                </footer>
            </div>`;
        ui.focusBody.querySelector(".focus-close").addEventListener("click", closeFocus);
        ui.focusBody.querySelector(".focus-prev").addEventListener("click", () => { if (activeIndex > 0) { activateResult(activeIndex - 1, false); openFocus(activeIndex); } });
        ui.focusBody.querySelector(".focus-next").addEventListener("click", () => { if (activeIndex < results.length - 1) { activateResult(activeIndex + 1, false); openFocus(activeIndex); } });
        ui.focusBody.querySelector(".focus-checkbox").addEventListener("change", event => setSelection(item.id, event.target.checked));
        ui.focusOverlay.hidden = false;
        const scroller = ui.focusBody.querySelector(".focus-scroll");
        if (scroller) scroller.scrollTop = 0;
        updateNavigator();
    }

    function closeFocus() {
        focusedIndex = -1;
        if (ui && ui.focusOverlay) ui.focusOverlay.hidden = true;
        renderResults();
    }

    // ============================================================
    // RENDERIZAÇÃO DE RESULTADOS
    // ============================================================
    function renderResults() {
        ui.results.innerHTML = "";
        ui.statsViewToggle.hidden = searchMode !== "stats";
        if (!results.length) {
            ui.results.innerHTML = '<div class="empty">Nenhuma solicitação corresponde aos critérios (ou o acervo ainda não foi carregado).</div>';
            ui.pagination.hidden = true;
            updateNavigator();
            return;
        }
        const pages = Math.ceil(results.length / PAGE_RESULTS);
        currentPage = Math.max(1, Math.min(currentPage, pages));
        const start = (currentPage - 1) * PAGE_RESULTS;
        const pageItems = results.slice(start, start + PAGE_RESULTS);
        if (searchMode === "stats") renderStatsResults(pageItems, start);
        else renderDetailedResults(pageItems, start);
        ui.pagination.hidden = pages <= 1;
        ui.pageInfo.textContent = `Página ${currentPage} de ${pages} · ${results.length.toLocaleString("pt-BR")} resultado(s)`;
        ui.prevPage.disabled = currentPage === 1;
        ui.nextPage.disabled = currentPage === pages;
        updateNavigator();
    }

    function renderDetailedResults(pageItems, start) {
        const fragment = document.createDocumentFragment();
        pageItems.forEach((item, localIndex) => {
            const globalIndex = start + localIndex;
            const isSemanticResult = searchMode === "semantic" && semanticScores.has(item.id);
            const similarityPct = isSemanticResult ? Math.round((semanticScores.get(item.id) / (semanticMaxScore || 1)) * 100) : 0;
            const occurrences = !isSemanticResult && lastQueryTerms.length ? countOccurrences(item) : 0;
            const card = document.createElement("article");
            card.className = "result-card" + (item.isVip ? " vip" : "") + (globalIndex === activeIndex ? " active" : "");
            card.dataset.index = String(globalIndex);
            const url = `${location.origin}/saw/Request/${encodeURIComponent(item.id)}/general`;
            card.innerHTML = `<header>
                    <label class="select-checkbox" title="Selecionar para exportação"><input type="checkbox" class="row-select" ${isSelected(item.id) ? "checked" : ""}></label>
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.25"></circle><path d="M15.2 15.2L20 20"></path></svg>${escapeHtml(item.id)}</a>
                    ${item.isVip ? '<span class="vip-badge"><svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="currentColor"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9-6.3 3.9 1.7-7L2 9.2l7.1-.6z"></path></svg>VIP</span>' : ""}
                    <span class="gse-tag">${escapeHtml(item.groupName)}</span>
                    ${isSemanticResult ? `<span class="sim-badge">${similarityPct}% semelhante</span>` : (occurrences ? `<span class="occ-badge">${occurrences}×</span>` : "")}
                    <span class="date">${escapeHtml(formatDate(item.created))}</span>
                    <button class="icon-btn copy-one" type="button" title="Copiar resumo"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 012-2h10"></path></svg></button>
                    <button class="icon-btn expand-one" type="button" title="Expandir"><svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path></svg></button>
                </header>
                ${contentBlock("Descrição", item.description)}
                ${contentBlock("Solução", item.solution)}
                ${lastSearchIncludedDiscussion && item.discussion ? contentBlock("Discussão", item.discussion) : ""}
                <footer><span><small>Solicitado para</small>${escapeHtml(item.requestedFor)}</span><span><small>Designado Especialista</small>${escapeHtml(item.assignedSpecialist)}</span></footer>`;

            card.querySelector(".row-select").addEventListener("click", event => event.stopPropagation());
            card.querySelector(".row-select").addEventListener("change", event => setSelection(item.id, event.target.checked));
            card.querySelector(".expand-one").addEventListener("click", event => { event.stopPropagation(); activateResult(globalIndex, false); openFocus(globalIndex); });
            card.querySelector(".copy-one").addEventListener("click", event => { event.stopPropagation(); copyOne(item); });
            card.querySelectorAll(".expand-text").forEach(button => button.addEventListener("click", event => {
                event.stopPropagation();
                const field = button.closest(".field");
                field.classList.toggle("collapsed");
                button.textContent = field.classList.contains("collapsed") ? "Mostrar mais" : "Recolher";
            }));
            card.addEventListener("click", event => { if (!event.target.closest("a,button,input,label")) activateResult(globalIndex, false); });

            fragment.appendChild(card);
        });
        ui.results.appendChild(fragment);
    }

    // ============================================================
    // BUSCA ESTATÍSTICA — resultados como lista de dados (tabela ou
    // grade de mini-cards), sem descrição/solução em destaque — o "teor"
    // fica num preview ao passar o mouse, ou no Expandir (mesmo recurso
    // das outras abas).
    // ============================================================
    function truncatePreview(text, max) {
        const clean = String(text || "").trim();
        if (!clean) return "Sem descrição.";
        return clean.length > max ? clean.slice(0, max).trim() + "…" : clean;
    }

    function wireStatsItemEvents(el, item, globalIndex) {
        el.querySelector(".row-select").addEventListener("click", event => event.stopPropagation());
        el.querySelector(".row-select").addEventListener("change", event => setSelection(item.id, event.target.checked));
        el.querySelector(".expand-one").addEventListener("click", event => { event.stopPropagation(); activateResult(globalIndex, false); openFocus(globalIndex); });
        el.addEventListener("click", event => { if (!event.target.closest("a,button,input,label")) activateResult(globalIndex, false); });
    }

    function buildStatsRow(item, globalIndex) {
        const tr = document.createElement("tr");
        tr.className = globalIndex === activeIndex ? "active" : "";
        tr.dataset.index = String(globalIndex);
        const url = `${location.origin}/saw/Request/${encodeURIComponent(item.id)}/general`;
        tr.innerHTML = `
            <td><input type="checkbox" class="row-select" ${isSelected(item.id) ? "checked" : ""}></td>
            <td class="stats-previewable"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.id)}</a><div class="stats-tip">${escapeHtml(truncatePreview(item.description, 220))}</div></td>
            <td>${escapeHtml(formatDate(item.created))}</td>
            <td><span class="gse-tag">${escapeHtml(item.groupName)}</span></td>
            <td>${escapeHtml(item.assignedSpecialist)}</td>
            <td>${escapeHtml(item.requestedFor)}</td>
            <td>${item.isVip ? '<span class="vip-dot">★</span>' : ""}</td>
            <td><button class="icon-btn expand-one" type="button" title="Expandir"><svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path></svg></button></td>`;
        wireStatsItemEvents(tr, item, globalIndex);
        return tr;
    }

    function buildStatsTile(item, globalIndex) {
        const tile = document.createElement("div");
        tile.className = "stats-tile" + (globalIndex === activeIndex ? " active" : "");
        tile.dataset.index = String(globalIndex);
        const url = `${location.origin}/saw/Request/${encodeURIComponent(item.id)}/general`;
        tile.innerHTML = `
            <div class="stats-tile-head stats-previewable">
                <label class="select-checkbox" title="Selecionar para exportação"><input type="checkbox" class="row-select" ${isSelected(item.id) ? "checked" : ""}></label>
                <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.id)}</a>
                ${item.isVip ? '<span class="vip-dot">★</span>' : ""}
                <button class="icon-btn expand-one" type="button" title="Expandir"><svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path></svg></button>
                <div class="stats-tip">${escapeHtml(truncatePreview(item.description, 220))}</div>
            </div>
            <div class="stats-tile-mini">
                <div><small>Criado</small>${escapeHtml(formatDate(item.created))}</div>
                <div><small>GSE</small>${escapeHtml(item.groupName)}</div>
                <div><small>Especialista</small>${escapeHtml(item.assignedSpecialist)}</div>
                <div><small>Solicitante</small>${escapeHtml(item.requestedFor)}</div>
            </div>`;
        wireStatsItemEvents(tile, item, globalIndex);
        return tile;
    }

    function renderStatsResults(pageItems, start) {
        const fragment = document.createDocumentFragment();
        if (statsViewMode === "grid") {
            const grid = document.createElement("div");
            grid.className = "stats-tile-grid";
            pageItems.forEach((item, localIndex) => grid.appendChild(buildStatsTile(item, start + localIndex)));
            fragment.appendChild(grid);
        } else {
            const table = document.createElement("table");
            table.className = "stats-table";
            table.innerHTML = "<thead><tr><th></th><th>Nº</th><th>Criado em</th><th>GSE</th><th>Especialista</th><th>Solicitante</th><th>VIP</th><th></th></tr></thead>";
            const tbody = document.createElement("tbody");
            pageItems.forEach((item, localIndex) => tbody.appendChild(buildStatsRow(item, start + localIndex)));
            table.appendChild(tbody);
            fragment.appendChild(table);
        }
        ui.results.appendChild(fragment);
    }

    function buildGseList() {
        ui.gseList.innerHTML = GSES.map(([id, name]) => `<label class="gse-item"><input type="checkbox" data-gse value="${id}" checked><span>${escapeHtml(name)}</span></label>`).join("");
    }

    // ============================================================
    // PREFERÊNCIAS DE FILTRO (BUSCA ESTATÍSTICA)
    // Salva/aplica combinações de GSE + pessoa + status + unidade + período.
    // Só neste navegador (localStorage) — nada é enviado ao servidor. O
    // "Compartilhar" gera um código de texto (copiar/colar) pra levar uma
    // preferência de um navegador/pessoa pra outro, sem sincronização ao vivo.
    // ============================================================
    function loadPreferences() {
        try {
            const parsed = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) || "[]");
            return Array.isArray(parsed) ? parsed : [];
        } catch (_) { return []; }
    }

    function savePreferencesToStorage() {
        try { localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(statsPreferences)); } catch (_) {}
    }

    function generatePrefId() { return "pref_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

    function captureStatsFilters() {
        return {
            gseIds: selectedGseIds(),
            specialistValue: ui.specialist.value, specialistPersonId: ui.specialist.dataset.personId || "",
            requestedForValue: ui.requestedFor.value, requestedForPersonId: ui.requestedFor.dataset.personId || "",
            statusFilter: ui.statusFilter.value, statusOperacionalFilter: ui.statusOperacionalFilter.value,
            unidadeFilter: ui.unidadeFilter.value, vipOnly: ui.vipOnly.checked,
            dateMode: ui.dateMode.value, dateFrom: ui.dateFrom.value, dateTo: ui.dateTo.value, dateDays: ui.dateDays.value
        };
    }

    // Abre (e marca ativa) a tag de um filtro opcional só quando a preferência
    // aplicada de fato trouxe algo pra ele — senão o campo fica preenchido
    // mas escondido atrás da tag, parecendo que "não aplicou nada".
    function openStatsTagIfFilled(slotId, value) {
        if (!value) return;
        const shadow = host.shadowRoot;
        const slot = shadow.getElementById(slotId);
        const tag = shadow.querySelector(`.stats-tag[data-slot="${slotId}"]`);
        if (slot) slot.hidden = false;
        if (tag) tag.classList.add("active");
    }

    function applyStatsFilters(filters) {
        if (!filters) return;
        ui.gseList.querySelectorAll("input[data-gse]").forEach(input => { input.checked = (filters.gseIds || []).includes(input.value); });
        ui.specialist.value = filters.specialistValue || "";
        if (filters.specialistPersonId) ui.specialist.dataset.personId = filters.specialistPersonId; else delete ui.specialist.dataset.personId;
        ui.requestedFor.value = filters.requestedForValue || "";
        if (filters.requestedForPersonId) ui.requestedFor.dataset.personId = filters.requestedForPersonId; else delete ui.requestedFor.dataset.personId;
        ui.statusFilter.value = filters.statusFilter || "";
        ui.statusOperacionalFilter.value = filters.statusOperacionalFilter || "";
        ui.unidadeFilter.value = filters.unidadeFilter || "";
        ui.vipOnly.checked = !!filters.vipOnly;
        ui.dateMode.value = filters.dateMode || "any";
        ui.dateFrom.value = filters.dateFrom || "";
        ui.dateTo.value = filters.dateTo || "";
        ui.dateDays.value = filters.dateDays || "";
        updateDateControls();
        openStatsTagIfFilled("statsEspSlot", filters.specialistValue);
        openStatsTagIfFilled("statsSolSlot", filters.requestedForValue);
        openStatsTagIfFilled("statsStatusSlot", filters.statusFilter || filters.statusOperacionalFilter);
        openStatsTagIfFilled("statsUnidadeSlot", filters.unidadeFilter);
    }

    function findPreference(id) { return statsPreferences.find(pref => pref.id === id); }

    function savePreferenceAsNew(name) {
        const trimmed = String(name || "").trim();
        if (!trimmed) return;
        statsPreferences.push({ id: generatePrefId(), name: trimmed, favorite: false, createdAt: Date.now(), filters: captureStatsFilters() });
        savePreferencesToStorage();
        renderPreferencesBar();
        setStatus(`Preferência "${trimmed}" salva.`, "success");
    }

    function updatePreferenceFilters(id) {
        const pref = findPreference(id);
        if (!pref) return;
        pref.filters = captureStatsFilters();
        savePreferencesToStorage();
        renderPreferencesBar();
        setStatus(`Preferência "${pref.name}" atualizada com os filtros atuais.`, "success");
    }

    function renamePreference(id, name) {
        const trimmed = String(name || "").trim();
        const pref = findPreference(id);
        if (!trimmed || !pref) return;
        pref.name = trimmed;
        savePreferencesToStorage();
        renderPreferencesBar();
    }

    function toggleFavoritePreference(id) {
        const pref = findPreference(id);
        if (!pref) return;
        pref.favorite = !pref.favorite;
        savePreferencesToStorage();
        renderPreferencesBar();
    }

    function deletePreference(id) {
        const pref = findPreference(id);
        if (!pref) return;
        if (!confirm(`Excluir a preferência "${pref.name}"? Essa ação não pode ser desfeita.`)) return;
        statsPreferences = statsPreferences.filter(item => item.id !== id);
        savePreferencesToStorage();
        renderPreferencesBar();
    }

    function applyPreferenceById(id) {
        const pref = findPreference(id);
        if (!pref) return;
        applyStatsFilters(pref.filters);
        setStatus(`Preferência "${pref.name}" aplicada — clique em "Calcular" pra ver o resultado.`, "info");
    }

    // Codifica em Base64 seguro pra UTF-8 (acentos/emoji), pra caber num
    // código de texto simples que dá pra copiar e colar em qualquer lugar.
    function utf8ToBase64(text) {
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary);
    }
    function base64ToUtf8(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
    }

    function encodePreferencesShareCode(list) {
        try { return PREFS_SHARE_PREFIX + utf8ToBase64(JSON.stringify(list)); }
        catch (_) { return ""; }
    }

    function decodePreferencesShareCode(code) {
        const trimmed = String(code || "").trim();
        if (!trimmed.startsWith(PREFS_SHARE_PREFIX)) throw new Error("Código não reconhecido — confira se copiou tudo certinho.");
        const parsed = JSON.parse(base64ToUtf8(trimmed.slice(PREFS_SHARE_PREFIX.length)));
        if (!Array.isArray(parsed)) throw new Error("Código inválido.");
        return parsed;
    }

    function importPreferencesFromCode(code) {
        let incoming;
        try { incoming = decodePreferencesShareCode(code); }
        catch (error) { setStatus(error.message || "Não foi possível importar esse código.", "error"); return; }
        let added = 0;
        incoming.forEach(entry => {
            if (!entry || !entry.name || !entry.filters) return;
            statsPreferences.push({ id: generatePrefId(), name: String(entry.name), favorite: false, createdAt: Date.now(), filters: entry.filters });
            added++;
        });
        savePreferencesToStorage();
        renderPreferencesBar();
        setStatus(added ? `${added} preferência(s) importada(s).` : "Nenhuma preferência válida encontrada nesse código.", added ? "success" : "warning");
    }

    function prefKebabMenuHtml(pref) {
        return `
            <button type="button" class="pref-act-fav" data-id="${escapeHtml(pref.id)}">${pref.favorite ? "★ Desfavoritar" : "☆ Favoritar"}</button>
            <button type="button" class="pref-act-rename" data-id="${escapeHtml(pref.id)}">✎ Renomear</button>
            <button type="button" class="pref-act-update" data-id="${escapeHtml(pref.id)}">↻ Atualizar com filtros atuais</button>
            <button type="button" class="pref-act-delete" data-id="${escapeHtml(pref.id)}">🗑 Excluir</button>`;
    }

    // Só as preferências FAVORITADAS (no máx. PREFS_VISIBLE_FAVORITES) ficam
    // sempre visíveis como chip — senão a barra cresceria sem limite pra
    // quem salvar muitas. As demais ficam a um clique, em "Ver todas".
    function renderPreferencesBar() {
        const shadow = host.shadowRoot;
        const bar = shadow.querySelector(".prefs-bar");
        if (!bar) return;
        if (!statsPreferences.length) {
            bar.innerHTML = `
                <div class="prefs-empty">
                    Você ainda não salvou nenhuma preferência de filtro.
                    <button type="button" class="pref-action pref-save-btn">💾 Salvar filtros atuais</button>
                </div>`;
        } else {
            const favorites = statsPreferences.filter(pref => pref.favorite).slice(0, PREFS_VISIBLE_FAVORITES);
            const chips = favorites.map(pref => `
                <div class="pref-chip">
                    <span class="pref-chip-name" data-id="${escapeHtml(pref.id)}" title="Aplicar esta preferência">⭐ ${escapeHtml(pref.name)}</span>
                    <span class="pref-kebab" data-id="${escapeHtml(pref.id)}">⋮</span>
                    <div class="pref-kebab-menu" hidden>${prefKebabMenuHtml(pref)}</div>
                </div>`).join("");
            bar.innerHTML = `
                <div class="prefs-row">
                    ${chips}
                    <button type="button" class="pref-action pref-save-btn">💾 Salvar atual</button>
                    <button type="button" class="pref-action pref-share-btn">📋 Compartilhar</button>
                    <span class="prefs-viewall-link">Ver todas (${statsPreferences.length})</span>
                </div>`;
        }
        renderPreferencesManager();
    }

    function renderPreferencesManager() {
        const shadow = host.shadowRoot;
        const panel = shadow.querySelector(".prefs-manager");
        if (!panel) return;
        if (!statsPreferences.length) { panel.innerHTML = '<p class="prefs-manager-empty">Nenhuma preferência salva ainda.</p>'; return; }
        const sorted = statsPreferences.slice().sort((a, b) => (b.favorite - a.favorite) || a.name.localeCompare(b.name, "pt-BR"));
        panel.innerHTML = `<div class="prefs-manager-list">${sorted.map(pref => `
            <div class="prefs-manager-row">
                <span class="prefs-manager-name" data-id="${escapeHtml(pref.id)}" title="Aplicar esta preferência">${pref.favorite ? "⭐ " : ""}${escapeHtml(pref.name)}</span>
                <span class="pref-kebab" data-id="${escapeHtml(pref.id)}">⋮</span>
                <div class="pref-kebab-menu" hidden>${prefKebabMenuHtml(pref)}</div>
            </div>`).join("")}</div>`;
    }

    function toggleManagerPanel() {
        const shadow = host.shadowRoot;
        const panel = shadow.querySelector(".prefs-manager");
        const sharePanel = shadow.querySelector(".prefs-share-panel");
        sharePanel.hidden = true;
        const willOpen = panel.hidden;
        if (willOpen) renderPreferencesManager();
        panel.hidden = !willOpen;
    }

    function toggleSharePanel() {
        const shadow = host.shadowRoot;
        const panel = shadow.querySelector(".prefs-share-panel");
        const managerPanel = shadow.querySelector(".prefs-manager");
        managerPanel.hidden = true;
        const willOpen = panel.hidden;
        if (willOpen) panel.querySelector(".prefs-export-code").value = statsPreferences.length ? encodePreferencesShareCode(statsPreferences) : "";
        panel.hidden = !willOpen;
    }

    // Delegação de eventos: a barra e o painel "Ver todas" são reconstruídos
    // (innerHTML) a cada mudança, então os ouvintes ficam num ancestral
    // estável (.prefs-block) em vez de precisar ser recolocados toda hora.
    function wirePreferencesEvents(shadow) {
        const prefsBlock = shadow.querySelector(".prefs-block");
        prefsBlock.addEventListener("click", event => {
            const kebab = event.target.closest(".pref-kebab");
            if (kebab) {
                const menu = kebab.nextElementSibling;
                prefsBlock.querySelectorAll(".pref-kebab-menu").forEach(m => { if (m !== menu) m.hidden = true; });
                menu.hidden = !menu.hidden;
                return;
            }
            const nameEl = event.target.closest(".pref-chip-name, .prefs-manager-name");
            if (nameEl) { applyPreferenceById(nameEl.dataset.id); return; }
            const favBtn = event.target.closest(".pref-act-fav");
            if (favBtn) { toggleFavoritePreference(favBtn.dataset.id); return; }
            const renameBtn = event.target.closest(".pref-act-rename");
            if (renameBtn) {
                const pref = findPreference(renameBtn.dataset.id);
                const name = prompt("Novo nome da preferência:", pref ? pref.name : "");
                if (name != null) renamePreference(renameBtn.dataset.id, name);
                return;
            }
            const updateBtn = event.target.closest(".pref-act-update");
            if (updateBtn) { updatePreferenceFilters(updateBtn.dataset.id); return; }
            const deleteBtn = event.target.closest(".pref-act-delete");
            if (deleteBtn) { deletePreference(deleteBtn.dataset.id); return; }
            const saveBtn = event.target.closest(".pref-save-btn");
            if (saveBtn) { const name = prompt("Nome da nova preferência:", ""); if (name != null) savePreferenceAsNew(name); return; }
            const shareBtn = event.target.closest(".pref-share-btn");
            if (shareBtn) { toggleSharePanel(); return; }
            const viewAllBtn = event.target.closest(".prefs-viewall-link");
            if (viewAllBtn) { toggleManagerPanel(); return; }
            const copyCodeBtn = event.target.closest(".prefs-copy-code");
            if (copyCodeBtn) {
                const textarea = shadow.querySelector(".prefs-export-code");
                textarea.select();
                navigator.clipboard.writeText(textarea.value)
                    .then(() => setStatus("Código copiado para a área de transferência.", "success"))
                    .catch(() => setStatus("Não foi possível acessar a área de transferência do navegador.", "error"));
                return;
            }
            const importBtn = event.target.closest(".prefs-import-btn");
            if (importBtn) {
                const textarea = shadow.querySelector(".prefs-import-code");
                importPreferencesFromCode(textarea.value);
                textarea.value = "";
                return;
            }
        });
    }

    // ============================================================
    // INTERFACE
    // ============================================================
    function buildUi() {
        host = document.createElement("div");
        host.id = "tjsp-archive-full-host";
        document.body.appendChild(host);
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `<style>
            :host {
                all: initial;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                -webkit-font-smoothing: antialiased;
                --v-page: #fbfdff; --v-outer-border: #dce9f7;
                --v-header: #0b6ee0; --v-header-border: #52a4f5; --v-header-text: #fff; --v-close-hover: rgba(198,40,40,.8);
                --v-stats-bg: #eaf4ff; --v-stats-border: #d3e9fc;
                --v-accent: #0b6ee0; --v-accent-soft: #eaf4ff; --v-accent-soft-border: #d3e9fc; --v-accent-soft-hover: #d8ecff;
                --v-muted: #5b7891; --v-muted-2: #45647f; --v-muted-3: #7a8b9b;
                --v-panel: #fff; --v-panel-border: #e2eefa; --v-panel-alt: #f8fafc; --v-panel-alt-border: #dfe7ef;
                --v-input-border: #bcdcfa;
                --v-text: #0f2438; --v-text-soft: #26404f; --v-text-2: #34465a; --v-text-3: #466077;
                --v-card-bg: #fff; --v-card-border: #dcedfb; --v-card-accent: #8ac2f7; --v-card-active-border: #0b6ee0; --v-card-active-bg: #f2f9ff;
                --v-mark-bg: #ffe08a; --v-mark-text: #4d3600;
                --v-vip-text: #8a6300; --v-vip-bg: #ffe9a8;
                --v-occ-text: #27633c; --v-occ-bg: #dcf3e4;
                --v-sim-bg: #dcecfb; --v-sim-border: #bcdcf5;
                --v-info-bg: #eaf4ff; --v-info-text: #0b6ee0;
                --v-success-bg: #edf8f1; --v-success-text: #27633c;
                --v-warning-bg: #fff7df; --v-warning-text: #795912;
                --v-error-bg: #fff0ef; --v-error-text: #a11f19;
                --v-internal-bg: #d7f0dc; --v-internal-text: #0f5c2a;
                --v-external-bg: #fbe1df; --v-external-text: #9c2b23;
                --v-danger-border: #d13438; --v-danger-text: #b42318;
                --v-overlay: rgba(8,14,22,.6);
                --v-focus-shadow: rgba(11,110,224,.16);
                color: var(--v-text);
            }
            :host(.dark) {
                --v-page: #0f151b; --v-outer-border: #232c36;
                --v-header: #141b23; --v-header-border: #2c85e0; --v-header-text: #f2f6fa; --v-close-hover: rgba(198,40,40,.6);
                --v-stats-bg: #121820; --v-stats-border: #212a34;
                --v-accent: #4fa3f7; --v-accent-soft: #17202a; --v-accent-soft-border: #26333f; --v-accent-soft-hover: #1c2732;
                --v-muted: #8b98a5; --v-muted-2: #94a2ae; --v-muted-3: #7c8894;
                --v-panel: #121820; --v-panel-border: #212a34; --v-panel-alt: #141b23; --v-panel-alt-border: #232c36;
                --v-input-border: #2b3542;
                --v-text: #e7edf3; --v-text-soft: #cfd9e3; --v-text-2: #cfd9e3; --v-text-3: #b7c3cf;
                --v-card-bg: #131a21; --v-card-border: #212a34; --v-card-accent: #3a6690; --v-card-active-border: #4fa3f7; --v-card-active-bg: #152230;
                --v-mark-bg: #4a3a10; --v-mark-text: #ffdb8a;
                --v-vip-text: #ffd88a; --v-vip-bg: #3a2f10;
                --v-occ-text: #8fe6b3; --v-occ-bg: #0f2c1e;
                --v-sim-bg: #16202b; --v-sim-border: #2b3f52;
                --v-info-bg: #121e28; --v-info-text: #63b3f7;
                --v-success-bg: #10261b; --v-success-text: #7cd8a0;
                --v-warning-bg: #2c220a; --v-warning-text: #f0c25a;
                --v-error-bg: #2a1414; --v-error-text: #f0827e;
                --v-internal-bg: #123821; --v-internal-text: #6fe39a;
                --v-external-bg: #3a1715; --v-external-text: #f2938c;
                --v-danger-border: #a83a3d; --v-danger-text: #f0827e;
                --v-overlay: rgba(0,0,0,.7);
                --v-focus-shadow: rgba(79,163,247,.2);
            }
            * { box-sizing: border-box; }
            button, input, select, textarea { font: inherit; }

            .launcher {
                position: fixed; right: 24px; top: 140px; z-index: 2147483000;
                width: 48px; height: 48px; border-radius: 50%; border: 2px solid #fff;
                background: var(--v-accent); color: #fff;
                box-shadow: 0 4px 14px rgba(0,0,0,.3); cursor: pointer;
                display: flex; align-items: center; justify-content: center; transition: transform .15s, box-shadow .15s;
            }
            .launcher::after { content: ''; position: absolute; inset: -6px; border-radius: 50%; border: 2px solid var(--v-accent); opacity: .6; animation: tjspArchivePulso 2.2s ease-out infinite; pointer-events: none; }
            @keyframes tjspArchivePulso { 0% { transform: scale(.85); opacity: .6; } 100% { transform: scale(1.35); opacity: 0; } }
            .launcher svg { width: 20px; height: 20px; position: relative; fill: none; stroke: currentColor; stroke-width: 2; }
            .launcher:hover { transform: scale(1.08); box-shadow: 0 6px 18px rgba(0,0,0,.4); }

            .restore-pill {
                position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); z-index: 2147483000;
                display: flex; align-items: center; gap: 8px; padding: 11px 18px; border: none; border-radius: 99px;
                background: var(--v-accent); color: #fff; font-size: 12.5px; font-weight: 700; cursor: pointer;
                box-shadow: 0 8px 24px rgba(16,39,64,.4); font-family: inherit;
            }
            .restore-pill[hidden] { display: none; }
            .restore-pill small { opacity: .85; font-weight: 400; }

            .overlay { position: fixed; inset: 0; z-index: 2147483001; padding: 10px; background: var(--v-overlay); backdrop-filter: blur(2px); display: none; }
            :host(.open) .overlay { display: flex; }
            .dialog {
                position: relative;
                width: min(1720px, 99vw); height: min(98vh, 1180px); margin: auto;
                background: var(--v-page); color: var(--v-text); border: 1px solid var(--v-outer-border); border-radius: 14px;
                box-shadow: 0 24px 70px rgba(16,39,64,.35); display: flex; flex-direction: column; overflow: hidden;
                transition: background .2s, color .2s, border-color .2s;
            }

            .top { height: 64px; padding: 0 20px; background: var(--v-header); border-bottom: 3px solid var(--v-header-border); color: var(--v-header-text); display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
            .top-icon { width: 22px; height: 22px; fill: none; stroke: var(--v-header-text); stroke-width: 2; flex-shrink: 0; }
            .top-titles { flex: 1; }
            .top-titles h2 { margin: 0; font-size: 17px; font-weight: 800; }
            .top-titles small { opacity: .85; font-size: 11px; }
            .header-icon-btn { width: 32px; height: 32px; border: 1px solid rgba(255,255,255,.3); border-radius: 7px; background: rgba(255,255,255,.12); color: var(--v-header-text); font-size: 19px; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
            .header-icon-btn svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; }
            .close:hover { background: var(--v-close-hover); }
            .theme-toggle .icon-sun { display: none; }
            :host(.dark) .theme-toggle .icon-sun { display: flex; }
            :host(.dark) .theme-toggle .icon-moon { display: none; }

            .stats-strip { display: flex; align-items: center; gap: 18px; padding: 8px 20px; background: var(--v-stats-bg); border-bottom: 1px solid var(--v-stats-border); flex-shrink: 0; }
            .stats-strip[hidden] { display: none; }
            .stats-main { display: flex; flex-direction: column; gap: 1px; flex-shrink: 0; }
            .stats-main .count { font-weight: 800; color: var(--v-accent); font-size: 13px; }
            .stats-main small { color: var(--v-muted-2); font-size: 10.5px; }
            .stats-gse { flex: 1; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 3px 14px; max-height: 50px; overflow: auto; }
            .gse-bar-row { display: grid; grid-template-columns: 1fr 55px 30px; align-items: center; gap: 6px; font-size: 10px; }
            .gse-bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--v-text-3); }
            .gse-bar-track { height: 5px; background: var(--v-stats-border); border-radius: 99px; overflow: hidden; }
            .gse-bar-fill { height: 100%; background: linear-gradient(90deg, var(--v-accent), var(--v-header-border)); }
            .gse-bar-count { text-align: right; color: var(--v-accent); font-weight: 700; }

            .search-area { padding: 12px 20px 8px; background: var(--v-panel); border-bottom: 1px solid var(--v-panel-border); flex-shrink: 0; max-height: min(300px, 32vh); overflow-y: auto; }
            .mode-radio { position: absolute; opacity: 0; pointer-events: none; }
            .mode-tabs { display: flex; gap: 18px; margin-bottom: 10px; border-bottom: 1px solid var(--v-panel-border); }
            .mode-tab {
                height: 34px; padding: 0 2px; border: none; border-bottom: 2px solid transparent; display: flex; align-items: center; gap: 6px;
                font-size: 12px; font-weight: 700; cursor: pointer;
                background: transparent; color: var(--v-muted); margin-bottom: -1px;
                transition: color .15s, border-color .15s;
            }
            .mode-tab-icon { width: 16px; height: 16px; stroke-width: 1.8; flex-shrink: 0; fill: none; stroke: currentColor; }
            #tjspModeTerms:checked ~ .mode-tabs label[for="tjspModeTerms"],
            #tjspModeSimilar:checked ~ .mode-tabs label[for="tjspModeSimilar"],
            #tjspModeStats:checked ~ .mode-tabs label[for="tjspModeStats"] { color: var(--v-accent); border-bottom-color: var(--v-accent); }
            .terms-mode { display: block; }
            .semantic-mode { display: none; }
            .stats-mode { display: none; max-width: 640px; }
            #tjspModeSimilar:checked ~ .terms-mode, #tjspModeStats:checked ~ .terms-mode { display: none; }
            #tjspModeSimilar:checked ~ .semantic-mode { display: block; }
            #tjspModeStats:checked ~ .stats-mode { display: block; }
            .stats-intro { font-size: 12px; color: var(--v-muted); line-height: 1.6; margin: 0 0 10px; }
            .stats-intro b { color: var(--v-text-2); font-weight: 700; }
            .stats-row { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
            .stats-row .control { max-width: 280px; flex: 1; min-width: 200px; }
            .stats-row .control label { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 700; color: var(--v-muted); text-transform: uppercase; letter-spacing: .04em; }
            .stats-row .control select { width: 100%; height: 36px; padding: 0 10px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); }
            .stats-search { height: 36px; padding: 0 18px; border: none; border-radius: 6px; background: var(--v-accent); color: #fff; font-weight: 700; font-size: 12.5px; cursor: pointer; }
            .stats-fixed { margin-bottom: 14px; }
            .stats-fixed .panel { background: var(--v-panel-alt); border: 1px solid var(--v-panel-alt-border); border-radius: 8px; padding: 13px; }
            .stats-tag-title { font-size: 10.5px; font-weight: 700; color: var(--v-muted); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 8px; }
            .stats-tag-row { display: flex; gap: 8px; flex-wrap: wrap; }
            .stats-tag { height: 30px; padding: 0 13px; border-radius: 99px; border: 1.5px solid var(--v-accent); color: var(--v-accent); background: var(--v-panel); font-size: 12px; font-weight: 700; cursor: pointer; }
            .stats-tag.active { background: var(--v-accent); color: #fff; border-color: transparent; }
            .stats-tag-fields { display: flex; flex-wrap: wrap; gap: 14px; }
            .stats-tag-slot { margin-top: 12px; min-width: 240px; display: flex; gap: 12px; flex-wrap: wrap; }
            .stats-tag-slot .control { flex: 1; min-width: 200px; }
            .stats-tag-slot[hidden] { display: none; }

            .prefs-block { margin-bottom: 14px; padding-bottom: 14px; border-bottom: 1px dashed var(--v-panel-border); }
            .prefs-bar { margin-top: 8px; }
            .prefs-empty { font-size: 11.5px; color: var(--v-muted); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
            .prefs-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
            .pref-chip { position: relative; height: 28px; padding: 0 6px 0 11px; border-radius: 99px; border: 1.5px solid var(--v-accent-soft-border); background: var(--v-accent-soft); color: var(--v-accent); font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; gap: 5px; }
            .pref-chip-name { cursor: pointer; }
            .pref-kebab { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: .7; font-size: 13px; }
            .pref-kebab:hover { opacity: 1; background: rgba(0,0,0,.08); }
            .pref-kebab-menu { position: absolute; top: calc(100% + 4px); left: 0; z-index: 50; background: var(--v-panel); border: 1px solid var(--v-outer-border); border-radius: 8px; box-shadow: 0 12px 28px rgba(16,39,64,.2); padding: 4px; min-width: 190px; }
            .pref-kebab-menu[hidden] { display: none; }
            .pref-kebab-menu button { width: 100%; text-align: left; padding: 6px 9px; border: 0; background: var(--v-panel); border-radius: 5px; font-size: 11px; color: var(--v-text-2); cursor: pointer; white-space: nowrap; }
            .pref-kebab-menu button:hover { background: var(--v-accent-soft); }
            .pref-action { height: 26px; padding: 0 10px; border-radius: 6px; font-size: 10.5px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; border: 1.5px dashed var(--v-accent); background: var(--v-panel); color: var(--v-accent); }
            .pref-share-btn, .prefs-copy-code, .prefs-import-btn { border: 1px solid var(--v-input-border); }
            .prefs-viewall-link { font-size: 11px; color: var(--v-muted-2); font-weight: 700; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
            .prefs-manager, .prefs-share-panel { margin-top: 10px; padding: 11px; border: 1px solid var(--v-panel-alt-border); border-radius: 8px; background: var(--v-panel-alt); }
            .prefs-manager[hidden], .prefs-share-panel[hidden] { display: none; }
            .prefs-manager-list { display: grid; gap: 4px; max-height: 220px; overflow: auto; }
            .prefs-manager-row { position: relative; display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; }
            .prefs-manager-row:hover { background: var(--v-accent-soft); }
            .prefs-manager-name { flex: 1; font-size: 12px; color: var(--v-text-2); cursor: pointer; font-weight: 600; }
            .prefs-manager-empty { font-size: 11.5px; color: var(--v-muted); margin: 0; }
            .prefs-share-label { font-size: 10px; font-weight: 700; color: var(--v-muted); text-transform: uppercase; letter-spacing: .04em; margin: 0 0 5px; }
            .prefs-share-panel textarea { width: 100%; font-size: 11px; padding: 7px 9px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); resize: vertical; font-family: inherit; margin-bottom: 6px; }

            .stats-view-toggle { display: flex; gap: 4px; }
            .stats-view-toggle[hidden] { display: none; }
            .view-btn { width: 28px; height: 28px; padding: 0; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; }
            .view-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; }
            .view-btn.active { background: var(--v-accent); color: #fff; border-color: transparent; }

            .stats-table { width: 100%; border-collapse: collapse; font-size: 12px; }
            .stats-table th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; color: var(--v-muted); font-weight: 800; padding: 7px 10px; border-bottom: 1px solid var(--v-panel-border); position: sticky; top: 0; background: var(--v-page); }
            .stats-table td { padding: 9px 10px; border-bottom: 1px solid var(--v-panel-border); color: var(--v-text-2); vertical-align: middle; }
            .stats-table tr:hover td { background: var(--v-accent-soft); }
            .stats-table tr.active td { background: var(--v-card-active-bg); }
            .stats-table a { color: var(--v-accent); font-weight: 800; text-decoration: none; }
            .stats-table .row-select { accent-color: var(--v-accent); width: 15px; height: 15px; cursor: pointer; }

            .stats-previewable { position: relative; }
            .stats-tip { display: none; position: absolute; left: 0; top: 100%; z-index: 30; width: 280px; background: #20313f; color: #eef3f8; font-size: 11.5px; line-height: 1.5; padding: 9px 11px; border-radius: 7px; box-shadow: 0 10px 24px rgba(0,0,0,.28); }
            .stats-previewable:hover .stats-tip { display: block; }
            .vip-dot { color: #8a6300; font-weight: 900; }

            .stats-tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
            .stats-tile { background: var(--v-card-bg); border: 1px solid var(--v-card-border); border-left: 3px solid var(--v-card-accent); border-radius: 8px; padding: 9px 11px; }
            .stats-tile:hover { background: var(--v-accent-soft); }
            .stats-tile.active { border-color: var(--v-card-active-border); background: var(--v-card-active-bg); }
            .stats-tile-head { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; position: relative; }
            .stats-tile-head a { color: var(--v-accent); font-weight: 800; font-size: 12.5px; text-decoration: none; }
            .stats-tile-head .icon-btn { margin-left: auto; width: 22px; height: 22px; }
            .stats-tile-head .select-checkbox input { width: 14px; height: 14px; accent-color: var(--v-accent); cursor: pointer; }
            .stats-tile-mini { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; font-size: 11px; color: var(--v-text-2); }
            .stats-tile-mini small { display: block; font-size: 9px; color: var(--v-muted); text-transform: uppercase; }
            .query-row { display: grid; grid-template-columns: 1fr auto; gap: 9px; }
            .query-wrap { position: relative; }
            .query-wrap svg { position: absolute; left: 12px; top: 50%; width: 17px; transform: translateY(-50%); fill: none; stroke: var(--v-muted-3); stroke-width: 2; }
            .query { width: 100%; height: 40px; padding: 0 12px 0 38px; border: 1px solid var(--v-input-border); border-radius: 6px; outline: none; font-size: 13.5px; background: var(--v-panel); color: var(--v-text); }
            .query:focus { border-color: var(--v-accent); box-shadow: 0 0 0 3px var(--v-focus-shadow); }
            .search { height: 40px; padding: 0 20px; border: none; border-radius: 6px; background: var(--v-accent); color: #fff; font-weight: 700; cursor: pointer; display: flex; align-items: center; gap: 7px; }
            .search:disabled { opacity: .5; cursor: not-allowed; }
            .search svg { width: 16px; fill: none; stroke: currentColor; stroke-width: 2; }
            .operators-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
            .operators-row .operators-label { font-size: 11px; font-weight: 700; color: var(--v-muted); text-transform: uppercase; letter-spacing: .03em; margin-right: 2px; }
            .operator { height: 25px; padding: 0 8px; border: 1px solid var(--v-accent-soft-border); border-radius: 5px; background: var(--v-accent-soft); color: var(--v-accent); cursor: pointer; }
            .operator:hover { background: var(--v-accent-soft-hover); }

            .semantic-query { width: 100%; min-height: 64px; padding: 10px 12px; border: 1px solid var(--v-input-border); border-radius: 6px; outline: none; font-size: 13px; resize: vertical; font-family: inherit; background: var(--v-panel); color: var(--v-text); }
            .semantic-query:focus { border-color: var(--v-accent); box-shadow: 0 0 0 3px var(--v-focus-shadow); }
            .semantic-actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; flex-wrap: wrap; }
            .semantic-search { height: 36px; padding: 0 16px; border: none; border-radius: 6px; background: var(--v-accent); color: #fff; font-weight: 700; font-size: 12.5px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; }
            .semantic-search svg { width: 16px; height: 16px; flex-shrink: 0; }
            .semantic-search:disabled { opacity: .5; cursor: not-allowed; }
            .semantic-limit-label { font-size: 12px; color: var(--v-muted-2); display: flex; align-items: center; gap: 6px; }
            .semantic-limit-label select { height: 28px; padding: 0 6px; border: 1px solid var(--v-input-border); border-radius: 5px; background: var(--v-panel); color: var(--v-text); }
            .semantic-actions small { color: var(--v-muted-3); font-size: 11px; }

            .actions-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 9px 20px; background: var(--v-panel); border-bottom: 1px solid var(--v-panel-border); position: relative; flex-shrink: 0; }
            .btn { height: 32px; padding: 0 12px; border-radius: 6px; font-weight: 700; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
            .btn[hidden] { display: none; }
            .btn svg { width: 13px; fill: none; stroke: currentColor; stroke-width: 2; }
            .btn-primary { border: none; background: var(--v-accent); color: #fff; }
            .btn-secondary { border: 1px solid var(--v-input-border); background: var(--v-panel); color: var(--v-text-2); }
            .btn-secondary:hover { background: var(--v-accent-soft); }
            .btn-danger { border: 1px solid var(--v-danger-border); background: var(--v-panel); color: var(--v-danger-text); }
            .btn:disabled { opacity: .5; cursor: not-allowed; }
            .sort-select, .control-inline { height: 32px; padding: 0 8px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); font-size: 12px; }
            .field-checks { display: flex; align-items: center; gap: 9px; height: 32px; padding: 0 10px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); }
            .field-checks[hidden] { display: none; }
            .field-checks-label { font-size: 11px; font-weight: 700; color: var(--v-muted); }
            .option-inline { display: flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--v-text-2); cursor: pointer; }
            .option-inline input { accent-color: var(--v-accent); width: 13px; height: 13px; }
            .info-icon { width: 13px; height: 13px; fill: none; stroke: var(--v-muted); stroke-width: 1.8; flex-shrink: 0; }
            .spacer { flex: 1; }
            .export-wrap { position: relative; }
            .export-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 40; background: var(--v-panel); border: 1px solid var(--v-outer-border); border-radius: 8px; box-shadow: 0 12px 28px rgba(16,39,64,.24); padding: 4px; min-width: 200px; }
            .export-menu[hidden] { display: none; }
            .export-menu button { width: 100%; text-align: left; padding: 8px 10px; border: 0; background: var(--v-panel); color: var(--v-text); border-radius: 5px; cursor: pointer; font-size: 12.5px; white-space: nowrap; }
            .export-menu button:hover { background: var(--v-accent-soft); }

            .advanced-toggle-wrap { position: relative; }
            .advanced-toggle { display: inline-flex; align-items: center; gap: 6px; }
            .advanced-toggle svg { width: 12px; transition: transform .15s; }
            .advanced-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
            .advanced-panel {
                position: absolute; left: 0; top: calc(100% + 8px); z-index: 60;
                width: min(820px, 90vw); max-height: 60vh; overflow: auto;
                background: var(--v-panel); border: 1px solid var(--v-outer-border); border-radius: 10px;
                box-shadow: 0 16px 40px rgba(16,39,64,.28); padding: 16px;
                display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
            }
            .advanced-panel[hidden] { display: none; }
            .panel { padding: 13px; border: 1px solid var(--v-panel-alt-border); border-radius: 8px; background: var(--v-panel-alt); }
            .panel h3 { margin: 0 0 11px; color: var(--v-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
            .control label { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 700; color: var(--v-muted); text-transform: uppercase; letter-spacing: .04em; }
            .control input, .control select { width: 100%; height: 32px; padding: 0 9px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); font-size: 12.5px; }
            .people-grid { display: grid; gap: 10px; }
            .date-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
            .option-list { display: grid; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--v-panel-border); }
            .option { display: grid; grid-template-columns: 16px 1fr; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }
            .option input { width: 15px; height: 15px; accent-color: var(--v-accent); }
            .gse-tools { display: flex; gap: 6px; margin-bottom: 8px; }
            .tiny { height: 26px; padding: 0 9px; border: 1px solid var(--v-input-border); border-radius: 5px; background: var(--v-panel); color: var(--v-text-3); font-size: 11px; cursor: pointer; }
            .tiny:hover { background: var(--v-accent-soft); }
            .tiny:disabled { opacity: .5; cursor: not-allowed; }
            .gse-list { max-height: 130px; padding: 8px; border: 1px solid var(--v-panel-border); border-radius: 6px; background: var(--v-panel); overflow: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 5px 12px; }
            .gse-item { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
            .gse-item input { accent-color: var(--v-accent); }

            .person-control { position: relative; }
            .person-hint { display: block; margin-top: 4px; font-size: 10.5px; color: var(--v-muted-3); font-weight: 400; text-transform: none; letter-spacing: normal; }
            .specialist-menu {
                position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 80;
                max-height: 220px; overflow: auto; background: var(--v-panel); border: 1px solid var(--v-outer-border); border-radius: 8px;
                box-shadow: 0 10px 26px rgba(32,55,78,.2); padding: 4px;
            }
            .specialist-menu[hidden] { display: none !important; }
            .specialist-option { width: 100%; padding: 8px 10px; border: 0; border-radius: 5px; background: var(--v-panel); color: var(--v-text); text-align: left; cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; }
            .specialist-option:hover, .specialist-option.active { background: var(--v-accent-soft); color: var(--v-accent); }
            .specialist-option strong { font-size: 12px; line-height: 1.3; }
            .specialist-option small { font-size: 10px; color: var(--v-muted-3); align-self: center; }
            .specialist-option span { grid-column: 1/-1; font-size: 10px; color: var(--v-muted-3); }
            .specialist-vip { display: inline-block; grid-column: auto; font-size: 9px; font-weight: 800; color: var(--v-vip-text); background: var(--v-vip-bg); border-radius: 4px; padding: 1px 6px; vertical-align: 1px; }
            .specialist-external { display: inline-block; grid-column: auto; font-size: 9px; font-weight: 800; color: var(--v-external-text); background: var(--v-external-bg); border-radius: 4px; padding: 1px 6px; vertical-align: 1px; }
            .specialist-internal { display: inline-block; grid-column: auto; font-size: 9px; font-weight: 800; color: var(--v-internal-text); background: var(--v-internal-bg); border-radius: 4px; padding: 1px 6px; vertical-align: 1px; }
            .specialist-message { padding: 10px; color: var(--v-muted-3); font-size: 11px; text-align: center; }
            .specialist-spinner { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border: 2px solid var(--v-stats-border); border-top-color: var(--v-accent); border-radius: 50%; vertical-align: -2px; animation: tjspArchiveSpecialistSpin .65s linear infinite; }
            @keyframes tjspArchiveSpecialistSpin { to { transform: rotate(360deg); } }
            .person-hint.confirmed { color: var(--v-success-text); font-weight: 700; }

            .navigator { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; padding: 8px 20px; background: var(--v-panel); border-bottom: 1px solid var(--v-panel-border); flex-shrink: 0; }
            .navigator button.nav-btn { height: 30px; padding: 0 11px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text-2); cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
            .navigator button.nav-btn:hover:not(:disabled) { background: var(--v-accent-soft); }
            .navigator button.nav-btn:disabled { opacity: .4; cursor: default; }
            .navigator svg { width: 14px; fill: none; stroke: currentColor; stroke-width: 2; }
            .result-counter { min-width: 70px; text-align: center; font-size: 12px; font-weight: 700; color: var(--v-accent); }
            .select-page { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--v-text-2); cursor: pointer; }
            .select-page input { accent-color: var(--v-accent); }
            .selection-count { font-size: 11.5px; font-weight: 700; color: var(--v-accent); }
            .keyboard-help { font-size: 11px; color: var(--v-muted-3); }

            .progress { padding: 7px 20px; background: var(--v-stats-bg); border-bottom: 1px solid var(--v-stats-border); flex-shrink: 0; }
            .progress[hidden] { display: none; }
            .progress-text { font-size: 12px; color: var(--v-accent); }
            .track { height: 6px; margin-top: 6px; background: var(--v-stats-border); border-radius: 99px; overflow: hidden; }
            .fill { height: 100%; width: 0; background: linear-gradient(90deg, var(--v-accent), var(--v-header-border)); transition: width .2s; }
            .status { padding: 7px 20px; font-size: 12.5px; flex-shrink: 0; }
            .status:empty { display: none; }
            .info { background: var(--v-info-bg); color: var(--v-info-text); } .success { background: var(--v-success-bg); color: var(--v-success-text); }
            .warning { background: var(--v-warning-bg); color: var(--v-warning-text); } .error { background: var(--v-error-bg); color: var(--v-error-text); }

            .results { padding: 16px 20px; overflow: auto; flex: 1; min-height: 0; }
            .result-card { scroll-margin-top: 12px; background: var(--v-card-bg); border: 1px solid var(--v-card-border); border-left: 4px solid var(--v-card-accent); border-radius: 10px; padding: 13px 16px; margin-bottom: 14px; box-shadow: 0 4px 14px rgba(35,62,88,.08); transition: box-shadow .15s, border-color .15s; }
            .result-card:hover { box-shadow: 0 7px 20px rgba(35,62,88,.12); }
            .result-card.active { border-color: var(--v-card-active-border); background: var(--v-card-active-bg); box-shadow: 0 0 0 2px var(--v-focus-shadow), 0 8px 22px rgba(35,62,88,.14); }
            .result-card header { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
            .select-checkbox input { width: 16px; height: 16px; accent-color: var(--v-accent); cursor: pointer; }
            .result-card header a { display: inline-flex; align-items: center; gap: 6px; color: var(--v-accent); font-weight: 800; font-size: 14.5px; text-decoration: none; }
            .result-card header a svg { width: 15px; fill: none; stroke: currentColor; stroke-width: 2; }
            .result-card header a:hover { text-decoration: underline; }
            .vip-badge { font-size: 10px; font-weight: 800; color: var(--v-vip-text); background: var(--v-vip-bg); border-radius: 4px; padding: 2px 7px; display: inline-flex; align-items: center; gap: 3px; }
            .vip-badge svg { width: 10px; height: 10px; }
            .gse-tag { font-size: 10.5px; font-weight: 700; color: var(--v-accent); background: var(--v-accent-soft); border-radius: 4px; padding: 2px 8px; }
            .occ-badge { font-size: 10px; font-weight: 800; color: var(--v-occ-text); background: var(--v-occ-bg); border-radius: 4px; padding: 2px 7px; }
            .sim-badge { font-size: 10px; font-weight: 800; color: var(--v-accent); background: var(--v-sim-bg); border: 1px solid var(--v-sim-border); border-radius: 4px; padding: 2px 7px; }
            .result-card header .date { margin-left: auto; font-size: 11px; color: var(--v-muted-3); }
            .icon-btn { width: 26px; height: 26px; padding: 0; border: 1px solid var(--v-accent-soft-border); border-radius: 6px; background: var(--v-accent-soft); color: var(--v-accent); cursor: pointer; display: flex; align-items: center; justify-content: center; }
            .icon-btn:hover { background: var(--v-accent-soft-hover); }
            .icon-btn svg { width: 13px; fill: none; stroke: currentColor; stroke-width: 2; }
            .result-card .field { margin-top: 9px; font-size: 13px; }
            .result-card .field strong { display: block; font-size: 10.5px; text-transform: uppercase; color: var(--v-text-3); margin-bottom: 3px; }
            .result-card .field p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; color: var(--v-text-soft); }
            .result-card .field.collapsed p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
            .result-card .field mark { background: var(--v-mark-bg); color: var(--v-mark-text); border-radius: 2px; padding: 0 1px; }
            .expand-text { margin-top: 6px; padding: 0; border: 0; background: transparent; color: var(--v-accent); font-size: 11.5px; font-weight: 700; cursor: pointer; }
            .result-card footer { display: flex; gap: 20px; margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--v-panel-border); font-size: 12px; color: var(--v-text-2); }
            .result-card footer small { display: block; font-size: 10px; text-transform: uppercase; color: var(--v-muted); margin-bottom: 2px; }
            .empty { padding: 60px; text-align: center; color: var(--v-muted-3); }
            .pagination { padding: 11px 20px; background: var(--v-panel); border-top: 1px solid var(--v-panel-border); display: flex; justify-content: center; align-items: center; gap: 12px; flex-shrink: 0; }
            .pagination[hidden] { display: none; }
            .pagination button { height: 32px; padding: 0 12px; border: 1px solid var(--v-input-border); background: var(--v-panel); color: var(--v-text); border-radius: 6px; cursor: pointer; }
            .pagination button:disabled { opacity: .45; cursor: not-allowed; }
            .pagination span { font-size: 12px; color: var(--v-muted); }

            .focus-overlay { position: absolute; inset: 0; z-index: 25; padding: 18px; background: var(--v-overlay); backdrop-filter: blur(2px); display: flex; }
            .focus-overlay[hidden] { display: none; }
            .focus-body { width: min(1100px,100%); height: 100%; margin: auto; background: var(--v-card-bg); border: 1px solid var(--v-outer-border); border-top: 4px solid var(--v-header-border); border-radius: 10px; box-shadow: 0 18px 50px rgba(15,35,55,.32); display: flex; flex-direction: column; overflow: hidden; }
            .focus-header { padding: 14px 18px; border-bottom: 1px solid var(--v-panel-alt-border); background: var(--v-panel-alt); display: flex; align-items: center; gap: 14px; }
            .focus-header > div { flex: 1; display: grid; grid-template-columns: auto auto; gap: 3px 12px; align-items: center; }
            .focus-position { grid-column: 1/-1; color: var(--v-muted); font-size: 11px; }
            .focus-header a { color: var(--v-accent); font-size: 19px; font-weight: 800; text-decoration: none; }
            .focus-header small { color: var(--v-muted); }
            .focus-select { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--v-text-2); cursor: pointer; flex-shrink: 0; }
            .focus-select input { accent-color: var(--v-accent); width: 15px; height: 15px; }
            .focus-close { flex-shrink: 0; width: 34px; height: 34px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); font-size: 21px; cursor: pointer; }
            .focus-close:hover { background: var(--v-error-bg); border-color: var(--v-danger-border); }
            .focus-nav { height: 44px; padding: 6px 14px; background: var(--v-panel); border-bottom: 1px solid var(--v-panel-border); display: flex; align-items: center; justify-content: center; gap: 9px; flex: 0 0 auto; }
            .focus-nav button { height: 30px; padding: 0 12px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text-2); font-weight: 600; cursor: pointer; }
            .focus-nav button:hover:not(:disabled) { background: var(--v-accent-soft); }
            .focus-nav button:disabled { opacity: .42; cursor: default; }
            .focus-nav span { min-width: 100px; text-align: center; color: var(--v-accent); font-size: 12px; font-weight: 700; }
            .focus-nav small { margin-left: auto; color: var(--v-muted-3); font-size: 11px; }
            .focus-scroll { padding: 18px; overflow: auto; flex: 1; }
            .focus-scroll section { padding: 0 0 18px; }
            .focus-scroll section + section { padding-top: 18px; border-top: 1px solid var(--v-panel-border); }
            .focus-scroll h3 { margin: 0 0 10px; color: var(--v-text-3); font-size: 12px; text-transform: uppercase; }
            .focus-scroll section div { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; font-size: 14px; color: var(--v-text-soft); }
            .focus-scroll section div mark { background: var(--v-mark-bg); color: var(--v-mark-text); border-radius: 2px; padding: 0 1px; }
            .focus-scroll footer { display: grid; grid-template-columns: 1fr 1fr 1.3fr; gap: 18px; padding: 14px; background: var(--v-panel-alt); border: 1px solid var(--v-panel-alt-border); border-radius: 8px; }
            .focus-scroll footer small { display: block; font-size: 10px; text-transform: uppercase; color: var(--v-muted); margin-bottom: 3px; }

            @media (max-width: 960px) {
                .advanced-panel, .date-grid { grid-template-columns: 1fr; }
                .stats-gse { display: none; }
                .keyboard-help { display: none; }
            }
        </style>
        <button class="launcher" type="button" title="Pesquisa completa no acervo SMAX"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 11h16M4 16h10"></path><circle cx="18" cy="18" r="3.2"></circle><path d="M20.3 20.3L23 23"></path></svg></button>
        <button class="restore-pill" type="button" hidden></button>
        <div class="overlay"><section class="dialog">
            <header class="top">
                <svg class="top-icon" viewBox="0 0 24 24"><path d="M4 6h16M4 11h16M4 16h10"></path><circle cx="18" cy="18" r="3.2"></circle><path d="M20.3 20.3L23 23"></path></svg>
                <div class="top-titles"><h2>Pesquisa Completa no Acervo SMAX</h2><small>v${VERSION} · busca exaustiva, sem corte de relevância · agora com busca por semelhança (BM25, 100% local) — nada salvo em disco</small></div>
                <button class="header-icon-btn theme-toggle" type="button" title="Alternar tema claro/escuro">
                    <svg class="icon-moon" viewBox="0 0 24 24"><path d="M21 12.5A8.5 8.5 0 1111.5 3a7 7 0 009.5 9.5z"></path></svg>
                    <svg class="icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"></path></svg>
                </button>
                <button class="header-icon-btn minimize" type="button" title="Minimizar (sem perder o acervo carregado)"><svg viewBox="0 0 24 24"><path d="M5 12h14"></path></svg></button>
                <button class="header-icon-btn close" type="button">×</button>
            </header>
            <div class="stats-strip" hidden>
                <div class="stats-main"><span class="count"></span><small class="loaded-at"></small><small class="range"></small></div>
                <div class="stats-gse"></div>
            </div>
            <section class="search-area">
                <input type="radio" name="tjspSearchMode" id="tjspModeTerms" class="mode-radio" checked>
                <input type="radio" name="tjspSearchMode" id="tjspModeSimilar" class="mode-radio">
                <input type="radio" name="tjspSearchMode" id="tjspModeStats" class="mode-radio">
                <div class="mode-tabs">
                    <label for="tjspModeTerms" class="mode-tab">
                        <svg class="mode-tab-icon" viewBox="0 0 24 24"><circle cx="10" cy="10" r="7"></circle><path d="M15 15L21 21"></path><text x="10" y="12.8" font-size="7" font-weight="800" text-anchor="middle" stroke="none" fill="currentColor">Aa</text></svg>
                        Pesquisa por termos
                    </label>
                    <label for="tjspModeSimilar" class="mode-tab">
                        <svg class="mode-tab-icon" viewBox="0 0 24 24"><path d="M12 6L5.5 17.5M12 6L18.5 17.5M6 18H18" stroke-linecap="round"></path><circle cx="12" cy="5.5" r="2.1" fill="currentColor" stroke="none"></circle><circle cx="5" cy="18" r="2.1" fill="currentColor" stroke="none"></circle><circle cx="19" cy="18" r="2.1" fill="currentColor" stroke="none"></circle></svg>
                        Pesquisa por semelhança
                    </label>
                    <label for="tjspModeStats" class="mode-tab">
                        <svg class="mode-tab-icon" viewBox="0 0 24 24"><path d="M4 20V14"></path><path d="M11 20V8"></path><path d="M18 20V4"></path></svg>
                        Busca Estatística
                    </label>
                </div>
                <div class="terms-mode">
                    <div class="query-row">
                        <div class="query-wrap"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.25"></circle><path d="M15.2 15.2L20 20"></path></svg><input class="query" type="text" placeholder='Ex.: "erro ao assinar" E eproc -certificado'></div>
                        <button class="search" type="button"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.25"></circle><path d="M15.2 15.2L20 20"></path></svg>Pesquisar no acervo</button>
                    </div>
                    <div class="operators-row"><span class="operators-label">Inserir:</span>
                        <button class="operator" data-insert='""' title="Frase exata">" "</button>
                        <button class="operator" data-insert=" E " title="E lógico">E</button>
                        <button class="operator" data-insert=" OU " title="OU lógico">OU</button>
                        <button class="operator" data-insert=" NÃO " title="NÃO lógico">NÃO</button>
                        <button class="operator" data-insert="()" title="Agrupar">( )</button>
                        <button class="operator" data-insert="-" title="Atalho de exclusão">−</button>
                    </div>
                </div>
                <div class="semantic-mode">
                    <textarea class="semantic-query" rows="3" placeholder="Cole aqui a descrição do chamado atual. O motor encontra, dentro do acervo já carregado, as solicitações mais parecidas por vocabulário (BM25) — 100% local, sem IA, nada enviado pra fora."></textarea>
                    <div class="semantic-actions">
                        <button class="semantic-search" type="button"><svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" fill="none"><path d="M12 6L5.5 17.5M12 6L18.5 17.5M6 18H18" stroke-linecap="round"></path><circle cx="12" cy="5.5" r="2.1" fill="currentColor" stroke="none"></circle><circle cx="5" cy="18" r="2.1" fill="currentColor" stroke="none"></circle><circle cx="19" cy="18" r="2.1" fill="currentColor" stroke="none"></circle></svg>Buscar casos semelhantes</button>
                        <label class="semantic-limit-label">Mostrar até
                            <select class="semantic-limit">
                                <option value="20">20</option>
                                <option value="50" selected>50</option>
                                <option value="100">100</option>
                                <option value="200">200</option>
                            </select> resultados
                        </label>
                        <small>Ctrl+Enter busca · funciona melhor com 1-3 frases descrevendo o caso.</small>
                    </div>
                </div>
                <div class="stats-mode">
                    <p class="stats-intro">GSE e período já vêm prontos pra usar (sem eles não tem o que contar). Os demais filtros são opcionais — clique pra abrir só os que for usar.</p>
                    <div class="prefs-block">
                        <p class="stats-tag-title">Preferências</p>
                        <div class="prefs-bar"></div>
                        <div class="prefs-manager" hidden></div>
                        <div class="prefs-share-panel" hidden>
                            <p class="prefs-share-label">Exportar (copie e envie para outra pessoa)</p>
                            <textarea class="prefs-export-code" readonly rows="2"></textarea>
                            <button type="button" class="prefs-copy-code pref-action">📋 Copiar código</button>
                            <p class="prefs-share-label" style="margin-top:10px">Importar (cole um código recebido)</p>
                            <textarea class="prefs-import-code" rows="2" placeholder="Cole aqui o código TJSP-PREF1:..."></textarea>
                            <button type="button" class="prefs-import-btn pref-action">⬇ Importar</button>
                        </div>
                    </div>
                    <div class="stats-fixed" id="statsGseSlot"></div>
                    <div class="stats-fixed" id="statsDateSlot"></div>
                    <p class="stats-tag-title">Outros filtros</p>
                    <div class="stats-tag-row">
                        <button type="button" class="stats-tag" data-slot="statsEspSlot">+ Designado Especialista</button>
                        <button type="button" class="stats-tag" data-slot="statsSolSlot">+ Solicitado para</button>
                        <button type="button" class="stats-tag" data-slot="statsStatusSlot">+ Status</button>
                        <button type="button" class="stats-tag" data-slot="statsUnidadeSlot">+ Unidade/Comarca</button>
                    </div>
                    <div class="stats-tag-fields">
                        <div class="stats-tag-slot" id="statsEspSlot" hidden></div>
                        <div class="stats-tag-slot" id="statsSolSlot" hidden></div>
                        <div class="stats-tag-slot" id="statsStatusSlot" hidden>
                            <div class="control"><label>Status</label><input class="status-filter" placeholder="Ex.: Em andamento"></div>
                            <div class="control"><label>Status Operacional</label><input class="status-operacional-filter" placeholder="Ex.: Aguardando Atendimento"></div>
                        </div>
                        <div class="stats-tag-slot control" id="statsUnidadeSlot" hidden><label>Unidade/Comarca</label><input class="unidade-filter" placeholder="Digite parte do nome da unidade"></div>
                    </div>
                    <div class="stats-row"><button class="stats-search" type="button">Calcular</button></div>
                </div>
            </section>
            <div class="actions-row">
                <button class="btn btn-secondary load" type="button" title="Pesquisar já carrega/recarrega sozinho quando precisa — use isto só se quiser forçar dados mais recentes do SMAX sem mudar nenhum filtro."><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3"></path><path d="M18 4v4h-4M6 20v-4h4"></path></svg>Recarregar acervo</button>
                <button class="btn btn-danger cancel-load" type="button" hidden>Cancelar</button>
                <div class="field-checks"><span class="field-checks-label">Buscar em:</span>
                    <label class="option-inline"><input class="field-description" type="checkbox" checked><span>Descrição</span></label>
                    <label class="option-inline"><input class="field-solution" type="checkbox" checked><span>Solução</span></label>
                    <label class="option-inline" title="Precisa estar marcada ANTES de clicar em Pesquisar/Buscar semelhantes na primeira vez — o acervo recarrega sozinho quando isso muda."><input class="field-discussion" type="checkbox"><span>Discussão</span><svg class="info-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5.5"></path><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"></circle></svg></label>
                </div>
                <select class="mode control-inline"><option value="any">Qualquer palavra</option><option value="exact">Expressão exata</option></select>
                <select class="sort-select"><option value="recent">Mais recentes</option><option value="oldest">Mais antigas</option><option value="relevance" class="sort-text-only">Mais ocorrências</option><option value="similarity" class="sort-text-only">Mais semelhantes</option></select>
                <div class="advanced-toggle-wrap">
                    <button class="btn btn-secondary advanced-toggle" type="button" aria-expanded="false">Filtros avançados<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></button>
                    <div class="advanced-panel" hidden>
                        <section class="panel"><h3>Pessoas</h3><div class="people-grid">
                            <div class="control person-control" id="filterRequestedForControl"><label>Solicitado para</label><input class="requested-for" placeholder="Digite 2+ letras para sugestões" autocomplete="off"><small class="person-hint">Escolher uma sugestão restringe o carregamento a essa pessoa (mais rápido)</small></div>
                            <div class="control person-control" id="filterSpecialistControl"><label>Designado Especialista</label><input class="specialist" placeholder="Digite 2+ letras para sugestões" autocomplete="off"><small class="person-hint">Escolher uma sugestão restringe o carregamento a essa pessoa (mais rápido)</small></div>
                        </div>
                        <label class="option" style="margin-top:10px" id="filterVipControl"><input class="vip-only" type="checkbox"><span>Somente solicitantes VIP</span></label>
                        <div id="filterDateSection">
                        <h3 style="margin-top:10px">Data de criação</h3>
                        <div class="date-grid">
                            <div class="control"><label>Critério</label><select class="date-mode"><option value="any">Qualquer data</option><option value="days">Últimos N dias</option><option value="on">Em uma data</option><option value="after">A partir de</option><option value="before">Até uma data</option><option value="between">Entre duas datas</option></select></div>
                            <div class="control date-from-wrap" hidden><label class="date-from-label">Data</label><input class="date-from" type="date"></div>
                            <div class="control date-to-wrap" hidden><label class="date-to-label">Até</label><input class="date-to" type="date"></div>
                            <div class="control date-days-wrap" hidden><label>Dias corridos</label><input class="date-days" type="number" min="1" placeholder="Ex.: 30"></div>
                        </div></div></section>
                        <section class="panel" id="filterGseSection"><h3>GSEs incluídas na carga</h3>
                            <div class="gse-tools"><button class="tiny select-all" type="button">Selecionar todas</button><button class="tiny clear-gse" type="button">Limpar</button></div>
                            <div class="gse-list"></div>
                        </section>
                        <section class="panel" style="grid-column:1/-1"><h3>Opções de correspondência</h3><div class="option-list">
                            <label class="option"><input class="ignore-case" type="checkbox" checked><span>Ignorar maiúsculas/minúsculas</span></label>
                            <label class="option"><input class="ignore-accents" type="checkbox" checked><span>Ignorar acentos</span></label>
                        </div></section>
                    </div>
                </div>
                <div class="spacer"></div>
                <button class="btn btn-secondary copy" type="button" disabled><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 012-2h10"></path></svg>Copiar resumo</button>
                <div class="export-wrap">
                    <button class="btn btn-secondary export-toggle" type="button" disabled><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0l4-4m-4 4l-4-4M4 21h16"></path></svg>Exportar</button>
                    <div class="export-menu" hidden>
                        <button class="export-csv" type="button">📄 CSV (Excel)</button>
                        <button class="export-json" type="button">🗂 JSON</button>
                        <button class="export-txt" type="button">📝 TXT (relatório)</button>
                        <button class="export-html" type="button">🌐 HTML (imprimível/PDF)</button>
                    </div>
                </div>
            </div>
            <nav class="navigator">
                <button class="nav-btn previous-result" type="button" disabled><svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"></path></svg>Anterior</button>
                <span class="result-counter"></span>
                <button class="nav-btn next-result" type="button" disabled>Próximo<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></button>
                <button class="nav-btn focus-result" type="button" disabled><svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path></svg>Expandir</button>
                <span class="spacer"></span>
                <label class="select-page"><input type="checkbox" class="select-page-checkbox">Marcar página</label>
                <button class="tiny select-all-results" type="button">Marcar todos os resultados</button>
                <span class="selection-count"></span>
                <button class="tiny clear-selection" type="button" hidden>Limpar seleção</button>
                <button class="tiny open-selected" type="button" disabled>Abrir selecionadas</button>
                <div class="stats-view-toggle" hidden>
                    <button type="button" class="view-btn active" data-view="table" title="Ver como tabela"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"></path></svg></button>
                    <button type="button" class="view-btn" data-view="grid" title="Ver como grade"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7"></rect><rect x="13" y="4" width="7" height="7"></rect><rect x="4" y="13" width="7" height="7"></rect><rect x="13" y="13" width="7" height="7"></rect></svg></button>
                </div>
                <span class="keyboard-help">Teclas ↑ e ↓ navegam · Enter expande</span>
            </nav>
            <div class="progress" hidden><div class="progress-text"></div><div class="track"><div class="fill"></div></div></div>
            <div class="status"></div>
            <main class="results"><div class="empty">Carregue o acervo completo e pesquise.</div></main>
            <footer class="pagination" hidden><button class="prev-page">Anterior</button><span class="page-info"></span><button class="next-page">Próxima</button></footer>
            <div class="focus-overlay" hidden><div class="focus-body"></div></div>
        </section></div>`;

        ui = {
            launcher: shadow.querySelector(".launcher"), overlay: shadow.querySelector(".overlay"), close: shadow.querySelector(".close"), themeToggle: shadow.querySelector(".theme-toggle"),
            minimize: shadow.querySelector(".minimize"), restorePill: shadow.querySelector(".restore-pill"),
            statsStrip: shadow.querySelector(".stats-strip"), statsCount: shadow.querySelector(".count"), statsLoadedAt: shadow.querySelector(".loaded-at"), statsRange: shadow.querySelector(".range"), statsGseList: shadow.querySelector(".stats-gse"),
            query: shadow.querySelector(".query"), search: shadow.querySelector(".search"),
            semanticQuery: shadow.querySelector(".semantic-query"), semanticSearch: shadow.querySelector(".semantic-search"), semanticLimit: shadow.querySelector(".semantic-limit"),
            fieldDescription: shadow.querySelector(".field-description"), fieldSolution: shadow.querySelector(".field-solution"), fieldDiscussion: shadow.querySelector(".field-discussion"),
            mode: shadow.querySelector(".mode"), sortSelect: shadow.querySelector(".sort-select"), fieldChecks: shadow.querySelector(".field-checks"),
            loadButton: shadow.querySelector(".load"), cancelLoad: shadow.querySelector(".cancel-load"),
            advancedToggleWrap: shadow.querySelector(".advanced-toggle-wrap"), advancedToggle: shadow.querySelector(".advanced-toggle"), advancedPanel: shadow.querySelector(".advanced-panel"),
            requestedFor: shadow.querySelector(".requested-for"), specialist: shadow.querySelector(".specialist"), vipOnly: shadow.querySelector(".vip-only"),
            statusFilter: shadow.querySelector(".status-filter"), statusOperacionalFilter: shadow.querySelector(".status-operacional-filter"), unidadeFilter: shadow.querySelector(".unidade-filter"),
            statsSearch: shadow.querySelector(".stats-search"),
            dateMode: shadow.querySelector(".date-mode"), dateFrom: shadow.querySelector(".date-from"), dateTo: shadow.querySelector(".date-to"), dateDays: shadow.querySelector(".date-days"),
            dateFromWrap: shadow.querySelector(".date-from-wrap"), dateToWrap: shadow.querySelector(".date-to-wrap"), dateDaysWrap: shadow.querySelector(".date-days-wrap"), dateFromLabel: shadow.querySelector(".date-from-label"), dateToLabel: shadow.querySelector(".date-to-label"),
            gseList: shadow.querySelector(".gse-list"), ignoreCase: shadow.querySelector(".ignore-case"), ignoreAccents: shadow.querySelector(".ignore-accents"),
            copyButton: shadow.querySelector(".copy"), exportToggle: shadow.querySelector(".export-toggle"), exportWrap: shadow.querySelector(".export-wrap"), exportMenu: shadow.querySelector(".export-menu"),
            previousResult: shadow.querySelector(".previous-result"), nextResult: shadow.querySelector(".next-result"), focusResult: shadow.querySelector(".focus-result"), resultCounter: shadow.querySelector(".result-counter"),
            selectPageCheckbox: shadow.querySelector(".select-page-checkbox"), selectAllResultsButton: shadow.querySelector(".select-all-results"),
            selectionCount: shadow.querySelector(".selection-count"), clearSelectionButton: shadow.querySelector(".clear-selection"), openSelectedButton: shadow.querySelector(".open-selected"),
            statsViewToggle: shadow.querySelector(".stats-view-toggle"),
            progress: shadow.querySelector(".progress"), progressText: shadow.querySelector(".progress-text"), progressBar: shadow.querySelector(".fill"),
            status: shadow.querySelector(".status"), results: shadow.querySelector(".results"),
            pagination: shadow.querySelector(".pagination"), prevPage: shadow.querySelector(".prev-page"), nextPage: shadow.querySelector(".next-page"), pageInfo: shadow.querySelector(".page-info"),
            focusOverlay: shadow.querySelector(".focus-overlay"), focusBody: shadow.querySelector(".focus-body"),
            exportButton: shadow.querySelector(".export-toggle")
        };

        buildGseList();
        statsPreferences = loadPreferences();
        renderPreferencesBar();
        wirePreferencesEvents(shadow);

        ui.launcher.addEventListener("click", () => host.classList.add("open"));
        ui.close.addEventListener("click", () => { host.classList.remove("open"); ui.restorePill.hidden = true; });
        // Tema claro/escuro persiste por navegador (cada pessoa que usa o
        // script guarda a própria preferência) — não depende de servidor.
        try { if (localStorage.getItem(THEME_STORAGE_KEY) === "dark") host.classList.add("dark"); } catch (_) {}
        ui.themeToggle.addEventListener("click", () => {
            host.classList.toggle("dark");
            try { localStorage.setItem(THEME_STORAGE_KEY, host.classList.contains("dark") ? "dark" : "light"); } catch (_) {}
        });
        // Minimizar só esconde o diálogo (nada de estado é destruído — igual
        // ao "Fechar"), mas deixa uma pílula visível avisando que o acervo
        // continua carregado, pra não parecer que sumiu tudo.
        ui.minimize.addEventListener("click", () => {
            host.classList.remove("open");
            ui.restorePill.innerHTML = archive.length
                ? `🔎 Pesquisa no acervo <small>— ${archive.length.toLocaleString("pt-BR")} carregadas, clique pra reabrir</small>`
                : "🔎 Pesquisa no acervo <small>— clique pra reabrir</small>";
            ui.restorePill.hidden = false;
        });
        ui.restorePill.addEventListener("click", () => {
            host.classList.add("open");
            ui.restorePill.hidden = true;
        });
        // Clique fora do diálogo (na área escura) propositalmente NÃO fecha nem
        // minimiza — só o botão de fechar (ou, quando existir, o de minimizar)
        // deve controlar isso, pra evitar fechar sem querer.

        ui.loadButton.addEventListener("click", loadArchive);
        ui.cancelLoad.addEventListener("click", () => { archiveCancelled = true; });
        ui.search.addEventListener("click", performSearch);
        ui.query.addEventListener("keydown", event => { if (event.key === "Enter" && !ui.search.disabled) performSearch(); });
        // Alternância de modo (termos/semelhança) agora é 100% CSS — os dois
        // radios ocultos (#tjspModeTerms/#tjspModeSimilar/#tjspModeStats)
        // controlam visibilidade e o estado marcado dos botões via seletor de
        // irmão (~), sem JS.
        ui.semanticSearch.addEventListener("click", performSemanticSearch);
        ui.statsSearch.addEventListener("click", performStatsSearch);
        try { const savedView = localStorage.getItem(STATS_VIEW_STORAGE_KEY); if (savedView === "grid" || savedView === "table") statsViewMode = savedView; } catch (_) {}
        ui.statsViewToggle.querySelectorAll(".view-btn").forEach(btn => {
            if (btn.dataset.view === statsViewMode) btn.classList.add("active"); else btn.classList.remove("active");
            btn.addEventListener("click", () => {
                statsViewMode = btn.dataset.view;
                ui.statsViewToggle.querySelectorAll(".view-btn").forEach(b => b.classList.toggle("active", b === btn));
                try { localStorage.setItem(STATS_VIEW_STORAGE_KEY, statsViewMode); } catch (_) {}
                renderResults();
            });
        });

        // Na aba Estatística, GSE e Período saem do painel "Filtros
        // avançados" e ficam fixos na tela (você não roda essa busca sem
        // eles); Especialista/Solicitante/VIP viram tags — o campo continua
        // sendo o MESMO elemento (autocomplete e tudo), só muda de lugar na
        // tela. Ao sair da aba, tudo volta pro lugar de origem.
        const statsRelocatable = ["filterGseSection", "filterDateSection", "filterSpecialistControl", "filterRequestedForControl"];
        const statsOriginalSpot = new Map();
        function moveIntoStats() {
            const target = { filterGseSection: "statsGseSlot", filterDateSection: "statsDateSlot", filterSpecialistControl: "statsEspSlot", filterRequestedForControl: "statsSolSlot" };
            statsRelocatable.forEach(id => {
                const el = shadow.getElementById(id);
                if (!el || statsOriginalSpot.has(id)) return;
                statsOriginalSpot.set(id, { parent: el.parentNode, next: el.nextSibling });
                shadow.getElementById(target[id]).appendChild(el);
            });
            // "Buscar em"/"Qualquer palavra"/"Filtros avançados" só fazem
            // sentido pra busca por texto — na Estatística ficam escondidos
            // (os filtros dela já estão todos fixos ou em tag na própria aba).
            ui.fieldChecks.hidden = true;
            ui.mode.hidden = true;
            ui.advancedToggleWrap.hidden = true;
            ui.loadButton.hidden = true;
            // "Mais ocorrências"/"Mais semelhantes" só existem quando há
            // texto pesquisado — a Estatística não busca texto nenhum.
            shadow.querySelectorAll(".sort-text-only").forEach(option => { option.hidden = true; });
            if (sortMode === "relevance" || sortMode === "similarity") { sortMode = "recent"; ui.sortSelect.value = "recent"; }
        }
        function restoreFromStats() {
            statsRelocatable.forEach(id => {
                const spot = statsOriginalSpot.get(id);
                const el = shadow.getElementById(id);
                if (!spot || !el) return;
                if (spot.next && spot.next.parentNode === spot.parent) spot.parent.insertBefore(el, spot.next);
                else spot.parent.appendChild(el);
                statsOriginalSpot.delete(id);
            });
            ui.fieldChecks.hidden = false;
            ui.mode.hidden = false;
            ui.advancedToggleWrap.hidden = false;
            ui.loadButton.hidden = false;
            shadow.querySelectorAll(".sort-text-only").forEach(option => { option.hidden = false; });
        }
        shadow.querySelector("#tjspModeStats").addEventListener("change", () => { if (shadow.querySelector("#tjspModeStats").checked) moveIntoStats(); });
        shadow.querySelector("#tjspModeTerms").addEventListener("change", () => { if (shadow.querySelector("#tjspModeTerms").checked) restoreFromStats(); });
        shadow.querySelector("#tjspModeSimilar").addEventListener("change", () => { if (shadow.querySelector("#tjspModeSimilar").checked) restoreFromStats(); });
        shadow.querySelectorAll(".stats-tag").forEach(tag => {
            tag.addEventListener("click", () => {
                const slot = shadow.getElementById(tag.dataset.slot);
                const willShow = slot.hidden;
                slot.hidden = !willShow;
                tag.classList.toggle("active", willShow);
            });
        });
        ui.semanticQuery.addEventListener("keydown", event => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !ui.semanticSearch.disabled) { event.preventDefault(); performSemanticSearch(); }
        });
        ui.sortSelect.addEventListener("change", () => { sortMode = ui.sortSelect.value; applySort(); currentPage = 1; renderResults(); });
        ui.prevPage.addEventListener("click", () => { currentPage--; renderResults(); });
        ui.nextPage.addEventListener("click", () => { currentPage++; renderResults(); });

        ui.previousResult.addEventListener("click", () => moveResult(-1));
        ui.nextResult.addEventListener("click", () => moveResult(1));
        ui.focusResult.addEventListener("click", () => openFocus(activeIndex));
        ui.selectPageCheckbox.addEventListener("change", () => {
            const start = (currentPage - 1) * PAGE_RESULTS;
            results.slice(start, start + PAGE_RESULTS).forEach(item => setSelection(item.id, ui.selectPageCheckbox.checked));
            renderResults();
        });
        ui.selectAllResultsButton.addEventListener("click", selectAllResults);
        ui.clearSelectionButton.addEventListener("click", clearSelection);
        ui.openSelectedButton.addEventListener("click", openSelectedInTabs);

        shadow.querySelectorAll(".operator").forEach(button => button.addEventListener("click", () => insertOperator(button.dataset.insert || "")));
        shadow.querySelector(".select-all").addEventListener("click", () => ui.gseList.querySelectorAll("input").forEach(input => input.checked = true));
        shadow.querySelector(".clear-gse").addEventListener("click", () => ui.gseList.querySelectorAll("input").forEach(input => input.checked = false));
        ui.dateMode.addEventListener("change", updateDateControls);

        function closeAdvancedPanel() { ui.advancedPanel.hidden = true; ui.advancedToggle.setAttribute("aria-expanded", "false"); }
        ui.advancedToggle.addEventListener("click", () => {
            const willOpen = ui.advancedPanel.hidden;
            ui.advancedPanel.hidden = !willOpen;
            ui.advancedToggle.setAttribute("aria-expanded", String(willOpen));
        });

        function closeExportMenu() { ui.exportMenu.hidden = true; }
        ui.exportToggle.addEventListener("click", () => { ui.exportMenu.hidden = !ui.exportMenu.hidden; });
        shadow.querySelector(".export-csv").addEventListener("click", () => { exportCsv(); closeExportMenu(); });
        shadow.querySelector(".export-json").addEventListener("click", () => { exportJson(); closeExportMenu(); });
        shadow.querySelector(".export-txt").addEventListener("click", () => { exportTxt(); closeExportMenu(); });
        shadow.querySelector(".export-html").addEventListener("click", () => { exportHtml(); closeExportMenu(); });
        ui.copyButton.addEventListener("click", copySummary);

        shadow.addEventListener("mousedown", event => {
            if (!ui.advancedPanel.hidden && !event.composedPath().includes(ui.advancedToggleWrap)) closeAdvancedPanel();
            if (!ui.exportMenu.hidden && !event.composedPath().includes(ui.exportWrap)) closeExportMenu();
            if (!event.composedPath().some(el => el.classList && (el.classList.contains("pref-kebab") || el.classList.contains("pref-kebab-menu")))) {
                shadow.querySelectorAll(".pref-kebab-menu").forEach(menu => { menu.hidden = true; });
            }
            const prefsManager = shadow.querySelector(".prefs-manager");
            if (prefsManager && !prefsManager.hidden && !event.composedPath().some(el => el.classList && (el.classList.contains("prefs-manager") || el.classList.contains("prefs-viewall-link")))) prefsManager.hidden = true;
            const prefsShare = shadow.querySelector(".prefs-share-panel");
            if (prefsShare && !prefsShare.hidden && !event.composedPath().some(el => el.classList && (el.classList.contains("prefs-share-panel") || el.classList.contains("pref-share-btn")))) prefsShare.hidden = true;
        });

        // Listener global de teclado registrado em document (fora da shadow DOM):
        // eventos que cruzam essa fronteira sofrem "retargeting", então usamos
        // event.composedPath()[0] em vez de event.target para saber o alvo real
        // (senão as setas sequestrariam a navegação mesmo digitando num campo).
        document.addEventListener("keydown", event => {
            if (!host.classList.contains("open")) return;
            const realTarget = typeof event.composedPath === "function" ? event.composedPath()[0] : event.target;
            const tag = realTarget && realTarget.tagName ? realTarget.tagName.toLowerCase() : "";
            const typing = ["input", "textarea", "select"].includes(tag);
            if (!typing && event.key === "ArrowDown") { event.preventDefault(); moveResult(1); }
            else if (!typing && event.key === "ArrowUp") { event.preventDefault(); moveResult(-1); }
            else if (!typing && event.key === "Enter" && focusedIndex < 0 && activeIndex >= 0) { event.preventDefault(); openFocus(activeIndex); }
            else if (event.key === "Escape") {
                if (focusedIndex >= 0) closeFocus();
                else if (!ui.exportMenu.hidden) closeExportMenu();
                else if (!ui.advancedPanel.hidden) closeAdvancedPanel();
                else host.classList.remove("open");
            }
        });

        updateDateControls();
        updateNavigator();
        updateSelectionUi();
        installPersonAutocomplete(ui.requestedFor, shadow, false);
        // Sem vínculo de GSE: alguns colegas não estão devidamente
        // vinculados ao grupo no cadastro do SMAX (questão administrativa
        // interna), e ficavam de fora da busca. Como já mostramos a
        // matrícula, dá pra diferenciar homônimos sem precisar do PersonToGroup.
        installPersonAutocomplete(ui.specialist, shadow, false);
    }

    function init() {
        if (document.getElementById("tjsp-archive-full-host")) return;
        buildUi();
        console.log(`[TJSP] Pesquisa Completa no Acervo SMAX ${VERSION} carregada.`);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
    else init();
}());
