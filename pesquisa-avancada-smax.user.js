// ==UserScript==
// @name         Pesquisa Avançada SMAX
// @namespace    http://tampermonkey.net/tjsp-acervo-v4
// @version      4.22.1
// @description  Pesquisa por termos, por semelhança e estatística nas solicitações do SMAX
// @author       Leonardo
// @match        https://suporte.tjsp.jus.br/saw/*
// @require      https://cdn.jsdelivr.net/npm/dexie@4.0.8/dist/dexie.min.js
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
 *
 * ============================================================
 * O QUE MUDA NESTA VERSÃO 2 (IndexedDB + índice invertido)
 * ============================================================
 * O item 3 acima deixa de valer: o acervo agora É salvo em disco, no
 * IndexedDB do próprio navegador (continua local — nada sai da máquina).
 * Isso existe para resolver um problema real do script original: como TUDO
 * ficava em memória, a RAM crescia junto com o volume do acervo, e o texto
 * de Descrição/Solução/Discussão responde por mais de 90% desse peso.
 *
 * A IDEIA CENTRAL — o texto sai da memória, os campos estruturados ficam:
 * Depois de indexado, o array em memória guarda só os campos pequenos
 * (id, data, status, GSE, solicitante, unidade...). O texto pesado vive só
 * no disco e volta sob demanda, apenas para os ~15 cartões visíveis de cada
 * vez. Consequência importante: TODO o resto do script continua funcionando
 * exatamente como antes, sem alteração — filtros avançados, ordenação,
 * paginação, seleção, Busca Estatística, preferências e o layout inteiro só
 * dependem dos campos estruturados, que continuam na memória.
 *
 * AS DUAS FASES (para você não esperar nada a mais do que espera hoje):
 * Fase 1 — carrega do SMAX e mostra o resultado, exatamente como a versão de
 *   produção já faz (mesma bisecção por período, mesmos lotes, mesma carga
 *   por janelas de recência). A busca já funciona aqui, varrendo a memória,
 *   igual hoje. Esta é a única fase que você de fato espera.
 * Fase 2 — em segundo plano, sem travar nada: grava os chamados no
 *   IndexedDB, monta o índice de palavras e as estatísticas do BM25. Quando
 *   termina, libera o texto da memória e a busca passa a usar o índice.
 *   A etiqueta ao lado do resultado diz qual caminho foi usado ("memória" ou
 *   "índice"), para você conferir que os dois dão o mesmo número.
 *
 * BUSCA POR ÍNDICE INVERTIDO: o índice guarda as palavras inteiras de cada
 * chamado. Busca por pedaço de palavra continua funcionando porque a
 * varredura é feita no VOCABULÁRIO (a lista de palavras distintas, que é
 * pequena e não cresce junto com o número de chamados) e não no texto de
 * cada chamado. O resultado do índice é sempre reconferido contra o texto
 * real antes de aparecer, então a gramática completa (aspas, E/OU/NÃO,
 * parênteses, -exclusão) vale igual à de produção.
 *
 * BM25 TAMBÉM NO DISCO: no script original o índice do BM25 era montado em
 * memória a cada carga (um Map de termo → Map de chamado → frequência), e em
 * acervo grande ele pesava mais que o próprio acervo. Aqui a frequência de
 * termos de cada chamado é gravada junto com ele, e a contagem global por
 * termo (df) fica numa tabela à parte — a pontuação é calculada lendo do
 * disco, sem remontar nada na memória.
 *
 * COMO O ACERVO SE MANTÉM ATUALIZADO — dois mecanismos, com papéis distintos:
 *
 * 1. SINCRONIZAÇÃO AUTOMÁTICA (a cada 5 minutos, com a aba do SMAX aberta).
 *    Guiada pela data de ALTERAÇÃO do chamado (LastUpdateTime), busca tudo que
 *    foi gravado desde a última rodada — chamados novos E chamados antigos que
 *    mudaram de status, ganharam resposta ou foram encerrados. Um chamado
 *    alterado é reindexado no lugar, mantendo o mesmo registro.
 *    Chamado encerrado nunca mais recebe gravação, então sai naturalmente do
 *    fluxo e não é reconsultado — sem precisar filtrar por status.
 *
 * 2. RECARGA MANUAL ("Recarregar acervo"). Guiada pela data de CRIAÇÃO, traz os
 *    chamados novos daquele período. Ao terminar, dispara uma rodada da
 *    sincronização acima, para que os alterados também entrem — assim o
 *    resultado é o mesmo com a atualização automática ligada ou desligada.
 *
 * Pedir um período MAIS ANTIGO do que o já indexado faz a carga ser completa
 * naquele intervalo (ver coverageFrom): o que já está gravado é reconhecido e
 * não é baixado de novo, mas nada é omitido.
 */

(function () {
    "use strict";

    const VERSION = "4.22.1";
    const CONCURRENCY = 6; // revertido de 10 — o teste com 10 nunca confirmou ganho e coincidiu com relatos de lentidão
    const PAGE_SIZE = 250; // revertido de 500 — mesmo motivo, volta ao valor já testado/estável
    // Primeira página de cada lote menor e prioritária (canal próprio), pra
    // mostrar algo na tela o quanto antes; o resto do lote usa páginas
    // maiores, reduzindo o total de requisições pro grosso dos dados.
    const FIRST_PAGE_SIZE = 150;
    const BULK_PAGE_SIZE = 500;
    const PAGE_RESULTS = 15;
    const BATCH_SAFETY_LIMIT = 9500; // teto real do SMAX é 10.000; margem de segurança
    const OPEN_SELECTED_CAP = 15; // limite ao abrir várias abas de uma vez (evita bloqueio de pop-up)
    const THEME_STORAGE_KEY = "tjspArchivoTema"; // "dark" ou "light", por navegador/pessoa
    const MODAL_SCALE_STORAGE_KEY = "tjspArchivoModalScale"; // 80-140, por navegador/pessoa — % do tamanho padrão do modal
    const FONT_ZOOM_STORAGE_KEY = "tjspArchivoFontZoom"; // 80-140, por navegador/pessoa — % do zoom do modal inteiro (texto + espaçamento)
    const STATS_VIEW_STORAGE_KEY = "tjspArchivoStatsView"; // "table" ou "grid"
    const CARD_STYLE_STORAGE_KEY = "tjspArchivoCardStyle"; // "3b" (preenchido) ou "3d" (só barra) — Termos/Semelhança
    const LAUNCHER_POS_STORAGE_KEY = "tjspArchivoLauncherPos"; // {left,top} em px — posição arrastada do ícone flutuante
    const PREFS_STORAGE_KEY = "tjspArchivoPreferencias"; // combinações de filtro da Busca Estatística, só neste navegador
    const GSE_DEFAULTS_STORAGE_KEY = "tjspArchivoGsesPadrao"; // [{id,name}] — GSEs marcadas por padrão, configuradas pelo próprio usuário (sem lista de fábrica)
    const CUSTOM_TEAMS_STORAGE_KEY = "tjspArchivoEquipesCustom"; // [{id,name,gses:[{id,name}]}] — equipes criadas pelo próprio usuário, além das nativas

    // Equipes nativas (diferente de GSE, isso TEM lista de fábrica de propósito
    // — o público deste script é um conjunto conhecido e limitado de equipes,
    // não qualquer um da organização, então cadastrar aqui poupa cada membro
    // novo de montar a lista de GSE da própria equipe do zero. Cada equipe é
    // só um ATALHO de seleção — marcar uma equipe não declara "essa é a minha
    // equipe", é "quero ver as GSEs desta equipe" (dá pra marcar várias, com
    // ou sem ser a sua). Algumas GSEs pertencem a mais de uma equipe (ex.:
    // HOMOLOGACAO/PLANTAO/CONFIG são compartilhadas entre SGS 2.2.1 e 2.2.2)
    // — isso é esperado, não duplicata.
    const NATIVE_TEAMS = [
        { id: "sgs-2-2-1", name: "SGS 2.2.1", gses: [
            { id: "51642955", name: "GSE - SGS - EPROC 1G - ACIV" },
            { id: "51642956", name: "GSE - SGS - EPROC 1G - ACRIM" },
            { id: "51642761", name: "GSE - SGS - EPROC 1G - AEXCRIM" },
            { id: "51643315", name: "GSE - SGS - EPROC 1G - CERT" },
            { id: "67109543", name: "GSE - SGS - EPROC 1G - HOMOLOGACAO" },
            { id: "51642954", name: "GSE - SGS - EPROC - PLANTAO" },
            { id: "61730998", name: "GSE - SGS - EPROC - CONFIG" }
        ] },
        { id: "sgs-2-2-2", name: "SGS 2.2.2", gses: [
            { id: "51642957", name: "GSE - SGS - EPROC 1G - JUIESP" },
            { id: "66561429", name: "GSE - SGS - EPROC - MIGRACAO 1G" },
            { id: "51644373", name: "GSE - SGS - EPROC 1G - CEJUSCS" },
            { id: "51642766", name: "GSE - SGS - EPROC 1G - CLMAND" },
            { id: "51643432", name: "GSE - SGS - EPROC 1G - OFJUST" },
            { id: "51642772", name: "GSE - SGS - EPROC 1G - DISTR" },
            { id: "51643315", name: "GSE - SGS - EPROC 1G - CERT" },
            { id: "67109543", name: "GSE - SGS - EPROC 1G - HOMOLOGACAO" },
            { id: "51642954", name: "GSE - SGS - EPROC - PLANTAO" },
            { id: "61730998", name: "GSE - SGS - EPROC - CONFIG" }
        ] }
    ];
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
        "Id", "Description", "Solution", "CreateTime", "DataEnvioAceite_c",
        "RequestedForPerson", "RequestedForPerson.Name", "RequestedForPerson.IsVIP",
        "AssignedToPerson", "AssignedToPerson.Name",
        "AssignedToGroup", "AssignedToGroup.Name",
        "RegisteredForLocation", "RegisteredForLocation.DisplayName",
        "StatusSCCDSMAX_c", "Status",
        // Confirmados por captura ao vivo do filtro nativo do SMAX:
        // IsGlobal_c = o checkbox "É global"; LastUpdateTime = carimbo de
        // qualquer gravação no chamado, base da sincronização automática.
        "IsGlobal_c", "LastUpdateTime"
    ].join(",");

    // Sem lista nativa de GSEs — o script é usado por equipes diferentes,
    // cada uma com suas próprias GSEs de interesse, então não faz sentido
    // vir com um conjunto fixo de fábrica. Cada usuário configura as suas
    // (obrigatório na primeira vez, ver openSettingsModal/GSE_DEFAULTS_
    // STORAGE_KEY) e isso fica salvo só neste navegador.
    let GSE_NAME = {}; // ganha entradas conforme as GSEs padrão são carregadas e/ou buscadas via autocomplete

    // Tradução código bruto → rótulo em português — capturada ao vivo do
    // <select> nativo por trás do campo Status/Status Operacional na tela de
    // chamado do SMAX (não é heurística, é o texto real que aparece lá).
    const STATUS_LABELS = {
        RequestStatusReady: "Pronto",
        RequestStatusInProgress: "Em andamento",
        RequestStatusPending: "Usuário final pendente",
        RequestStatusSuspended: "Suspenso",
        RequestStatusComplete: "Concluído",
        RequestStatusPendingParent: "Elemento primário pendente",
        RequestStatusRejected: "Rejeitadas",
        RequestStatusPendingVendor: "Fornecedor pendente",
        RequestStatusPendingExternalServiceDesk: "Central de serviços externa pendente",
        RequestStatusPendingSpecialOperation: "Operação especial pendente",
        DecursoDePrazo_c: "Decurso de prazo"
    };

    const STATUS_OPERACIONAL_LABELS = {
        Agendado_c: "Agendado",
        Aguardando3Nivel_c: "Aguardando 3º Nível",
        AguardandoAceiteDefinitivo_c: "Aguardando Aceite Definitivo",
        AguardandoAceiteCancelamento_c: "Aguardando Aceite do Cancelamento",
        AguardandoAtendimento_c: "Aguardando Atendimento",
        AguardandoCliente_c: "Aguardando Cliente",
        AguardandoClienteContato1_c: "Aguardando Cliente - Contato1",
        AguardandoClienteContato1DiaZero_c: "Aguardando Cliente - Contato1(Dia Zero)",
        AguardandoClienteContato2_c: "Aguardando Cliente – Contato2",
        AguardandoClienteContato3_c: "Aguardando Cliente – Contato3",
        AguardandoColeta_c: "Aguardando Coleta",
        AguardandoContinuidadeAtendimento_c: "Aguardando Continuidade de Atendimento",
        AguardandoDocumentacao_c: "Aguardando documentação",
        AguardandoEquipeConfiguracao_c: "Aguardando Equipe de Configuração",
        AguardandoGarantiaFabricante_c: "Aguardando Garantia do Fabricante",
        AguardandoInformacaoProcedimento_c: "Aguardando Informação de Procedimento",
        AguardandoInstalacaoProducao_c: "Aguardando Instalação em Produção",
        AguardandoOutraEquipe_c: "Aguardando outra Equipe",
        AguardandoPeca_c: "Aguardando Peça",
        AguardandoRetornoCliente_c: "Aguardando Retorno do Cliente",
        AguardandoRetornoFornecedor_c: "Aguardando Retorno do Fornecedor",
        AguardandoSTI_c: "Aguardando STI",
        ATUALIZADOUSUARIOTEAMS_c: "Atualizado pelo Usuário do Teams",
        DevolucaoFaltaSubsidio_c: "Devolução falta de subsídio",
        DevolucaoAtendimentoIT2B_c: "Devolução para Atendimento IT2B",
        AnaliseATIPG_c: "Em análise ATIPG",
        EmAnaliseEmpresa_c: "Em Análise Empresa",
        AnaliseSAAB_c: "Em análise SAAB",
        EmAnaliseTJSP_c: "Em Análise TJSP",
        EmAtendimento_c: "Em Atendimento",
        EmRota_c: "Em Rota",
        EnviaGSE_c: "Envia para GSE",
        EnviadoReparoExterno_c: "Enviado para Reparo Externo",
        EquipamentoEnviadoReparo_c: "Equipamento Enviado para Reparo",
        ErroIntegracao_c: "Erro na Integração",
        Fechado_c: "Fechado",
        DecursoPrazo_c: "Fechado por tempo decorrido",
        DecursoDePrazo_c: "Fechado por tempo decorrido",
        GarantiaRecusada_c: "Garantia Recusada",
        LaudoDescarte_c: "Laudo para Descarte",
        MetricaAguardando_c: "Métricas - Aguardando",
        MetricaCancelada_c: "Métricas - Cancelada",
        MetricaAnalisa_c: "Métricas - Em Análise",
        MetricaEmExecucao_c: "Métricas - Em Execução",
        MetricaHomologada_c: "Métricas - Homologada",
        MetricaRejeitada_c: "Métricas - Rejeitada",
        PecaDevolvida_c: "Peça Devolvida",
        PecaEnviada_c: "Peça Enviada",
        PedidoPeca_c: "Pedido de Peça",
        PedidoPecaComBackup_c: "Pedido de peça com backup",
        PedidoRecategorizacao_c: "Pedido de Recategorização",
        RatAnexada_c: "Rat Anexada",
        ReparoLaboratorio_c: "Reparo em Laboratório",
        RetornoAnalise_c: "Retorno Análise",
        RetornoAtividade_c: "Retorno de Atividade",
        TarefaConcluidaLogista_c: "Tarefa Concluída Logística",
        TarefaConcluidaParcialLogistica_c: "Tarefa Concluída Parcial Logística"
    };

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
    let focusedItemId = null; // id do chamado aberto no modo expandido — usado pra reencontrar a posição dele em `results` sem precisar re-renderizar o conteúdo
    let userEngagedWithResults = false; // true com foco expandido aberto ou "Mostrar mais" clicado — pausa re-render disruptivo de cargas em segundo plano
    let searchMode = "terms";
    let archiveIncludesDiscussion = false;
    let lastSearchIncludedDiscussion = false;
    let loadedSignature = null;
    let liveSearchDuringLoad = null;
    let loadingProgressInfo = null; // { windowIndex, windowCount, label } enquanto carrega por período, null quando não está carregando
    let statsViewMode = "table"; // "table" (padrão) ou "grid" — só usado na Busca Estatística
    let cardStyleMode = "3b"; // "3b" (padrão, preenchido) ou "3d" (só barra no topo) — Termos/Semelhança
    let statsPreferences = []; // preferências de filtro salvas (Busca Estatística), carregadas do localStorage no init
    let userDefaultGses = []; // [{id,name}] — GSEs padrão configuradas pelo usuário, carregadas do localStorage no init
    let settingsMandatory = false; // true durante a configuração obrigatória de primeira vez — não deixa fechar sem salvar
    let customTeams = []; // equipes criadas pelo usuário, carregadas do localStorage no init — somadas às NATIVE_TEAMS
    let gseListComboInstance = null; // adapta a lista de checkboxes principal pro mesmo helper renderTeamTogglers usa nos combos de verdade
    let teamNewGseCombo = null; // combobox do formulário "+ Nova equipe", instalado uma vez sob demanda
    let resultsBucket = "text"; // "text" (Termos + Semelhança, compartilham resultado) ou "stats" — cada lado guarda o próprio resultado/paginação
    let textResultsStash = null;
    let statsResultsStash = null;
    let semanticIndex = null;
    let semanticScores = new Map();
    let semanticMaxScore = 1;
    const selectedIds = new Set();
    // Registro completo de cada item marcado, por ID — sobrevive à troca do
    // `archive` (pesquisa diferente) porque exportRows() precisa dos dados
    // reais pra montar o relatório, não só do ID. Texto pode estar offloaded
    // (ver __textOffloaded) mesmo aqui dentro: exportRowsReady() já sabe
    // reidratar do disco por ID, independente de o GSE ainda estar carregado.
    const selectedRecords = new Map();

    // ============================================================
    // ARMAZENAMENTO EM DISCO (IndexedDB via Dexie) — o coração da v3
    // ============================================================
    // A diferença para a v2 está em COMO a relação termo→chamado é guardada.
    // Lá cada palavra de cada chamado virava uma entrada num índice multiEntry
    // do navegador; aqui cada termo tem UMA linha própria, com a lista de
    // chamados num bloco binário. O detalhamento do esquema vem abaixo.
    // syncState guarda, por GSE, até que data já indexamos.
    const INDEX_DB_NAME = "TjspAcervoV4";
    const INDEX_WRITE_CHUNK = 400; // chamados por gravação — equilibra velocidade e não travar a aba
    const db = new Dexie(INDEX_DB_NAME);
    db.version(1).stores({
        // ---- POR QUE ESTE DESENHO -----------------------------------------
        // A v2 usava índices "multiEntry" do próprio IndexedDB (`*words`,
        // `*stems`). Funcionava, mas a medição em 26.171 chamados reais mostrou
        // o preço: 88 MB de conteúdo ocupavam 197 MB em disco. A diferença é
        // que o multiEntry cria UMA ENTRADA POR PAR (palavra, chamado) — foram
        // ~3,5 milhões de entradas, cada uma repetindo o termo e a chave
        // primária (que ainda por cima era string, tipo "83445604").
        //
        // Aqui a lista de chamados de cada termo é guardada por nós mesmos, em
        // UMA linha por termo, como um bloco binário (Uint32Array) de IDs
        // numéricos. Os mesmos 3,5 milhões de relações passam a custar ~4 bytes
        // cada, em vez de ~30. É a mesma informação, sem a sobrecarga.
        //
        //   meta .......... campos estruturados + docId (número curto que
        //                   substitui a string do chamado nos índices) +
        //                   docLen (tamanho em termos, usado pelo BM25).
        //                   É a única tabela lida ao reabrir o navegador.
        //   texts ......... o texto. Lido só pros cartões visíveis, pra
        //                   confirmar uma busca e pra exportar.
        //   wordPostings .. índice da busca por termos. {term, ids:Uint32Array}
        //   stemPostings .. índice do BM25. {term, ids:Uint32Array,
        //                   tfs:Uint16Array} — a frequência vive AQUI, junto da
        //                   lista, e não mais espalhada numa linha por chamado.
        //                   Assim o BM25 lê ~10 linhas por consulta em vez de
        //                   milhares.
        //   settings ...... contador de docId e estatísticas globais do corpus.
        //
        // Repare que não existe mais tabela "tickets": tudo que ela guardava
        // (words, stems, terms) virou as duas tabelas de postings, sem repetir
        // nenhum termo por chamado.
        meta: "id, groupId, created, docId",
        texts: "id",
        wordPostings: "term",
        stemPostings: "term",
        settings: "key",
        syncState: "groupId"
    });
    // v2 é só aditiva: nenhuma tabela da v1 muda de forma, só aparece
    // pendingIndex — marca leve de "meta/texts já gravados, postings ainda
    // não confirmados". Dexie preserva os dados existentes automaticamente;
    // não precisa de upgrade() porque não há dado antigo pra transformar.
    db.version(2).stores({
        meta: "id, groupId, created, docId",
        texts: "id",
        wordPostings: "term",
        stemPostings: "term",
        settings: "key",
        syncState: "groupId",
        // Enquanto uma linha existe aqui, o chamado (já com docId conhecido em
        // meta) ainda não teve seus postings confirmados no flush em lote —
        // se a aba fechar nesse meio-tempo, runIndexingPhase reconhece isso na
        // próxima carga e conserta via applyPostingOps, em vez de pular o
        // chamado como "já pronto" pra sempre (era um bug real e silencioso).
        pendingIndex: "id"
    });
    // Apaga só o banco da PRIMEIRA tentativa (tudo numa tabela só), que não é
    // usado por nenhuma versão viva. O banco do v2 é preservado de propósito:
    // as duas versões precisam coexistir para que a comparação de espaço, RAM e
    // tempo seja feita sobre o mesmo acervo. Quando o v3 estiver aprovado, aí
    // sim vale desinstalar o v2 e liberar o espaço dele.
    try { Dexie.delete("TjspAcervoV2Completo"); } catch (_) {}

    let indexReady = false;        // true quando a Fase 2 terminou e a busca pode usar o disco
    let indexing = false;          // Fase 2 em andamento
    let indexProgress = null;      // {done,total} enquanto indexa, pra barra de progresso
    let textInMemory = true;       // false depois que o texto foi liberado da memória
    let vocabularyCache = null;    // lista de palavras distintas (pré-aquecida no fim da Fase 2)
    let corpusStats = null;        // {N, avgDocLen} do BM25, lido do disco
    let forceFullReindex = false;
    // Início do período pedido na carga em andamento — vira o coverageFrom da
    // GSE quando a indexação termina. É o que permite saber, depois, se um
    // período pedido já está coberto pelo disco ou se falta baixar o mais antigo.
    let requestedCoverageFrom = null;
    // true enquanto a tela mostra uma consulta ao vivo (sem GSE). Nesse estado o
    // que está em memória não corresponde ao acervo indexado de nenhuma GSE,
    // então a sincronização automática fica parada — ela atualizaria o disco e
    // tentaria refletir na tela um conjunto que não é o dela.
    let liveQueryMode = false;  // ligado pelo botão "Reindexar do zero": ignora o que está salvo nesta carga

    // Cache dos textos trazidos de volta do disco. Limitado de propósito: o
    // objetivo da v2 é justamente não deixar o texto todo voltar pra memória
    // sem controle. Guarda o suficiente pra navegar algumas páginas de
    // resultado sem reler, e descarta o mais antigo além disso.
    const HYDRATION_CACHE_LIMIT = 600;
    const hydrationCache = new Map(); // id -> {description,solution,discussion,discussionEntries}

    function rememberHydrated(id, text) {
        if (hydrationCache.has(id)) hydrationCache.delete(id);
        hydrationCache.set(id, text);
        while (hydrationCache.size > HYDRATION_CACHE_LIMIT) {
            hydrationCache.delete(hydrationCache.keys().next().value);
        }
    }

    // Um item "precisa de texto" quando o texto já saiu da memória e ainda não
    // voltou do disco. Enquanto a Fase 2 não terminou, textInMemory é true e
    // isso nunca dispara — ou seja, na Fase 1 o comportamento é o de hoje.
    function needsHydration(item) {
        return !!item && item.__textOffloaded === true;
    }

    // Traz o texto de volta pros itens indicados e devolve true se algo mudou
    // (ou seja, se vale a pena repintar a tela).
    async function hydrateItems(items) {
        const pending = items.filter(needsHydration);
        if (!pending.length) return false;
        const fromCache = [];
        const toRead = [];
        pending.forEach(item => {
            const cached = hydrationCache.get(item.id);
            if (cached) fromCache.push([item, cached]);
            else toRead.push(item);
        });
        fromCache.forEach(([item, text]) => applyHydration(item, text));
        if (toRead.length) {
            const rows = await db.texts.bulkGet(toRead.map(item => item.id));
            rows.forEach((row, index) => {
                const item = toRead[index];
                const text = row
                    ? { description: row.description || "", solution: row.solution || "", discussion: row.discussion || "", discussionEntries: row.discussionEntries || [] }
                    : { description: "", solution: "", discussion: "", discussionEntries: [] };
                rememberHydrated(item.id, text);
                applyHydration(item, text);
            });
        }
        return true;
    }

    // Itens que estão com o texto carregado agora, na ordem em que foram
    // carregados. Sem esta lista o texto voltaria pra memória cartão a cartão e
    // nunca sairia — navegando bastante, o acervo inteiro acabaria de volta na
    // RAM e o ganho da v2 se perderia justamente com o uso prolongado, que é
    // quando ele mais importa. Passando do teto, os mais antigos voltam a ficar
    // só no disco (de onde saem de novo em milissegundos, se preciso).
    const HYDRATED_LIVE_LIMIT = 120; // ~8 páginas de resultado
    const hydratedLive = [];

    function trackHydrated(item) {
        const existing = hydratedLive.indexOf(item);
        if (existing >= 0) hydratedLive.splice(existing, 1);
        hydratedLive.push(item);
        while (hydratedLive.length > HYDRATED_LIVE_LIMIT) {
            const stale = hydratedLive.shift();
            // Nunca solta o que está aberto no modo expandido nem o que está na
            // página que o usuário está vendo agora.
            if (stale && stale.id !== focusedItemId) offloadText(stale);
        }
    }

    function applyHydration(item, text) {
        item.description = text.description;
        item.solution = text.solution;
        item.discussion = text.discussion;
        item.discussionEntries = text.discussionEntries;
        item.__textOffloaded = false;
        if (!textInMemory) trackHydrated(item);
    }

    // Devolve o item ao estado "sem texto". Chamado depois que a Fase 2
    // gravou tudo no disco — é este passo que efetivamente devolve a RAM.
    function offloadText(item) {
        item.description = "";
        item.solution = "";
        item.discussion = "";
        item.discussionEntries = [];
        item.__textOffloaded = true;
    }

    // ============================================================
    // ÍNDICE INVERTIDO — construção
    // ============================================================
    // Palavras inteiras, sem acento e minúsculas, com 2+ caracteres. Busca por
    // pedaço de palavra NÃO é resolvida aqui (isso custaria gravar cada pedaço
    // de cada palavra, o que já testamos e inviabilizou a gravação); ela é
    // resolvida na hora da busca, varrendo o vocabulário.
    function indexWordsOf(text) {
        const seen = new Set();
        String(text || "")
            .toLocaleLowerCase("pt-BR")
            .normalize("NFD").replace(/[̀-ͯ]/g, "")
            .split(/[^a-z0-9]+/)
            .forEach(word => { if (word.length >= 2) seen.add(word); });
        return Array.from(seen);
    }

    // Frequência por termo do BM25 — reaproveita exatamente o mesmo
    // tokenizeForIndex do script original (stopwords + radical), pra que a
    // pontuação seja idêntica à da versão de produção.
    function buildTermFrequencies(text) {
        const terms = tokenizeForIndex(text);
        const tf = {};
        terms.forEach(term => { tf[term] = (tf[term] || 0) + 1; });
        return { tf, docLen: terms.length };
    }

    // Reparte um chamado nas tabelas. O docId (número curto e sequencial) é o
    // que vai para as listas de postings no lugar da string do chamado — é daí
    // que vem a maior parte da economia.
    function indexRowsFor(item, docId) {
        const fullText = `${item.description || ""} ${item.solution || ""} ${item.discussion || ""}`;
        const { tf, docLen } = buildTermFrequencies(fullText);
        return {
            meta: {
                id: item.id,
                docId,
                docLen,
                groupId: item.groupId,
                groupName: item.groupName,
                created: item.created,
                solutionDate: item.solutionDate,
                requestedFor: item.requestedFor,
                requestedForId: item.requestedForId,
                isVip: item.isVip,
                isGlobal: item.isGlobal,
                lastUpdate: item.lastUpdate,
                assignedSpecialist: item.assignedSpecialist,
                assignedSpecialistId: item.assignedSpecialistId,
                unidade: item.unidade,
                status: item.status,
                statusOperacional: item.statusOperacional
            },
            text: {
                id: item.id,
                description: item.description || "",
                solution: item.solution || "",
                discussion: item.discussion || "",
                discussionEntries: item.discussionEntries || []
            },
            words: indexWordsOf(fullText),
            stemFrequencies: tf,
            docLen
        };
    }

    // Metade barata de indexRowsFor — meta+texts sem tokenizar. Usada por
    // runIndexingPhase, que manda a tokenização pro Worker (ou faz ela
    // síncrona só se o Worker não estiver disponível) em vez de chamar
    // buildTermFrequencies aqui. docLen entra depois, quando o resultado da
    // tokenização (worker ou síncrono) estiver pronto.
    function buildMetaTextRow(item, docId) {
        return {
            meta: {
                id: item.id,
                docId,
                docLen: 0,
                groupId: item.groupId,
                groupName: item.groupName,
                created: item.created,
                solutionDate: item.solutionDate,
                requestedFor: item.requestedFor,
                requestedForId: item.requestedForId,
                isVip: item.isVip,
                isGlobal: item.isGlobal,
                lastUpdate: item.lastUpdate,
                assignedSpecialist: item.assignedSpecialist,
                assignedSpecialistId: item.assignedSpecialistId,
                unidade: item.unidade,
                status: item.status,
                statusOperacional: item.statusOperacional
            },
            text: {
                id: item.id,
                description: item.description || "",
                solution: item.solution || "",
                discussion: item.discussion || "",
                discussionEntries: item.discussionEntries || []
            }
        };
    }

    // ---- Postings: juntar o que já está gravado com o que acabou de chegar --
    // Uma linha por termo. Ler, concatenar e regravar em bloco é o mesmo padrão
    // que a v2 já usava pra contagem de documentos por termo (df), então não é
    // um caminho novo — só passou a valer também pra própria lista de chamados.
    function concatUint32(existing, extra) {
        const before = existing ? existing.length : 0;
        const out = new Uint32Array(before + extra.length);
        if (before) out.set(existing, 0);
        out.set(extra, before);
        return out;
    }

    function concatUint16(existing, extra) {
        const before = existing ? existing.length : 0;
        const out = new Uint16Array(before + extra.length);
        if (before) out.set(existing, 0);
        out.set(extra, before);
        return out;
    }

    async function flushWordPostings(pending) {
        const terms = Array.from(pending.keys());
        for (let start = 0; start < terms.length; start += 1500) {
            if (archiveCancelled) return false;
            const slice = terms.slice(start, start + 1500);
            const existing = await db.wordPostings.bulkGet(slice);
            await db.wordPostings.bulkPut(slice.map((term, index) => ({
                term,
                ids: concatUint32(existing[index] && existing[index].ids, Uint32Array.from(pending.get(term)))
            })));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        return true;
    }

    async function flushStemPostings(pending) {
        const terms = Array.from(pending.keys());
        for (let start = 0; start < terms.length; start += 1500) {
            if (archiveCancelled) return false;
            const slice = terms.slice(start, start + 1500);
            const existing = await db.stemPostings.bulkGet(slice);
            await db.stemPostings.bulkPut(slice.map((term, index) => {
                const entry = pending.get(term);
                return {
                    term,
                    ids: concatUint32(existing[index] && existing[index].ids, Uint32Array.from(entry.ids)),
                    // Uint16 comporta até 65.535 repetições do mesmo termo num
                    // único chamado — folga enorme pro que existe na prática.
                    tfs: concatUint16(existing[index] && existing[index].tfs, Uint16Array.from(entry.tfs))
                };
            }));
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        return true;
    }

    // ============================================================
    // WORKER DE TOKENIZAÇÃO — tira o trabalho pesado (regex + radical) da
    // thread principal. Só isso: recebe texto, devolve termo->docId(+tf).
    // Não toca em IndexedDB nem em regra de negócio nenhuma — quem grava
    // continua sendo runIndexingPhase, exatamente como já gravava antes.
    //
    // Um único Worker dedicado (não um pool): a ordem de chegada do docId
    // importa (wordPostings/stemPostings dependem de listas sempre
    // crescentes por docId — é isso que permite a busca binária em
    // applyPostingOps), e um só Worker responde na mesma ordem em que os
    // lotes chegam.
    //
    // indexWorker: undefined = ainda não tentou criar; null = indisponível
    // (CSP bloqueou, navegador sem suporte, ou o Worker caiu de vez) — nesses
    // casos tokenizeChunk cai sozinho pro caminho síncrono de sempre, sem
    // quebrar a indexação.
    let indexWorker;
    const indexWorkerWaiters = new Map();
    let indexWorkerSeq = 0;

    function ensureIndexWorker() {
        if (indexWorker !== undefined) return indexWorker;
        try {
            const stopwords = JSON.stringify(Array.from(STOPWORDS_PT));
            const source = `
                const STOPWORDS = new Set(${stopwords});
                const MIN_STEM_LEN = ${SEMANTIC_MIN_TOKEN_LEN};
                function normalizeAccents(value) {
                    return String(value || "").toLocaleLowerCase("pt-BR").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
                }
                function indexWordsOf(text) {
                    const seen = new Set();
                    normalizeAccents(text).split(/[^a-z0-9]+/).forEach(word => { if (word.length >= 2) seen.add(word); });
                    return Array.from(seen);
                }
                function stemLight(token) {
                    if (token.length > 4 && token.endsWith("mente")) return token.slice(0, -5);
                    if (token.length > 4 && (token.endsWith("ões") || token.endsWith("ãos"))) return token.slice(0, -3) + "ao";
                    if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
                    return token;
                }
                function tokenizeForIndex(text) {
                    const matches = normalizeAccents(text).match(/[a-z0-9]+/g) || [];
                    const out = [];
                    for (const token of matches) {
                        if (token.length < MIN_STEM_LEN || STOPWORDS.has(token)) continue;
                        out.push(stemLight(token));
                    }
                    return out;
                }
                self.onmessage = event => {
                    const { requestId, docs } = event.data;
                    try {
                        const rows = [];
                        const words = {};
                        const stems = {};
                        for (const doc of docs) {
                            indexWordsOf(doc.text).forEach(word => {
                                let bucket = words[word];
                                if (!bucket) { bucket = []; words[word] = bucket; }
                                bucket.push(doc.docId);
                            });
                            const terms = tokenizeForIndex(doc.text);
                            const tf = {};
                            terms.forEach(term => { tf[term] = (tf[term] || 0) + 1; });
                            Object.keys(tf).forEach(term => {
                                let bucket = stems[term];
                                if (!bucket) { bucket = { ids: [], tfs: [] }; stems[term] = bucket; }
                                bucket.ids.push(doc.docId);
                                bucket.tfs.push(Math.min(65535, tf[term]));
                            });
                            rows.push({ docId: doc.docId, docLen: terms.length });
                        }
                        self.postMessage({ requestId, rows, words, stems });
                    } catch (error) {
                        self.postMessage({ requestId, error: (error && (error.stack || error.message)) || String(error) });
                    }
                };
            `;
            const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            const worker = new Worker(url);
            URL.revokeObjectURL(url);
            worker.onmessage = event => {
                const waiter = indexWorkerWaiters.get(event.data.requestId);
                if (!waiter) return;
                indexWorkerWaiters.delete(event.data.requestId);
                if (event.data.error) waiter.reject(new Error(event.data.error));
                else waiter.resolve(event.data);
            };
            worker.onerror = () => {
                const error = new Error("O Worker de indexação parou de responder — a indexação continua, só que na thread principal.");
                indexWorkerWaiters.forEach(waiter => waiter.reject(error));
                indexWorkerWaiters.clear();
                try { worker.terminate(); } catch (_) {}
                indexWorker = null; // desiste de vez; próximos lotes usam o caminho síncrono
            };
            indexWorker = worker;
        } catch (_) {
            indexWorker = null; // CSP ou ambiente sem suporte a blob Worker — segue sem ele
        }
        return indexWorker;
    }

    function tokenizeChunkInWorker(docs) {
        const worker = ensureIndexWorker();
        if (!worker) return null;
        const requestId = ++indexWorkerSeq;
        return new Promise((resolve, reject) => {
            indexWorkerWaiters.set(requestId, { resolve, reject });
            try { worker.postMessage({ requestId, docs }); }
            catch (error) { indexWorkerWaiters.delete(requestId); reject(error); }
        });
    }

    // Tokeniza um lote de {docId, text}. Tenta o Worker primeiro; se ele não
    // existir OU essa tentativa específica falhar, cai pro caminho síncrono
    // de sempre (mesmo resultado, só que na thread principal) — a indexação
    // nunca trava por causa do Worker.
    async function tokenizeChunk(docs) {
        if (ensureIndexWorker()) {
            try { return await tokenizeChunkInWorker(docs); }
            catch (_) { /* esse lote cai pro síncrono abaixo; o Worker pode continuar servindo os próximos */ }
        }
        const rows = [];
        const words = {};
        const stems = {};
        docs.forEach(doc => {
            indexWordsOf(doc.text).forEach(word => {
                let bucket = words[word];
                if (!bucket) { bucket = []; words[word] = bucket; }
                bucket.push(doc.docId);
            });
            const { tf, docLen } = buildTermFrequencies(doc.text);
            Object.keys(tf).forEach(term => {
                let bucket = stems[term];
                if (!bucket) { bucket = { ids: [], tfs: [] }; stems[term] = bucket; }
                bucket.ids.push(doc.docId);
                bucket.tfs.push(Math.min(65535, tf[term]));
            });
            rows.push({ docId: doc.docId, docLen });
        });
        return { rows, words, stems };
    }

    // Agrupa o resultado (do Worker ou síncrono) nos acumuladores
    // pendingWords/pendingStems, no mesmo formato que flushWordPostings/
    // flushStemPostings já esperavam antes do Worker existir — o merge em
    // disco em si não muda em nada.
    function mergeChunkResult(chunkResult, pendingWords, pendingStems) {
        Object.keys(chunkResult.words).forEach(word => {
            let bucket = pendingWords.get(word);
            if (!bucket) { bucket = []; pendingWords.set(word, bucket); }
            bucket.push(...chunkResult.words[word]);
        });
        Object.keys(chunkResult.stems).forEach(term => {
            let bucket = pendingStems.get(term);
            if (!bucket) { bucket = { ids: [], tfs: [] }; pendingStems.set(term, bucket); }
            bucket.ids.push(...chunkResult.stems[term].ids);
            bucket.tfs.push(...chunkResult.stems[term].tfs);
        });
    }

    // Conserta, via applyPostingOps (idempotente — seguro repetir mesmo que
    // parte já tivesse sido gravada), os chamados que ficaram com meta/docId
    // gravados mas os postings incompletos (aba fechou entre o bulkPut de
    // meta e o próximo flush em lote). NÃO usa flushWordPostings/
    // flushStemPostings aqui de propósito — o concat cego deles pressupõe
    // que o docId ainda não está na lista, o que não dá pra garantir neste
    // caso.
    async function repairPendingPostings(items) {
        const wordOps = new Map();
        const stemOps = new Map();
        const docLenById = new Map();
        for (let start = 0; start < items.length; start += INDEX_WRITE_CHUNK) {
            if (archiveCancelled) return;
            const slice = items.slice(start, start + INDEX_WRITE_CHUNK);
            const docs = slice.map(item => ({ docId: item.docId, text: `${item.description || ""} ${item.solution || ""} ${item.discussion || ""}` }));
            const chunkResult = await tokenizeChunk(docs);
            chunkResult.rows.forEach(row => docLenById.set(row.docId, row.docLen));
            Object.keys(chunkResult.words).forEach(word => {
                chunkResult.words[word].forEach(docId => pushOp(wordOps, word, { docId, tf: 1 }));
            });
            Object.keys(chunkResult.stems).forEach(term => {
                const entry = chunkResult.stems[term];
                entry.ids.forEach((docId, index) => pushOp(stemOps, term, { docId, tf: entry.tfs[index] }));
            });
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (wordOps.size) await applyPostingOps(db.wordPostings, wordOps, false);
        if (stemOps.size) await applyPostingOps(db.stemPostings, stemOps, true);

        // docLen pode ter ficado 0 em meta (se a queda foi antes do primeiro
        // flush) — corrige e soma no corpus só a diferença real.
        const existingMeta = await db.meta.bulkGet(items.map(item => item.id));
        const rows = [];
        let docLenDelta = 0;
        existingMeta.forEach((before, index) => {
            if (!before) return;
            const docLen = docLenById.get(before.docId);
            if (docLen == null) return;
            docLenDelta += docLen - (before.docLen || 0);
            rows.push(Object.assign({}, before, { docLen }));
            items[index].docLen = docLen;
        });
        if (rows.length) await db.meta.bulkPut(rows);
        if (docLenDelta) {
            const corpus = await db.settings.get("corpus");
            if (corpus) await db.settings.put({ key: "corpus", N: corpus.N, totalLen: Math.max(0, (corpus.totalLen || 0) + docLenDelta) });
        }

        await db.pendingIndex.bulkDelete(items.map(item => item.id));
    }

    // FASE 2 — grava o acervo no disco e monta os índices, em pedaços, com uma
    // pausa entre eles pra aba continuar respondendo (a Fase 1 já mostrou o
    // resultado e o usuário provavelmente já está lendo/buscando).
    async function runIndexingPhase(allItems, onProgress) {
        // Descarta o que JÁ está indexado antes de qualquer coisa. Isso importa
        // com várias GSEs selecionadas: a janela incremental usa a data mais
        // antiga entre elas, então uma GSE mais atualizada acaba rebaixando
        // chamados que já tínhamos. Sem esta checagem, cada um deles ganharia um
        // segundo docId — as listas de postings cresceriam à toa e o "df"
        // (número de chamados por termo) ficaria inflado, distorcendo o BM25.
        //
        // "Já indexado" agora tem duas variantes: se além de estar em meta o
        // chamado ainda tem uma marca em pendingIndex, o flush de postings
        // dele nunca chegou a terminar (aba fechou no meio) — não é pra pular
        // (bug antigo: ficava faltando pra sempre) nem pra tratar como novo
        // (duplicaria docId). Vai pro reparo, que reaproveita o docId
        // existente. Consulta pendingIndex só quando ela não está vazia —
        // no caminho comum (nada pendente) o custo extra é zero.
        const pendingTotal = await db.pendingIndex.count();
        const items = [];
        const toRepair = [];
        for (let start = 0; start < allItems.length; start += 1000) {
            const slice = allItems.slice(start, start + 1000);
            const ids = slice.map(item => item.id);
            const existing = await db.meta.bulkGet(ids);
            const pendingRows = pendingTotal ? await db.pendingIndex.bulkGet(ids) : null;
            slice.forEach((item, index) => {
                if (existing[index]) {
                    // Já indexado: aproveita o número que ele já tem, pra busca
                    // pelo índice continuar encontrando este chamado.
                    item.docId = existing[index].docId;
                    item.docLen = existing[index].docLen;
                    if (pendingRows && pendingRows[index]) toRepair.push(item);
                } else {
                    items.push(item);
                }
            });
        }
        if (toRepair.length) await repairPendingPostings(toRepair);
        if (!items.length) return true;

        // Continua de onde a última indexação parou, pra sincronização
        // incremental nunca reaproveitar um docId já usado.
        const counterRow = await db.settings.get("docIdCounter");
        let nextDocId = (counterRow && Number(counterRow.value)) || 0;

        // Acumula as relações termo→chamado na memória e descarrega em blocos.
        // Guardar tudo pra gravar só no fim seria mais rápido, mas seguraria na
        // memória exatamente o que a v3 quer tirar de lá.
        let pendingWords = new Map();  // termo -> [docId,...]
        let pendingStems = new Map();  // termo -> {ids:[], tfs:[]}
        let pendingWindowIds = [];     // ids ainda sem postings confirmados nesta janela de flush
        let pendingCount = 0;
        const POSTINGS_FLUSH_EVERY = 4000; // chamados acumulados antes de descarregar
        let totalLenDelta = 0;

        for (let start = 0; start < items.length; start += INDEX_WRITE_CHUNK) {
            if (archiveCancelled) return false;
            const slice = items.slice(start, start + INDEX_WRITE_CHUNK);
            const docIds = slice.map(() => nextDocId++);
            slice.forEach((item, index) => { item.docId = docIds[index]; }); // o item em memória passa a saber seu número
            const rows = slice.map((item, index) => buildMetaTextRow(item, docIds[index]));
            const docs = slice.map((item, index) => ({
                docId: docIds[index],
                text: `${item.description || ""} ${item.solution || ""} ${item.discussion || ""}`
            }));
            const chunkResult = await tokenizeChunk(docs);
            const docLenById = new Map(chunkResult.rows.map(row => [row.docId, row.docLen]));
            rows.forEach((row, index) => {
                const docLen = docLenById.get(docIds[index]) || 0;
                row.meta.docLen = docLen;
                slice[index].docLen = docLen;
                totalLenDelta += docLen;
            });
            mergeChunkResult(chunkResult, pendingWords, pendingStems);

            await Promise.all([
                db.meta.bulkPut(rows.map(row => row.meta)),
                db.texts.bulkPut(rows.map(row => row.text)),
                // Marca leve: meta/texts já gravados, postings ainda não —
                // some depois do flush confirmar as duas tabelas de postings.
                db.pendingIndex.bulkPut(slice.map((item, index) => ({ id: item.id, docId: docIds[index] })))
            ]);
            pendingWindowIds.push(...slice.map(item => item.id));

            pendingCount += slice.length;
            if (pendingCount >= POSTINGS_FLUSH_EVERY) {
                if (!await flushWordPostings(pendingWords)) return false;
                if (!await flushStemPostings(pendingStems)) return false;
                await db.pendingIndex.bulkDelete(pendingWindowIds);
                pendingWords = new Map();
                pendingStems = new Map();
                pendingWindowIds = [];
                pendingCount = 0;
            }

            if (onProgress) onProgress(Math.min(start + INDEX_WRITE_CHUNK, items.length), items.length);
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (pendingWords.size && !await flushWordPostings(pendingWords)) return false;
        if (pendingStems.size && !await flushStemPostings(pendingStems)) return false;
        if (pendingWindowIds.length) await db.pendingIndex.bulkDelete(pendingWindowIds);

        // Estatísticas globais do corpus (N e tamanho médio) — o BM25 precisa
        // das duas. O "df" de cada termo não é mais guardado: ele é simplesmente
        // o tamanho da lista de postings daquele termo, que já está gravada.
        const previous = await db.settings.get("corpus");
        const N = ((previous && previous.N) || 0) + items.length;
        const totalLen = ((previous && previous.totalLen) || 0) + totalLenDelta;
        await db.settings.bulkPut([
            { key: "corpus", N, totalLen },
            { key: "docIdCounter", value: nextDocId }
        ]);
        return true;
    }

    // Pré-aquecimento: a PRIMEIRA leitura do vocabulário e do universo de ids
    // tem custo real (segundos, em acervo grande). Fazer isso aqui, no fim da
    // Fase 2 e ainda em segundo plano, evita que esse custo caia justamente na
    // primeira busca do usuário — que foi o que aconteceu no protótipo.
    async function warmUpIndex() {
        vocabularyCache = null;
        corpusStats = null;
        await Promise.all([getVocabulary(), getCorpusStats()]);
    }

    // Na v2 isto era `orderBy("words").uniqueKeys()`, que precisava percorrer o
    // índice multiEntry inteiro — era o passo caro do pré-aquecimento. Agora o
    // vocabulário é simplesmente a lista de chaves de uma tabela pequena.
    async function getVocabulary() {
        if (!vocabularyCache) vocabularyCache = await db.wordPostings.toCollection().primaryKeys();
        return vocabularyCache;
    }

    async function getCorpusStats() {
        if (!corpusStats) {
            const row = await db.settings.get("corpus");
            const N = (row && row.N) || 0;
            corpusStats = { N, avgDocLen: N ? ((row && row.totalLen) || 0) / N : 1 };
        }
        return corpusStats;
    }

    // ============================================================
    // ÍNDICE INVERTIDO — consulta
    // ============================================================
    function setIntersect(a, b) {
        const out = new Set();
        const [small, big] = a.size <= b.size ? [a, b] : [b, a];
        small.forEach(value => { if (big.has(value)) out.add(value); });
        return out;
    }

    function setUnion(a, b) {
        const out = new Set(a);
        b.forEach(value => out.add(value));
        return out;
    }

    // Resolve um termo em "chamados candidatos". Termo entre aspas com várias
    // palavras vira interseção das palavras (a ordem/adjacência é conferida
    // depois, contra o texto real). Termo solto vira busca por pedaço de
    // palavra: varre o VOCABULÁRIO atrás de palavras que contenham o pedaço e
    // une os chamados delas.
    async function candidatesForTerm(rawValue, isPhrase) {
        const normalized = String(rawValue || "")
            .toLocaleLowerCase("pt-BR")
            .normalize("NFD").replace(/[̀-ͯ]/g, "");
        const pieces = normalized.split(/[^a-z0-9]+/).filter(Boolean);
        if (!pieces.length) return null; // termo sem letra/número: deixa a conferência final decidir

        if (isPhrase && pieces.length > 1) {
            let candidates = null;
            for (const word of pieces) {
                const ids = new Set(await postingsFor(word));
                candidates = candidates ? setIntersect(candidates, ids) : ids;
                if (!candidates.size) break;
            }
            return candidates || new Set();
        }

        const fragment = pieces[0];
        const vocabulary = await getVocabulary();
        // Palavra inteira é o caso comum e mais barato: uma leitura direta.
        // Só varre o vocabulário quando o termo não é uma palavra completa
        // conhecida (ou seja, quando é mesmo um pedaço de palavra).
        const matching = vocabulary.includes(fragment) ? [fragment] : vocabulary.filter(word => word.includes(fragment));
        if (!matching.length) return new Set();
        const out = new Set();
        for (let start = 0; start < matching.length; start += 500) {
            const rows = await db.wordPostings.bulkGet(matching.slice(start, start + 500));
            rows.forEach(row => { if (row && row.ids) row.ids.forEach(id => out.add(id)); });
        }
        return out;
    }

    // Lista de chamados (docIds) que contêm exatamente esta palavra.
    async function postingsFor(word) {
        const row = await db.wordPostings.get(word);
        return row && row.ids ? row.ids : new Uint32Array(0);
    }

    // Percorre a árvore da consulta devolvendo o conjunto de candidatos. Um
    // ramo que devolve null significa "não sei restringir isso pelo índice" —
    // nesse caso o pai assume o universo inteiro e deixa a conferência final
    // contra o texto real fazer o trabalho. É o que garante que o índice nunca
    // descarte um resultado que a produção acharia.
    // Recupera do disco só os campos estruturados (sem o texto) dos chamados
    // das GSEs pedidas, dentro do período pedido. É isto que permite reabrir o
    // navegador e já ter o acervo pronto pra buscar sem baixar tudo de novo —
    // e é barato porque o texto, que é o que pesa, fica no disco.
    // Lê SÓ a tabela "meta", e ainda por cima pelo índice de groupId — nunca
    // toca no texto nem nas listas de palavras. É o que faz reabrir o navegador
    // ser rápido: o volume lido aqui é uma fração mínima do acervo salvo.
    async function loadArchiveMetadataFromDisk(groupIds, from, to) {
        const rows = await db.meta.where("groupId").anyOf(groupIds.map(String)).toArray();
        const restored = [];
        rows.forEach(row => {
            const created = Number(row.created);
            if (Number.isFinite(created)) {
                if (from != null && created < from) return;
                if (to != null && created > to) return;
            }
            restored.push({
                id: row.id,
                docId: row.docId,   // número usado pelas listas de postings
                docLen: row.docLen, // tamanho em termos, usado pelo BM25
                groupId: row.groupId,
                groupName: GSE_NAME[row.groupId] || row.groupName || row.groupId || "Não informado",
                created: row.created,
                solutionDate: row.solutionDate,
                requestedFor: row.requestedFor,
                requestedForId: row.requestedForId,
                isVip: row.isVip,
                isGlobal: row.isGlobal,
                lastUpdate: row.lastUpdate,
                assignedSpecialist: row.assignedSpecialist,
                assignedSpecialistId: row.assignedSpecialistId,
                unidade: row.unidade,
                status: row.status,
                statusOperacional: row.statusOperacional,
                description: "", solution: "", discussion: "", discussionEntries: [],
                __textOffloaded: true
            });
        });
        return restored;
    }

    async function candidatesForNode(node) {
        if (!node) return null;
        if (node.type === "TERM") return candidatesForTerm(node.value, node.phrase);
        if (node.type === "NOT") return null; // negação não restringe: qualquer chamado pode satisfazer
        const [left, right] = await Promise.all([candidatesForNode(node.left), candidatesForNode(node.right)]);
        if (node.type === "AND") {
            if (left && right) return setIntersect(left, right);
            return left || right; // um lado desconhecido: o outro já restringe
        }
        if (!left || !right) return null; // OU com um lado desconhecido cobre tudo
        return setUnion(left, right);
    }

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

    // Retry/timeout/backoff. Só tenta de novo em falha de rede, timeout NOSSO
    // (não confundir com cancelamento do chamador) e HTTP 408/429/5xx — nunca
    // em 400, que é justamente o erro "excedeu 10 mil" (isExceededError):
    // repetir a mesma consulta inválida não ajuda, só atrasa a resposta certa
    // (dividir por período), que já é tratada por quem chama.
    function isRetryableStatus(status) {
        return status === 408 || status === 429 || (status >= 500 && status < 600);
    }

    function delay(ms, externalSignal) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            if (!externalSignal) return;
            const onAbort = () => { clearTimeout(timer); reject(externalSignal.reason || new Error("cancelado")); };
            if (externalSignal.aborted) return onAbort();
            externalSignal.addEventListener("abort", onAbort, { once: true });
        });
    }

    async function fetchJson(url, options, retryOpts) {
        const opts = options || {};
        const retry = Object.assign({ retries: 3, baseDelayMs: 400, maxDelayMs: 5000, timeoutMs: 20000 }, retryOpts || {});
        const externalSignal = opts.signal || null;

        for (let attempt = 0; ; attempt++) {
            const ownController = new AbortController();
            let timedOut = false;
            const timer = setTimeout(() => { timedOut = true; ownController.abort(); }, retry.timeoutMs);
            const onExternalAbort = () => ownController.abort(externalSignal.reason);
            if (externalSignal) {
                if (externalSignal.aborted) onExternalAbort();
                else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
            }

            try {
                const response = await fetch(url, Object.assign(
                    { method: "GET", credentials: "same-origin", headers: requestHeaders() },
                    opts, { signal: ownController.signal }
                ));
                const raw = await response.text();
                let data;
                try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
                if (!response.ok) {
                    const error = new Error((data.message) || (data.developer_message) || data.raw || `HTTP ${response.status}`);
                    error.messageKey = data.message_key || "";
                    error.status = response.status;
                    if (attempt < retry.retries && isRetryableStatus(response.status)) {
                        await delay(Math.min(retry.maxDelayMs, retry.baseDelayMs * Math.pow(2, attempt)) * (0.5 + Math.random() / 2), externalSignal);
                        continue;
                    }
                    throw error;
                }
                return data;
            } catch (error) {
                if (externalSignal && externalSignal.aborted) throw error; // cancelamento do chamador: nunca retenta, propaga como está
                const isTimeout = timedOut || error.name === "AbortError";
                const isNetworkError = error instanceof TypeError;
                if ((isTimeout || isNetworkError) && attempt < retry.retries) {
                    await delay(Math.min(retry.maxDelayMs, retry.baseDelayMs * Math.pow(2, attempt)) * (0.5 + Math.random() / 2), externalSignal);
                    continue;
                }
                // Timeout nosso esgotado: não pode sair como AbortError puro — vários
                // chamadores (autocomplete) tratam AbortError como "cancelado, fica
                // quieto", e um timeout de verdade precisa aparecer pro usuário.
                if (isTimeout) {
                    const timeoutError = new Error("A requisição demorou demais e foi cancelada.");
                    timeoutError.name = "FetchTimeoutError";
                    throw timeoutError;
                }
                throw error;
            } finally {
                clearTimeout(timer);
                if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
            }
        }
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
    async function concurrentMap(items, worker, onProgress, concurrencyLimit) {
        const output = new Array(items.length);
        let cursor = 0, done = 0;
        const limit = Math.max(1, concurrencyLimit || CONCURRENCY);
        async function runner() {
            while (!archiveCancelled) {
                const index = cursor++;
                if (index >= items.length) return;
                try { output[index] = await worker(items[index]); }
                catch (error) { output[index] = { error, item: items[index] }; }
                if (onProgress) onProgress(++done, items.length);
            }
        }
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
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
    // preenchida só com pessoas escolhidas nas sugestões do combobox (que
    // resolve o ID exato — o filtro nativo exige ID, não nome parcial).
    // Cada campo aceita várias pessoas (OU entre elas, mesma lógica das GSEs/
    // Status/Unidade); os dois campos entre si continuam em E. Vazio =
    // comportamento de sempre (carrega tudo das GSEs selecionadas).
    function personIdClause(fieldName, ids) {
        if (!ids.length) return "";
        return ids.length === 1 ? `${fieldName} = '${ids[0]}'` : `(${ids.map(id => `${fieldName} = '${id}'`).join(" or ")})`;
    }
    function personConstraintClause() {
        const clauses = [];
        const specialistIds = ui.specialistCombo ? ui.specialistCombo.getSelected().map(o => o.value) : [];
        const requesterIds = ui.requestedForCombo ? ui.requestedForCombo.getSelected().map(o => o.value) : [];
        const specialistClause = personIdClause("AssignedToPerson", specialistIds);
        const requesterClause = personIdClause("RequestedForPerson", requesterIds);
        if (specialistClause) clauses.push(specialistClause);
        if (requesterClause) clauses.push(requesterClause);
        return clauses.length ? clauses.join(" and ") : "";
    }

    // Período de carga — agora entra na própria consulta ao SMAX (não é mais
    // só um filtro aplicado depois de tudo já baixado), pra reduzir de
    // verdade o volume. "Últimos N dias" é o padrão (180): cobre a maioria
    // dos casos e já reduz bastante; "Qualquer data" volta ao histórico
    // completo, como sempre foi.
    function computeLoadDateRange() {
        const mode = ui.dateMode.value;
        if (mode === "any") return { from: null, to: null };
        if (mode === "days") {
            const days = Number(ui.dateDays.value);
            return days > 0 ? { from: Date.now() - days * 86400000, to: null } : { from: null, to: null };
        }
        const from = parseDateInput(ui.dateFrom.value, false);
        const to = parseDateInput(ui.dateTo.value, true);
        if (mode === "on") return { from, to: parseDateInput(ui.dateFrom.value, true) };
        if (mode === "after") return { from, to: null };
        if (mode === "before") return { from: null, to };
        if (mode === "between") return { from, to };
        return { from: null, to: null };
    }

    function loadDateRangeClause() {
        const { from, to } = computeLoadDateRange();
        if (from == null && to == null) return "";
        if (from != null && to != null) return `CreateTime >= ${from} and CreateTime <= ${to}`;
        return from != null ? `CreateTime >= ${from}` : `CreateTime <= ${to}`;
    }

    const ARCHIVE_EARLIEST_TIME = new Date(2010, 0, 1).getTime();
    const ARCHIVE_LATEST_TIME = Date.now() + 86400000;
    const MIN_SPLIT_RANGE_MS = 6 * 60 * 60 * 1000; // não divide abaixo de 6h — evita recursão sem fim

    // Cláusula combinando TODAS as GSEs marcadas (não uma por vez) + pessoa
    // (se houver) + uma janela de tempo específica — é a base do carregamento
    // por período (mais recente primeiro), em vez de por GSE.
    function windowClause(groupIds, from, to) {
        // Sem GSE, a consulta se apoia inteiramente no filtro de pessoa, que
        // entra logo abaixo em personConstraintClause().
        const parts = [`(CreateTime >= ${from} and CreateTime < ${to})`];
        if (groupIds.length) {
            const gseClause = groupIds.length === 1 ? `AssignedToGroup = '${groupIds[0]}'` : `(${groupIds.map(id => `AssignedToGroup = '${id}'`).join(" or ")})`;
            parts.unshift(`(${gseClause})`);
        }
        const extra = personConstraintClause();
        if (extra) parts.push(`(${extra})`);
        return parts.join(" and ");
    }

    // Bisecção recursiva (mesma ideia de antes, agora pra todas as GSEs
    // combinadas em vez de uma só de cada vez): tenta contar a janela
    // inteira; se o SMAX recusar por excesso, parte ao meio e repete até
    // cada pedaço confirmar uma contagem real abaixo do teto.
    async function splitWindowUntilSafe(groupIds, label, from, to, depth) {
        const clause = windowClause(groupIds, from, to);
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
            const left = await splitWindowUntilSafe(groupIds, label, from, mid, (depth || 0) + 1);
            const right = await splitWindowUntilSafe(groupIds, label, mid, to, (depth || 0) + 1);
            return left.concat(right);
        }
    }

    // Fronteiras (em dias, relativas a "agora") pra fatiar a carga do mais
    // recente pro mais antigo — cada fatia é medida e paginada por completo
    // (e já aparece na tela) antes de passar pra próxima, mais antiga. O
    // "resto" do período configurado (o que sobrar depois da última
    // fronteira) vira a fatia final, tipicamente a maior/mais lenta.
    const RECENCY_WINDOWS_DAYS = [7, 30, 90, 180];

    function buildRecencyWindows(from, to) {
        const now = Math.min(to, Date.now() + 86400000);
        const edges = [now, ...RECENCY_WINDOWS_DAYS.map(days => now - days * 86400000).filter(edge => edge > from), from];
        const windows = [];
        for (let i = 0; i < edges.length - 1; i++) {
            if (edges[i] > edges[i + 1]) windows.push({ from: edges[i + 1], to: edges[i] });
        }
        return windows;
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

    // Versão "rica" (mantém formatação e imagens) pra exibição expandida e
    // pro botão de copiar — diferente de htmlToText, que achata tudo em
    // texto puro pro card compacto e a busca. src de imagem vem relativo
    // ("../rest/.../frs/file-list/...") porque foi pensado pra tela original
    // do chamado; resolvido aqui pra absoluto, senão quebra fora daquele
    // contexto (inclusive ao colar em outro lugar). Remove script/style/
    // atributos "on*" por segurança — o conteúdo vem do próprio SMAX, mas
    // não custa nada higienizar antes de injetar como HTML.
    function sanitizeRichHtml(rawHtml) {
        const box = document.createElement("div");
        box.innerHTML = String(rawHtml || "");
        box.querySelectorAll("script,style,iframe,object,embed").forEach(node => node.remove());
        box.querySelectorAll("*").forEach(node => {
            Array.from(node.attributes).forEach(attr => { if (/^on/i.test(attr.name)) node.removeAttribute(attr.name); });
            if (node.tagName === "A") { node.setAttribute("target", "_blank"); node.setAttribute("rel", "noopener noreferrer"); }
        });
        box.querySelectorAll("img[src]").forEach(img => {
            try { img.src = new URL(img.getAttribute("src"), location.href).href; } catch (_) {}
            img.loading = "lazy";
            img.style.maxWidth = "100%";
        });
        return box.innerHTML.trim();
    }

    // Comments vem como JSON-string (mesmo formato já confirmado na Consulta
    // Rápida): {"Comment":[{Submitter:"Person/{id}",IsSystem,CommentBody,
    // CreateTime,PrivacyType:"INTERNAL"|"AGENTPUBLIC",...}]}. Mensagens de
    // sistema são descartadas. Cada comentário vira uma entrada separada
    // (autor + interno/público + texto/html) em vez de um texto corrido só —
    // autor é resolvido por heurística contra quem já conhecemos (solicitante
    ///especialista do próprio chamado), sem precisar de uma consulta extra
    // por pessoa; se não bater com nenhum dos dois, cai num rótulo genérico.
    // Extrai/filtra/ordena os comentários humanos (sem os de sistema) —
    // função única reaproveitada tanto pelo carregamento em massa (só texto,
    // leve) quanto pela busca avulsa de HTML rico (fetchRichFields), pra
    // garantir que os índices de um baterem com os do outro.
    function humanComments(rawComments) {
        let parsed;
        try { parsed = JSON.parse(rawComments || "{}"); } catch (_) { return []; }
        const comments = Array.isArray(parsed.Comment) ? parsed.Comment : [];
        return comments.filter(comment => !comment.IsSystem && comment.CommentBody).sort((a, b) => (a.CreateTime || 0) - (b.CreateTime || 0));
    }

    function parseDiscussion(rawComments, requesterId, specialistId, requesterName, specialistName) {
        const entries = humanComments(rawComments)
            .map(comment => {
                const submitterId = String(comment.Submitter || "").split("/").pop();
                let author = "Outro colaborador";
                if (submitterId && requesterId && submitterId === requesterId) author = requesterName || "Solicitante";
                else if (submitterId && specialistId && submitterId === specialistId) author = specialistName || "Especialista";
                // submitterId fica guardado mesmo quando o autor já é conhecido
                // (Solicitante/Especialista) — é o que permite, só na hora de
                // exportar, resolver nome/GSE de quem não é nenhum dos dois
                // (colega que comentou o chamado sem ser dono nem responsável).
                return { author, isInternal: comment.PrivacyType === "INTERNAL", time: comment.CreateTime || 0, text: htmlToText(comment.CommentBody), submitterId: submitterId || "" };
            })
            .filter(entry => entry.text);
        return { text: entries.map(entry => entry.text).join("\n\n"), entries };
    }

    // Busca sob demanda (com cache) o HTML original — Descrição/Solução/cada
    // comentário — só quando o usuário realmente pede (abre o modo expandido
    // ou clica em copiar). Evita guardar o HTML de TODO o acervo carregado
    // em memória o tempo inteiro por uma ação que é usada pontualmente.
    const richFieldsCache = new Map(); // id -> resultado (ou a Promise em andamento, pra não duplicar consulta em cliques rápidos)

    async function fetchRichFields(id) {
        if (richFieldsCache.has(id)) return richFieldsCache.get(id);
        const promise = (async () => {
            // Mesmo endpoint já confirmado ao vivo na Consulta Rápida (script
            // de automação) — o genérico /ems/Request/{id}?layout=Description,
            // Solution,Comments às vezes voltava esses campos vazios mesmo
            // quando o chamado tinha conteúdo (confirmado: abrindo o mesmo
            // chamado direto no SMAX ele aparecia normal). Esse aqui é o que
            // a própria tela de chamado usa por baixo dos panos.
            const params = new URLSearchParams({ layout: "FORM_LAYOUT.withoutResolution,FORM_LAYOUT.onlyResolution" });
            const payload = await fetchJson(`${getRestBase()}/entity-page/initializationDataByLayout/Request/${encodeURIComponent(id)}?${params}`);
            // A resposta traz os campos em EntityData.properties, não em
            // properties. Ler o nível errado devolvia undefined, que virava
            // string vazia — e o efeito era silencioso: o botão Copiar dizia
            // "Copiado!" com o HTML vazio, a colagem normal não inseria nada
            // (nem no SMAX nem no Word), as imagens não vinham, e o modo
            // expandido disfarçava tudo caindo no texto puro. Só "colar sem
            // formatação" funcionava, porque o texto puro vem de outra fonte.
            // Aceita as três formas conhecidas em vez de fixar numa só.
            const p = (payload.EntityData && payload.EntityData.properties)
                || payload.properties
                || (Array.isArray(payload.entities) && payload.entities[0] && payload.entities[0].properties)
                || {};
            const commentsHtml = humanComments(p.Comments).map(comment => sanitizeRichHtml(comment.CommentBody));
            return { descriptionHtml: sanitizeRichHtml(p.Description), solutionHtml: sanitizeRichHtml(p.Solution), commentsHtml };
        })();
        richFieldsCache.set(id, promise);
        try {
            const result = await promise;
            richFieldsCache.set(id, result);
            return result;
        } catch (error) {
            richFieldsCache.delete(id);
            throw error;
        }
    }

    function normalizeRecord(entity) {
        const p = entity.properties || {};
        const related = entity.related_properties || {};
        const groupId = String((p.AssignedToGroup && (p.AssignedToGroup.Id || p.AssignedToGroup)) || "");
        const requester = related.RequestedForPerson || {};
        const specialist = related.AssignedToPerson || {};
        const location = related.RegisteredForLocation || {};
        const requestedForId = String(requester.Id || (p.RequestedForPerson && (p.RequestedForPerson.Id || p.RequestedForPerson)) || "");
        const assignedSpecialistId = String(specialist.Id || (p.AssignedToPerson && (p.AssignedToPerson.Id || p.AssignedToPerson)) || "");
        const requestedForName = requester.Name || String(p["RequestedForPerson.Name"] || "Não informado");
        const assignedSpecialistName = specialist.Name || String(p["AssignedToPerson.Name"] || "Não informado");
        const discussion = parseDiscussion(p.Comments, requestedForId, assignedSpecialistId, requestedForName, assignedSpecialistName);
        return {
            id: String(p.Id || ""),
            description: htmlToText(p.Description),
            solution: htmlToText(p.Solution),
            discussion: discussion.text,
            discussionEntries: discussion.entries,
            requestedFor: requestedForName,
            requestedForId,
            isVip: requester.IsVIP === true || requester.IsVIP === "true",
            isGlobal: p.IsGlobal_c === true || p.IsGlobal_c === "true",
            lastUpdate: Number(p.LastUpdateTime) || 0,
            assignedSpecialist: assignedSpecialistName,
            assignedSpecialistId,
            unidade: location.DisplayName || String(p["RegisteredForLocation.DisplayName"] || "") || "Não informada",
            // Status e Status Operacional são campos DIFERENTES e vêm
            // preenchidos ao mesmo tempo (confirmado ao vivo: "Em andamento"
            // e "Aguardando Atendimento" simultâneos) — cada um com seu
            // próprio filtro, sem sobrepor um no outro.
            status: String(p.Status || "").trim(),
            statusOperacional: String(p.StatusSCCDSMAX_c || "").trim(),
            groupId,
            // Na busca sem GSE os chamados vem de GSEs que nao estao na lista
            // local (GSE_NAME so conhece as que voce carregou/selecionou), e a
            // coluna mostrava o ID cru. A propria resposta traz o nome, entao
            // ele entra como segunda opcao antes de cair no ID.
            groupName: GSE_NAME[groupId]
                || (related.AssignedToGroup && related.AssignedToGroup.Name)
                || (p.AssignedToGroup && p.AssignedToGroup.Name)
                || p["AssignedToGroup.Name"]
                || groupId
                || "Não informado",
            created: p.CreateTime || "",
            // Confirmado ao vivo: DataEnvioAceite_c é gravado no mesmo
            // instante do comentário de resolução — na prática é a data da
            // solução (quando o especialista conclui e envia pra aceite).
            solutionDate: p.DataEnvioAceite_c || ""
        };
    }

    async function fetchBatchPage(filterClause, skip, layout, size) {
        const params = new URLSearchParams({ filter: filterClause, layout, order: "CreateTime desc", size: String(size || PAGE_SIZE), skip: String(skip) });
        const payload = await fetchJson(`${getRestBase()}/ems/Request?${params}`);
        const entities = Array.isArray(payload.entities) ? payload.entities : [];
        return entities.map(normalizeRecord).filter(item => item.id);
    }

    async function loadArchive() {
        if (archiveLoading) return;
        archiveLoading = true;
        archiveCancelled = false;
        archive = [];
        // Guarda o índice de cada chamado já inserido, pra nunca duplicar
        // (e, se uma cópia chegou com Descrição/Solução vazias por alguma
        // falha pontual da API naquela chamada, ficar com a cópia que tem
        // conteúdo em vez da vazia — evita cartão compacto e modo expandido
        // mostrando o mesmo chamado com dados diferentes).
        const archiveIdIndex = new Map();
        semanticIndex = null;
        // A seleção (checkbox de exportação) NÃO zera aqui de propósito: é pra
        // sobreviver a uma pesquisa diferente (outras GSEs/filtros), que troca
        // este `archive` inteiro por outro. Só assim dá pra marcar itens em
        // buscas diversas e exportar tudo junto no fim — era essa a intenção
        // original ("seleção persistente entre páginas e buscas"), mas só
        // funcionava enquanto o `archive` continuasse sendo o mesmo, porque
        // zerava aqui a cada carga. Ver selectedRecords, que guarda os
        // registros completos dos itens marcados independente do que está
        // carregado agora — exportRows() usa esse cache, não o `archive` ao
        // vivo, senão um item marcado numa carga anterior sumiria do
        // relatório assim que o acervo fosse substituído.
        // Estado do índice zera a cada carga; o bloco de sincronização
        // incremental logo abaixo pode reativá-lo se o disco já tiver o acervo.
        indexReady = false;
        textInMemory = true;
        hydrationCache.clear();
        relevanceCache.clear();
        hydratedLive.length = 0;
        // Comments só entra no layout (e portanto no download) quando a caixa
        // "Discussão" está marcada NA HORA de carregar — evita o custo extra
        // de payload em cargas onde ninguém vai buscar nesse campo.
        const includeDiscussion = ui.fieldDiscussion.checked;
        const layout = includeDiscussion ? `${ARCHIVE_LAYOUT_BASE},Comments` : ARCHIVE_LAYOUT_BASE;
        archiveIncludesDiscussion = includeDiscussion;
        loadedSignature = computeLoadSignature();
        ui.loadButton.disabled = true;
        ui.cancelLoad.hidden = false;
        refreshSearchButtonState();
        ui.semanticSearch.disabled = true;
        ui.exportButton.disabled = true;
        ui.copyButton.disabled = true;
        const periodMode = ui.dateMode.value;
        const periodNote = periodMode === "any" ? "" :
            periodMode === "days" ? `últimos ${ui.dateDays.value || "?"} dias` :
            periodMode === "on" ? `em ${ui.dateFrom.value || "?"}` :
            periodMode === "after" ? `a partir de ${ui.dateFrom.value || "?"}` :
            periodMode === "before" ? `até ${ui.dateTo.value || "?"}` :
            periodMode === "between" ? `entre ${ui.dateFrom.value || "?"} e ${ui.dateTo.value || "?"}` : "";
        const specialistNames = ui.specialistCombo ? ui.specialistCombo.getSelected().map(o => o.label) : [];
        const requesterNames = ui.requestedForCombo ? ui.requestedForCombo.getSelected().map(o => o.label) : [];
        const loadNote = [
            specialistNames.length ? `Designado Especialista: ${specialistNames.join(", ")}` : "",
            requesterNames.length ? `Solicitado para: ${requesterNames.join(", ")}` : "",
            periodNote ? `período: ${periodNote}` : ""
        ].filter(Boolean).join(" · ");
        setStatus(loadNote ? `Planejando carga por período (restrito a ${loadNote})...` : "Planejando carga por período (mais recente primeiro)...", "info");
        setProgress("Preparando os intervalos de data...", 2);

        try {
            const semGse = ignoringGse();
            const groupIds = semGse ? [] : selectedGseIds();
            if (!semGse && !groupIds.length) throw new Error("Selecione ao menos um GSE no painel de filtros.");
            if (semGse && !hasResolvedPersonFilter()) {
                throw new Error('Com "Ignorar GSE" marcado, escolha uma pessoa em Solicitado para ou Designado Especialista (selecionando uma sugestão da lista).');
            }
            const loadRange = computeLoadDateRange();
            let splitRangeFrom = loadRange.from != null ? loadRange.from : ARCHIVE_EARLIEST_TIME;
            const splitRangeTo = loadRange.to != null ? loadRange.to : ARCHIVE_LATEST_TIME;

            // ---- DISCUSSÃO LIGADA/DESLIGADA DEPOIS DE JÁ INDEXAR -----------
            // O índice guarda o texto que foi carregado NA HORA de indexar. Se a
            // GSE foi indexada SEM discussão e agora você liga "Discussão" (ou
            // vice-versa), o índice fica defasado: a busca por discussão acharia
            // resultados na memória (recém-carregada com discussão) mas os
            // perderia no índice (que não tem discussão) — dava aquele "achou e
            // depois sumiu". A guarda de deduplicação da indexação pula
            // registros já gravados, então recarregar sozinho não conserta.
            // Solução: quando o estado de discussão de uma GSE já indexada
            // difere do pedido agora, apaga essa GSE do disco pra ela ser
            // reindexada por inteiro, com o texto certo.
            if (!semGse && groupIds.length && includeDiscussion) {
                // Reindexa se o índice não GARANTE ter a discussão. Isso cobre
                // dois casos: quem foi indexado explicitamente sem discussão
                // (hasDiscussion === false) E quem foi indexado por uma versão
                // antiga, que nem gravava esse campo (hasDiscussion undefined) —
                // era esse segundo caso que continuava dando 0 resultados na
                // busca por Discussão, porque o teste antigo exigia um booleano.
                const syncRowsForDisc = await db.syncState.bulkGet(groupIds.map(String));
                const staleGses = [];
                syncRowsForDisc.forEach((row, index) => {
                    if (row && row.hasDiscussion !== true) staleGses.push(String(groupIds[index]));
                });
                if (staleGses.length) {
                    setStatus(`Recriando o índice ${staleGses.length === 1 ? "de 1 GSE" : `de ${staleGses.length} GSEs`} para incluir a Discussão na busca — isso acontece uma vez, depois de ligar "Discussão" num acervo indexado sem ela.`, "info");
                    for (const gseId of staleGses) {
                        try { await deleteGseFromDisk(gseId); } catch (_) {}
                    }
                    forceFullReindex = true; // não tenta restaurar do disco o que acabou de ser apagado
                }
            }

            // ---- SINCRONIZAÇÃO INCREMENTAL -------------------------------
            // Se TODAS as GSEs pedidas já foram indexadas nesta máquina, o que
            // está no disco continua valendo: recupera os campos estruturados
            // de lá (o texto fica no disco mesmo) e baixa da rede só o que é
            // mais novo que a última indexação. O índice antigo já fica
            // disponível pra busca de imediato, sem esperar esta carga.
            // Só chamados NOVOS — os já indexados que mudaram não se atualizam
            // sozinhos; pra isso existe o botão "Reindexar do zero".
            // Guarda o início pedido, pra registrar depois até onde PARA TRÁS
            // esta GSE passa a estar coberta.
            requestedCoverageFrom = splitRangeFrom;

            let incrementalFrom = null;
            if (!forceFullReindex && !semGse) {
                const syncRows = await db.syncState.bulkGet(groupIds);
                const allIndexed = syncRows.length && syncRows.every(row => row && Number.isFinite(Number(row.lastCreateTime)));

                // COBERTURA PARA TRÁS — a correção de um erro sério.
                // Antes eu só guardava até ONDE cada GSE tinha sido indexada, e
                // nunca A PARTIR DE ONDE. Com isso, ao ampliar o período para
                // trás (de "últimos 180 dias" para "qualquer data"), a linha
                // `splitRangeFrom = Math.max(splitRangeFrom, ...)` empurrava o
                // início pedido lá em 2010 para "a partir de agora": a rede não
                // trazia quase nada, sobrava só o que estava no disco, e a tela
                // mostrava o resultado dos 180 dias como se fosse o histórico
                // completo — sem nenhum aviso de que faltava coisa.
                // Agora a sincronização incremental só é usada quando o período
                // pedido já está inteiramente coberto pelo que temos gravado.
                // Pedindo algo mais antigo, a carga é completa no período
                // pedido; o que já está indexado é reconhecido e não reindexado.
                const coverage = syncRows.map(row => (row && Number(row.coverageFrom)) || Infinity);
                const coveredFrom = coverage.length ? Math.max.apply(null, coverage) : Infinity;
                const periodJaCoberto = Number.isFinite(coveredFrom) && splitRangeFrom >= coveredFrom;

                if (allIndexed) {
                    const oldestSync = Math.min(...syncRows.map(row => Number(row.lastCreateTime)));
                    const restored = await loadArchiveMetadataFromDisk(groupIds, splitRangeFrom, splitRangeTo);
                    if (restored.length) {
                        restored.forEach(item => { archiveIdIndex.set(item.id, archive.length); archive.push(item); });
                        indexReady = true;   // o índice salvo já vale pra buscar agora
                        textInMemory = false;
                        // Pré-aquecimento SEM await, de propósito: ele lê o
                        // vocabulário inteiro e custa segundos. Esperar por ele
                        // aqui atrasava a Fase 1 — ou seja, atrasava justamente
                        // o que o usuário está esperando ver. Roda em paralelo
                        // com a carga da rede e estará pronto bem antes da
                        // primeira busca.
                        warmUpIndex().catch(() => {});

                        if (periodJaCoberto) {
                            incrementalFrom = oldestSync + 1;
                            splitRangeFrom = Math.max(splitRangeFrom, incrementalFrom);
                            setStatus(`${restored.length.toLocaleString("pt-BR")} solicitação(ões) recuperadas do índice em disco — buscando só o que entrou depois de ${formatDate(oldestSync)}.`, "info");
                        } else {
                            setStatus(`Período pedido é mais antigo do que o já indexado (que começa em ${formatDate(coveredFrom)}) — baixando o intervalo completo. O que já está no disco não será baixado de novo.`, "info");
                        }

                        // Mostra JÁ o que veio do disco, sem esperar a rede.
                        // Antes o primeiro resultado só aparecia quando a
                        // primeira janela de recência terminava de baixar —
                        // ou seja, o acervo inteiro já estava aqui, pronto e
                        // indexado, e mesmo assim a tela ficava vazia
                        // esperando a rede. Era isso que fazia a carga com
                        // período ampliado parecer travada no começo.
                        if (liveSearchDuringLoad) { try { liveSearchDuringLoad(); } catch (_) {} }
                    }
                }
            }
            forceFullReindex = false;

            // Carrega por período, do mais recente pro mais antigo — cada
            // janela é medida, paginada e já aparece na tela (via
            // liveSearchDuringLoad) antes de passar pra próxima, mais
            // antiga. Assim você já lê os resultados recentes enquanto o
            // restante ainda está a caminho, sem risco de algo mais novo
            // aparecer depois de algo mais antigo já mostrado.
            const windows = buildRecencyWindows(splitRangeFrom, splitRangeTo);
            const warnings = [];
            const failedWindows = [];
            let loadedCount = 0;

            for (let w = 0; w < windows.length; w++) {
                if (archiveCancelled) break;
                const win = windows[w];
                const label = `${formatDate(win.from)} – ${formatDate(win.to)}`;
                loadingProgressInfo = { windowIndex: w, windowCount: windows.length, label };
                setProgress(`Medindo período ${w + 1} de ${windows.length} (${label})...`, 3 + Math.round((w / windows.length) * 9));

                let units;
                try {
                    units = await splitWindowUntilSafe(groupIds, label, win.from, win.to, 0);
                } catch (error) {
                    warnings.push(`Não foi possível medir o período ${label}: ${error.message || error}`);
                    continue;
                }
                if (archiveCancelled) break;

                const batches = planBatches(units);
                const oversized = batches.filter(batch => batch.total > BATCH_SAFETY_LIMIT);
                if (oversized.length) {
                    warnings.push(`Período ${label}: ${oversized.length} lote(s) passam da margem de segurança (${BATCH_SAFETY_LIMIT.toLocaleString("pt-BR")})`);
                }

                for (let b = 0; b < batches.length; b++) {
                    if (archiveCancelled) break;
                    const batch = batches[b];
                    const combinedFilter = combineClauses(batch.clauses);
                    const mergeRecords = records => {
                        records.forEach(item => {
                            const existingIndex = archiveIdIndex.get(item.id);
                            if (existingIndex === undefined) {
                                archiveIdIndex.set(item.id, archive.length);
                                archive.push(item);
                            } else if (!archive[existingIndex].description && !archive[existingIndex].solution && (item.description || item.solution)) {
                                archive[existingIndex] = item;
                            }
                        });
                    };
                    const reportProgress = fraction => {
                        const windowProgress = (w + (b + fraction) / batches.length) / windows.length;
                        setProgress(`Carregando (período ${w + 1} de ${windows.length}: ${label}): ${loadedCount.toLocaleString("pt-BR")} solicitações`, 12 + Math.round(windowProgress * 86));
                    };
                    // Primeira página do lote é pequena e sai num canal
                    // reservado (fora da concorrência das páginas grandes) —
                    // é o que faz o primeiro resultado aparecer rápido sem
                    // esperar o lote inteiro. As páginas seguintes (grandes,
                    // sem sobreposição de skip) dividem os canais restantes.
                    const firstSize = Math.min(FIRST_PAGE_SIZE, batch.total || FIRST_PAGE_SIZE);
                    const bulkSkips = [];
                    for (let skip = firstSize; skip < batch.total; skip += BULK_PAGE_SIZE) bulkSkips.push(skip);
                    // Cada página falha por conta própria — uma falha isolada
                    // não derruba o lote inteiro. MAS precisa aparecer como
                    // aviso (antes era engolida em silêncio, tanto na primeira
                    // página quanto nas em lote via concurrentMap): sem isso,
                    // a Fase 2 marcava a GSE como "cobertura completa" do
                    // período pedido mesmo com páginas que nunca chegaram a
                    // baixar, escondendo o buraco pra sempre — nem
                    // "Recarregar acervo" tentava de novo, porque achava que
                    // já tinha tudo.
                    try {
                        let firstPageFailed = false;
                        const firstPagePromise = fetchBatchPage(combinedFilter, 0, layout, firstSize).then(records => {
                            loadedCount += records.length;
                            mergeRecords(records);
                            reportProgress(0.3);
                            if (liveSearchDuringLoad) { try { liveSearchDuringLoad(); } catch (_) {} }
                            return records;
                        }).catch(() => { firstPageFailed = true; return []; });
                        const bulkPagesPromise = bulkSkips.length
                            ? concurrentMap(bulkSkips, async skip => {
                                const records = await fetchBatchPage(combinedFilter, skip, layout, BULK_PAGE_SIZE);
                                loadedCount += records.length;
                                mergeRecords(records);
                                reportProgress(1);
                                return records;
                            }, null, Math.max(1, CONCURRENCY - 1))
                            : Promise.resolve([]);
                        const [, bulkOutput] = await Promise.all([firstPagePromise, bulkPagesPromise]);
                        const failedBulkPages = (bulkOutput || []).filter(entry => entry && entry.error).length;
                        if (firstPageFailed || failedBulkPages) {
                            const totalPages = 1 + bulkSkips.length;
                            const failedPages = (firstPageFailed ? 1 : 0) + failedBulkPages;
                            failedWindows.push(`${label} (lote ${b + 1}): ${failedPages} de ${totalPages} página(s) não carregaram`);
                        }
                    } catch (error) {
                        failedWindows.push(`${label} (lote ${b + 1})`);
                    }
                }

                // Fecha esta janela: já dá pra mostrar o que temos, mais
                // recente primeiro, enquanto as janelas mais antigas seguem.
                if (liveSearchDuringLoad) { try { liveSearchDuringLoad(); } catch (_) {} }
            }

            if (archiveCancelled) { setStatus("Carga cancelada pelo usuário.", "warning"); return; }

            const byId = new Map();
            archive.forEach(item => byId.set(item.id, item));
            archive = Array.from(byId.values());
            archiveLoadedAt = new Date();

            setProgress(`Acervo carregado: ${archive.length.toLocaleString("pt-BR")} solicitações`, 100);
            if (failedWindows.length) warnings.push(`Falha ao carregar: ${failedWindows.join(" | ")}`);
            const warningNote = warnings.length ? ` ⚠ ${warnings.join(" · ")}. Clique em "Recarregar acervo" para tentar reaver o que faltou.` : "";
            setStatus(`Acervo pronto (${archive.length.toLocaleString("pt-BR")} solicitações, ${windows.length} período(s)) — carregado às ${archiveLoadedAt.toLocaleTimeString("pt-BR")}.${warningNote}`, warnings.length ? "warning" : "success");
            renderStats();

            // ---- FASE 2 -------------------------------------------------
            // Começa AGORA, em segundo plano, sem await: a Fase 1 já entregou
            // o resultado e o usuário já pode buscar (em memória) enquanto
            // isto roda. Só entra o que veio da rede nesta carga — o que foi
            // recuperado do disco já está indexado.
            // Consulta ao vivo (sem GSE) NÃO é indexada. Gravar esses
            // chamados criaria pedaços soltos de GSEs nunca carregadas por
            // inteiro, e a contabilidade de cobertura — justamente o que
            // consertamos depois do bug de período ampliado — voltaria a ficar
            // ambígua. Aqui o resultado vive só nesta sessão, e a aba
            // Estatística não precisa de índice: ela não faz busca textual.
            if (semGse) {
                indexReady = false;
                textInMemory = true;
                liveQueryMode = true;
                renderIndexStatus();
            } else {
                liveQueryMode = false;
                // Se algo falhou nesta carga (janela, lote ou página), NÃO
                // deixa a Fase 2 registrar cobertura até o início pedido —
                // isso mentiria que o período inteiro foi baixado com
                // sucesso, e da próxima vez (mesmo clicando "Recarregar
                // acervo") o script acharia que já tem tudo e nem tentaria
                // buscar de novo o pedaço que faltou. `null` faz a Fase 2
                // manter a cobertura anterior de cada GSE, sem avançar.
                const confirmedCoverageFrom = warnings.length ? null : requestedCoverageFrom;
                startIndexingPhase(archive.filter(item => !item.__textOffloaded), groupIds, confirmedCoverageFrom);
            }
        } catch (error) {
            setStatus(error.message || String(error), "error");
        } finally {
            // Antes só re-habilitava Pesquisar/Buscar semelhantes no caminho
            // de sucesso — se você cancelava, ficavam travados pra sempre
            // (o "return" do cancelamento pulava essas linhas). Agora isso
            // roda sempre, cancelado ou não, com base no que já carregou.
            archiveLoading = false;
            loadingProgressInfo = null;
            ui.loadButton.disabled = false;
            ui.cancelLoad.hidden = true;
            refreshSearchButtonState();
            ui.semanticSearch.disabled = false;
            ui.copyButton.disabled = !archive.length;
            ui.exportButton.disabled = !archive.length;
        }
    }

    // ============================================================
    // FASE 2 — gravar em disco e indexar, em segundo plano
    // ============================================================
    // Não é await em lugar nenhum de propósito: a Fase 1 já mostrou o
    // resultado e a busca em memória já funciona. Quando isto termina, o texto
    // sai da memória e a busca passa a usar o índice — a etiqueta na barra de
    // status muda de "em memória" para "via índice em disco".
    async function startIndexingPhase(newItems, groupIds, confirmedCoverageFrom) {
        if (!newItems.length) {
            // Nada novo veio da rede (sincronização incremental sem novidades):
            // o índice do disco já cobre tudo que está na tela.
            if (archive.length) { indexReady = true; textInMemory = false; await warmUpIndex(); }
            renderIndexStatus();
            return;
        }
        indexing = true;
        indexProgress = { done: 0, total: newItems.length };
        renderIndexStatus();
        const startedAt = performance.now();
        try {
            const completed = await runIndexingPhase(newItems, (done, total) => {
                indexProgress = { done, total };
                renderIndexStatus();
            });
            if (!completed) { indexing = false; indexProgress = null; renderIndexStatus(); return; }

            // Duas marcas d'água por GSE, com papéis diferentes — não são
            // redundantes:
            //   lastCreateTime — até que data de CRIAÇÃO já baixamos. É o que a
            //     carga manual usa pra pedir só os chamados novos ao SMAX.
            //   lastUpdate ..... até que data de ALTERAÇÃO já processamos. É o
            //     que a sincronização automática usa, e é o único que enxerga
            //     chamado antigo que mudou de status.
            const newestByGse = new Map();
            const newestUpdateByGse = new Map();
            newItems.forEach(item => {
                const groupId = String(item.groupId);
                const created = Number(item.created);
                if (Number.isFinite(created) && (!newestByGse.has(groupId) || created > newestByGse.get(groupId))) {
                    newestByGse.set(groupId, created);
                }
                const updated = Number(item.lastUpdate);
                if (Number.isFinite(updated) && (!newestUpdateByGse.has(groupId) || updated > newestUpdateByGse.get(groupId))) {
                    newestUpdateByGse.set(groupId, updated);
                }
            });
            const previous = await db.syncState.bulkGet(groupIds.map(String));
            await db.syncState.bulkPut(groupIds.map((groupId, index) => {
                const key = String(groupId);
                const beforeCreate = (previous[index] && Number(previous[index].lastCreateTime)) || 0;
                const beforeUpdate = (previous[index] && Number(previous[index].lastUpdate)) || 0;
                const beforeCoverage = (previous[index] && Number(previous[index].coverageFrom));
                // coverageFrom só DIMINUI: cobrir de 2010 em diante engloba
                // cobrir dos últimos 180 dias, nunca o contrário. E só avança
                // com base no que foi CONFIRMADO sem falhas nesta carga
                // (confirmedCoverageFrom vem null do chamador quando alguma
                // janela/lote/página falhou) — nunca com o que foi só pedido,
                // senão um buraco causado por uma falha de rede vira
                // "coberto" para sempre e nenhuma carga futura tenta de novo.
                const coverageFrom = confirmedCoverageFrom == null
                    ? beforeCoverage
                    : Math.min(Number.isFinite(beforeCoverage) ? beforeCoverage : Infinity, confirmedCoverageFrom);
                return {
                    groupId: key,
                    lastCreateTime: Math.max(beforeCreate, newestByGse.get(key) || 0),
                    lastUpdate: Math.max(beforeUpdate, newestUpdateByGse.get(key) || 0),
                    coverageFrom: Number.isFinite(coverageFrom) ? coverageFrom : undefined,
                    // Registra se o texto indexado desta GSE inclui a discussão —
                    // é o que permite detectar, numa carga futura, que o índice
                    // precisa ser recriado por causa de uma mudança nesse campo.
                    hasDiscussion: archiveIncludesDiscussion
                };
            }));

            await warmUpIndex();
            indexReady = true;

            // ESTE é o passo que devolve a memória: o texto já está seguro no
            // disco, então sai do array. Daqui em diante ele volta só para os
            // cartões que aparecem na tela.
            archive.forEach(offloadText);
            textInMemory = false;
            semanticIndex = null; // o índice em memória do BM25 não é mais usado nem necessário

            indexing = false;
            indexProgress = null;
            renderIndexStatus();
            // A carga manual é guiada pela data de CRIAÇÃO, então sozinha ela só
            // traz chamados novos. Uma rodada da sincronização (guiada pela data
            // de ALTERAÇÃO) logo em seguida recolhe também os que mudaram — do
            // contrário, quem desligasse a atualização automática ficaria sem
            // nunca receber mudança de status de chamado já indexado.
            tickAutoSync(true);
            setStatus(`Índice pronto em ${((performance.now() - startedAt) / 1000).toFixed(1)}s — a busca agora usa o disco e a memória do texto foi liberada. Fechar e reabrir o navegador não exige recarregar tudo de novo.`, "success");
        } catch (error) {
            indexing = false;
            indexProgress = null;
            renderIndexStatus();
            // Falhar aqui não pode quebrar nada: a busca em memória continua
            // valendo, exatamente como na versão de produção.
            setStatus(`Não foi possível indexar em disco (${error.message || error}) — a busca continua funcionando em memória, como na versão de produção.`, "warning");
        }
    }

    // ============================================================
    // MEDIÇÃO DE ESPAÇO POR TABELA E POR CAMPO (diagnóstico)
    // ============================================================
    // O IndexedDB não informa quanto cada tabela ocupa — só o total do
    // domínio. Então a medição é por amostragem: lê algumas centenas de linhas
    // de cada tabela, mede quantos bytes cada campo ocupa em UTF-8 e projeta
    // pelo número total de linhas. NÃO é o número exato que o navegador
    // reserva em disco (ele guarda em formato binário próprio, com índices e
    // folga por cima) — mas a PROPORÇÃO entre os campos é confiável, e é isso
    // que decide onde vale mexer.
    const MEASURE_SAMPLE_PER_SPOT = 100;

    function byteSize(value) {
        if (value == null) return 0;
        try { return new Blob([typeof value === "string" ? value : JSON.stringify(value)]).size; }
        catch (_) { return String(value).length; }
    }

    // Amostra em três pontos (início, meio e fim) em vez de só no começo:
    // chamados antigos e recentes têm tamanho de texto bem diferente, e pegar
    // só o começo enviesaria a projeção.
    async function sampleRows(table, count) {
        if (!count) return [];
        const spots = count <= MEASURE_SAMPLE_PER_SPOT * 3
            ? [0]
            : [0, Math.floor(count / 2), Math.max(0, count - MEASURE_SAMPLE_PER_SPOT)];
        const limit = count <= MEASURE_SAMPLE_PER_SPOT * 3 ? count : MEASURE_SAMPLE_PER_SPOT;
        const chunks = [];
        for (const offset of spots) chunks.push(await table.toCollection().offset(offset).limit(limit).toArray());
        return chunks.flat();
    }

    function averageFieldBytes(rows, fields) {
        const totals = {};
        fields.forEach(field => { totals[field] = 0; });
        rows.forEach(row => fields.forEach(field => { totals[field] += byteSize(row[field]); }));
        const out = {};
        fields.forEach(field => { out[field] = rows.length ? totals[field] / rows.length : 0; });
        return out;
    }

    async function measureIndexBreakdown() {
        const [metaCount, textCount, wordTermCount, stemTermCount] = await Promise.all([
            db.meta.count(), db.texts.count(), db.wordPostings.count(), db.stemPostings.count()
        ]);
        if (!textCount && !metaCount) throw new Error("Não há nada indexado em disco para medir.");
        const [metaRows, textRows, wordRows, stemRows] = await Promise.all([
            sampleRows(db.meta, metaCount),
            sampleRows(db.texts, textCount),
            sampleRows(db.wordPostings, wordTermCount),
            sampleRows(db.stemPostings, stemTermCount)
        ]);

        const textAvg = averageFieldBytes(textRows, ["description", "solution", "discussion", "discussionEntries"]);
        const metaAvg = averageFieldBytes(metaRows, ["groupName", "requestedFor", "assignedSpecialist", "unidade", "status", "statusOperacional", "created", "solutionDate", "id", "groupId", "isVip", "isGlobal", "lastUpdate", "docId", "docLen"]);

        // Blocos binários: 4 bytes por chamado na lista de IDs, 2 bytes na de
        // frequências. Medir pelo comprimento é exato aqui — diferente do
        // JSON, não há aspas nem vírgulas para estimar.
        const avgOf = (rows, fn) => rows.length ? rows.reduce((sum, row) => sum + fn(row), 0) / rows.length : 0;
        const wordIdsAvg = avgOf(wordRows, row => (row.ids ? row.ids.length : 0) * 4);
        const wordKeyAvg = avgOf(wordRows, row => byteSize(row.term));
        const stemIdsAvg = avgOf(stemRows, row => (row.ids ? row.ids.length : 0) * 4);
        const stemTfsAvg = avgOf(stemRows, row => (row.tfs ? row.tfs.length : 0) * 2);
        const stemKeyAvg = avgOf(stemRows, row => byteSize(row.term));

        const lines = [];
        const push = (label, avgBytes, count, note) => {
            lines.push({ label, total: avgBytes * count, avg: avgBytes, note: note || "" });
        };

        push("texts · description", textAvg.description, textCount);
        push("texts · solution", textAvg.solution, textCount);
        push("texts · discussion", textAvg.discussion, textCount, "duplica discussionEntries");
        push("texts · discussionEntries", textAvg.discussionEntries, textCount, "duplica discussion");
        push("wordPostings · listas de IDs", wordIdsAvg, wordTermCount, `${wordTermCount.toLocaleString("pt-BR")} termos distintos`);
        push("wordPostings · termo (chave)", wordKeyAvg, wordTermCount);
        push("stemPostings · listas de IDs", stemIdsAvg, stemTermCount, `${stemTermCount.toLocaleString("pt-BR")} radicais distintos`);
        push("stemPostings · frequências", stemTfsAvg, stemTermCount);
        push("stemPostings · termo (chave)", stemKeyAvg, stemTermCount);
        push("meta · todos os campos", Object.values(metaAvg).reduce((a, b) => a + b, 0), metaCount);

        const grandTotal = lines.reduce((sum, line) => sum + line.total, 0) || 1;
        const mb = bytes => (bytes / 1048576).toFixed(1);

        // Nesta versão a única duplicação que sobrou é a da discussão (texto
        // corrido + entradas). A dos radicais deixou de existir: cada termo
        // aparece uma única vez, como chave da sua linha de postings.
        const wasteDiscussion = Math.min(textAvg.discussion, textAvg.discussionEntries) * textCount;
        const wasteStems = 0;
        const totalPostings = (wordIdsAvg * wordTermCount + stemIdsAvg * stemTermCount) / 4;

        let estimate = null;
        if (navigator.storage && navigator.storage.estimate) {
            try { estimate = await navigator.storage.estimate(); } catch (_) {}
        }

        // O total do navegador é por DOMÍNIO, não por banco: com o v2 ainda
        // instalado, o acervo dele entra na conta e faz o v3 parecer muito
        // maior do que é. Sem este aviso a comparação entre as versões engana.
        let siblingNote = "";
        try {
            if (indexedDB.databases) {
                const others = (await indexedDB.databases())
                    .map(entry => entry && entry.name)
                    .filter(name => name && name !== INDEX_DB_NAME && /acervo/i.test(name));
                if (others.length) {
                    siblingNote = `<p><strong>Atenção ao comparar:</strong> o total acima é do domínio inteiro e inclui ${others.length === 1 ? "outro banco" : "outros bancos"} de versão anterior ainda presente${others.length === 1 ? "" : "s"} nesta máquina (${others.map(escapeHtml).join(", ")}). Para ver o número só desta versão, desinstale a versão antiga e apague o banco dela.</p>`;
                }
            }
        } catch (_) {}

        const rowsHtml = lines
            .slice().sort((a, b) => b.total - a.total)
            .map(line => `<tr><td>${escapeHtml(line.label)}</td><td>${mb(line.total)} MB</td><td>${Math.round((line.total / grandTotal) * 100)}%</td><td>${escapeHtml(line.note)}</td></tr>`)
            .join("");

        return `
            <div class="index-report-inner">
                <strong>Medição por amostragem — ${textCount.toLocaleString("pt-BR")} chamados indexados</strong>
                <table>
                    <thead><tr><th>Campo</th><th>Projetado</th><th>%</th><th>Observação</th></tr></thead>
                    <tbody>${rowsHtml}</tbody>
                </table>
                <p>Soma projetada dos campos: <strong>${mb(grandTotal)} MB</strong>${estimate ? ` · o navegador reporta <strong>${mb(estimate.usage)} MB</strong> reservados no total` : ""} · ${Math.round(totalPostings).toLocaleString("pt-BR")} relações termo→chamado guardadas.</p>
                <p><strong>Compare com a v2:</strong> lá as relações termo→chamado ficavam em índices <em>multiEntry</em>, que gastavam cerca de 30 bytes cada. Aqui elas custam 4 bytes (lista de IDs) mais 2 (frequência, só no BM25). Se a diferença entre a soma projetada e o total reportado pelo navegador tiver encolhido bastante em relação à v2 — lá eram 88 MB contra 197 MB — a mudança fez o que devia.</p>
                <p>Duplicação restante: discussão gravada em dobro (texto corrido + entradas) <strong>${mb(wasteDiscussion)} MB</strong>. A duplicação de radicais da v2 deixou de existir — cada termo agora aparece uma vez só, como chave da sua linha.</p>
                ${siblingNote}
                <p class="index-report-note">Os textos são estimados por amostra lida em três pontos do acervo (início, meio e fim) e projetados para o total. Já as listas binárias são medidas pelo comprimento real, sem estimativa. Nenhum dos dois inclui a sobrecarga interna do navegador.</p>
            </div>`;
    }

    // Mostra em que pé está o índice: indexando (com progresso), pronto (e
    // quanto ocupa em disco) ou ainda só em memória. É por aqui que dá pra
    // conferir, sem abrir o console, qual caminho a busca está usando.
    function renderIndexStatus() {
        if (!ui || !ui.indexStrip) return;
        const strip = ui.indexStrip;
        if (!archive.length && !indexing && !indexReady) { strip.hidden = true; return; }
        strip.hidden = false;
        ui.indexDot.classList.remove("working", "ready");
        if (indexing && indexProgress) {
            const { done, total } = indexProgress;
            const pct = total ? Math.round((done / total) * 100) : 0;
            ui.indexDot.classList.add("working");
            ui.indexTrack.hidden = false;
            ui.indexFill.style.width = pct + "%";
            ui.indexLabel.textContent = `Indexando em disco, em segundo plano: ${done.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")} (${pct}%) · a busca já funciona, usando a memória`;
            return;
        }
        ui.indexTrack.hidden = true;
        if (syncing) {
            ui.indexDot.classList.add("working");
            ui.indexLabel.textContent = "Procurando chamados alterados no SMAX...";
            return;
        }
        if (indexReady) {
            ui.indexDot.classList.add("ready");
            // O horário aparece SEMPRE que existir, inclusive com a atualização
            // automática desligada — nesse caso ele é ainda mais importante,
            // porque indica há quanto tempo o acervo não é conferido.
            const quando = describeLastSync(lastSyncAt);
            const syncNote = quando
                ? ` · atualizado ${quando}${autoSyncEnabled ? "" : " · atualização automática desligada"}`
                : (autoSyncEnabled ? " · verificando alterações a cada 5 min" : " · atualização automática desligada");
            ui.indexLabel.textContent = `Índice em disco pronto — busca pelo índice, texto fora da memória${syncNote}`;
            if (navigator.storage && navigator.storage.estimate) {
                navigator.storage.estimate().then(estimate => {
                    if (!indexReady) return;
                    const disk = (estimate.usage / 1048576).toFixed(1);
                    const heap = performance.memory ? ` · memória desta aba: ${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB` : "";
                    ui.indexLabel.textContent = `Índice em disco pronto — busca pelo índice, texto fora da memória · ${disk} MB em disco${heap}`;
                }).catch(() => {});
            }
            return;
        }
        ui.indexLabel.textContent = liveQueryMode
            ? "Consulta ao vivo por pessoa, sem GSE — o resultado vale só nesta sessão e não é salvo em disco."
            : "Acervo em memória (ainda não indexado em disco) — funciona igual à versão de produção.";
    }

    // ============================================================
    // SINCRONIZAÇÃO AUTOMÁTICA
    // ============================================================
    // Roda enquanto a aba do SMAX está visível, a cada 5 minutos, e verifica
    // imediatamente quando você volta para a aba depois de um tempo fora — que
    // é o momento em que o acervo estar atualizado importa de verdade.
    //
    // COMANDADA POR LastUpdateTime, NÃO POR Active. Isso é deliberado: o
    // encerramento de um chamado é justamente a gravação que o torna inativo,
    // então filtrar por ativos perderia exatamente a atualização mais
    // importante e o acervo ficaria com tudo no penúltimo estado. Confirmado
    // com Leonardo: no SMAX qualquer alteração exige salvar, e salvar carimba
    // nova LastUpdateTime — por isso este campo sozinho basta.
    //
    // A MARCA D'ÁGUA SÓ AVANÇA PELO QUE FOI COMPLETAMENTE PROCESSADO. Os
    // chamados vêm em ordem CRESCENTE de LastUpdateTime e a marca vai para a
    // data do último lote gravado. Se você fechar a aba no meio, a próxima
    // rodada recomeça exatamente dali — nunca "sincronizei até agora" sem ter
    // sincronizado, que apagaria silenciosamente o que faltou.
    const SYNC_INTERVAL_MS = 5 * 60 * 1000;
    const SYNC_PAGE_SIZE = 250;
    const SYNC_MAX_PAGES_PER_TICK = 8;   // teto por rodada, pra não roubar a máquina
    const SYNC_LOCK_NAME = "tjsp-acervo-v4-sync";
    const SYNC_WINDOW_START_MS = 24 * 60 * 60 * 1000; // janela inicial ao varrer atraso

    const AUTOSYNC_STORAGE_KEY = "tjspArchivoAutoSync";
    let autoSyncEnabled = (function () {
        try { return localStorage.getItem(AUTOSYNC_STORAGE_KEY) !== "0"; } catch (_) { return true; }
    }());
    let autoSyncTimer = null;
    let syncing = false;
    let lastSyncAt = null;
    let lastSyncResult = "";
    let lastSyncTouched = 0;

    // Só sincroniza quando não atrapalha: aba visível, nada carregando, nada
    // indexando e nenhuma busca em andamento.
    function canSyncNow() {
        return autoSyncEnabled && !syncing && !archiveLoading && !indexing && !searchRunning && !liveQueryMode
            && document.visibilityState === "visible" && archive.length > 0;
    }

    // Trava entre abas. A gravação de postings é ler-alterar-regravar: duas
    // abas sincronizando ao mesmo tempo leriam a mesma lista e a última a
    // gravar apagaria o trabalho da outra, corrompendo o índice em silêncio.
    // A API de bloqueios do navegador resolve isso; "ifAvailable" faz a aba que
    // não conseguir a trava simplesmente pular a rodada em vez de enfileirar.
    async function withSyncLock(work) {
        if (!navigator.locks || !navigator.locks.request) {
            // Sem a API disponível, cai numa trava simples por localStorage.
            const now = Date.now();
            let holder = 0;
            try { holder = Number(localStorage.getItem(SYNC_LOCK_NAME)) || 0; } catch (_) {}
            if (now - holder < 90000) return false;
            try { localStorage.setItem(SYNC_LOCK_NAME, String(now)); } catch (_) {}
            try { return await work(); }
            finally { try { localStorage.removeItem(SYNC_LOCK_NAME); } catch (_) {} }
        }
        let ran = false;
        await navigator.locks.request(SYNC_LOCK_NAME, { ifAvailable: true }, async lock => {
            if (!lock) return;      // outra aba já está sincronizando
            ran = await work();
        });
        return ran;
    }

    // Marca d'água por GSE. Guardada por GSE (e não uma só global) porque cada
    // GSE pode ter sido indexada em momentos diferentes.
    async function syncWatermark(groupIds) {
        const rows = await db.syncState.bulkGet(groupIds.map(String));
        const marks = rows.map(row => (row && Number(row.lastUpdate)) || 0).filter(Boolean);
        return marks.length === rows.length && marks.length ? Math.min.apply(null, marks) : 0;
    }

    function syncGroupClause(groupIds) {
        return groupIds.length === 1
            ? `AssignedToGroup = '${groupIds[0]}'`
            : `(${groupIds.map(id => `AssignedToGroup = '${id}'`).join(" or ")})`;
    }

    // Busca uma página de alterados, em ordem crescente de atualização.
    async function fetchChangedPage(groupIds, from, to, layout) {
        const clause = `${syncGroupClause(groupIds)} and LastUpdateTime > ${from}${to ? ` and LastUpdateTime <= ${to}` : ""}`;
        const params = new URLSearchParams({
            filter: clause, layout, order: "LastUpdateTime asc",
            size: String(SYNC_PAGE_SIZE), skip: "0"
        });
        const payload = await fetchJson(`${getRestBase()}/ems/Request?${params}`);
        const entities = Array.isArray(payload.entities) ? payload.entities : [];
        return entities.map(normalizeRecord).filter(item => item.id);
    }

    // Uma rodada. Sempre lê a partir da marca d'água com skip=0: como os
    // processados avançam a marca, a página seguinte é sempre a primeira da
    // consulta nova — o que também evita o teto de 10.000 do SMAX, já que a
    // janela nunca acumula.
    async function runSyncPass() {
        const groupIds = selectedGseIds();
        if (!groupIds.length) return false;
        const watermark = await syncWatermark(groupIds);
        if (!watermark) return false; // GSE nunca indexada: quem carrega é a carga normal

        const layout = archiveIncludesDiscussion ? `${ARCHIVE_LAYOUT_BASE},Comments` : ARCHIVE_LAYOUT_BASE;
        let cursor = watermark;
        let touched = 0;

        for (let page = 0; page < SYNC_MAX_PAGES_PER_TICK; page++) {
            if (!canSyncNowDuringPass()) break;
            let batch;
            try {
                batch = await fetchChangedPage(groupIds, cursor, null, layout);
            } catch (error) {
                if (isExceededError(error)) {
                    // Atraso grande demais: estreita a janela e volta na
                    // próxima página, em vez de tentar engolir tudo de uma vez.
                    const to = cursor + SYNC_WINDOW_START_MS;
                    try { batch = await fetchChangedPage(groupIds, cursor, to, layout); }
                    catch (_) { break; }
                } else break;
            }
            if (!batch.length) break;

            await applySyncedRecords(batch);
            touched += batch.length;

            // A marca avança só até aqui — o que veio depois nesta página já
            // está gravado, o que não veio fica pra próxima rodada.
            cursor = batch.reduce((max, item) => Math.max(max, Number(item.lastUpdate) || 0), cursor);
            // Mescla em vez de substituir: bulkPut troca a linha inteira, e
            // gravar só o lastUpdate apagaria o lastCreateTime que a carga
            // manual usa — a próxima carga rebaixaria a GSE inteira.
            const current = await db.syncState.bulkGet(groupIds.map(String));
            await db.syncState.bulkPut(groupIds.map((id, index) => Object.assign(
                { groupId: String(id) },
                current[index] || {},
                { groupId: String(id), lastUpdate: cursor }
            )));

            if (batch.length < SYNC_PAGE_SIZE) break; // acabou o que havia
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        if (touched) {
            vocabularyCache = null;
            corpusStats = null;
            renderIndexStatus();
        }
        lastSyncTouched = touched;
        lastSyncResult = touched
            ? `${touched.toLocaleString("pt-BR")} chamado(s) atualizados`
            : "nada novo";
        return touched > 0;
    }

    // ---- Cirurgia nos postings de um chamado que MUDOU -------------------
    // Chamado novo é fácil: acrescenta ao fim das listas. Chamado alterado é
    // que dá trabalho — o texto mudou, então ele saiu de alguns termos e entrou
    // em outros. Reindexar do zero seria simples mas caro: apagaria e
    // regravaria as ~200 listas de termos dele, quando na prática mudam umas
    // poucas dezenas (o normal é ganhar um comentário).
    //
    // As listas estão sempre em ordem crescente de docId — são preenchidas em
    // ordem e as remoções preservam a ordem —, então dá pra achar a posição por
    // busca binária em vez de varrer a lista inteira. Num termo presente em 20
    // mil chamados isso é a diferença entre ~14 comparações e 20 mil.
    function binaryIndexOf(sortedArray, value) {
        let low = 0, high = sortedArray.length - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            const current = sortedArray[mid];
            if (current === value) return mid;
            if (current < value) low = mid + 1; else high = mid - 1;
        }
        return -(low + 1); // não achou: complemento do ponto de inserção
    }

    function removeAtTyped(typed, index, Ctor) {
        const out = new Ctor(typed.length - 1);
        out.set(typed.subarray(0, index), 0);
        out.set(typed.subarray(index + 1), index);
        return out;
    }

    function insertAtTyped(typed, index, value, Ctor) {
        const out = new Ctor(typed.length + 1);
        out.set(typed.subarray(0, index), 0);
        out[index] = value;
        out.set(typed.subarray(index), index + 1);
        return out;
    }

    // Aplica, de uma vez, todas as operações acumuladas sobre as listas de
    // termos. Agrupar por termo (e não por chamado) faz cada linha ser lida e
    // gravada uma única vez, mesmo que vários chamados do lote a afetem.
    async function applyPostingOps(table, ops, withFrequencies) {
        const terms = Array.from(ops.keys());
        for (let start = 0; start < terms.length; start += 800) {
            const slice = terms.slice(start, start + 800);
            const rows = await table.bulkGet(slice);
            const toWrite = [];
            const toDrop = [];
            slice.forEach((term, index) => {
                const row = rows[index];
                let ids = (row && row.ids) || new Uint32Array(0);
                let tfs = withFrequencies ? ((row && row.tfs) || new Uint16Array(0)) : null;
                ops.get(term).forEach(op => {
                    const at = binaryIndexOf(ids, op.docId);
                    if (op.remove) {
                        if (at < 0) return;
                        ids = removeAtTyped(ids, at, Uint32Array);
                        if (tfs) tfs = removeAtTyped(tfs, at, Uint16Array);
                        return;
                    }
                    if (at >= 0) {                       // já está na lista: só a frequência mudou
                        if (tfs) tfs[at] = op.tf;
                        return;
                    }
                    const insertAt = -at - 1;            // mantém a ordem crescente
                    ids = insertAtTyped(ids, insertAt, op.docId, Uint32Array);
                    if (tfs) tfs = insertAtTyped(tfs, insertAt, op.tf, Uint16Array);
                });
                if (!ids.length) { toDrop.push(term); return; }
                toWrite.push(tfs ? { term, ids, tfs } : { term, ids });
            });
            if (toWrite.length) await table.bulkPut(toWrite);
            if (toDrop.length) await table.bulkDelete(toDrop);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    function pushOp(map, term, op) {
        let bucket = map.get(term);
        if (!bucket) { bucket = []; map.set(term, bucket); }
        bucket.push(op);
    }

    // Recebe o lote vindo da sincronização e separa: o que nunca vimos entra
    // pelo caminho normal de indexação; o que já existe é atualizado no lugar,
    // mantendo o mesmo docId (senão as listas de termos apontariam para um
    // número morto e o antigo continuaria aparecendo na busca).
    async function applySyncedRecords(batch) {
        const existing = await db.meta.bulkGet(batch.map(item => item.id));
        const fresh = [];
        const changed = [];
        batch.forEach((item, index) => {
            if (existing[index]) changed.push({ item, previous: existing[index] });
            else fresh.push(item);
        });

        if (fresh.length) await runIndexingPhase(fresh, null);

        if (changed.length) {
            const oldTexts = await db.texts.bulkGet(changed.map(entry => entry.item.id));
            const wordOps = new Map();
            const stemOps = new Map();
            let docLenDelta = 0;

            changed.forEach((entry, index) => {
                const docId = entry.previous.docId;
                if (docId == null) return;

                // SEMPRE herda o número interno do registro anterior, ANTES de
                // qualquer saída antecipada. Este era um bug sério: quando a
                // sincronização trazia um chamado que mudou de status mas não de
                // texto (encerramento, por exemplo), o caminho abaixo retornava
                // cedo e o item substituído no acervo em memória ficava sem
                // docId. Sem ele, a busca pelo índice descartava o chamado —
                // silenciosamente, e de forma cumulativa: quanto mais a
                // sincronização rodava, mais chamados sumiam do resultado.
                entry.item.docId = docId;
                entry.item.docLen = entry.previous.docLen;

                const before = oldTexts[index] || {};
                const oldFull = `${before.description || ""} ${before.solution || ""} ${before.discussion || ""}`;
                const newFull = `${entry.item.description || ""} ${entry.item.solution || ""} ${entry.item.discussion || ""}`;
                if (oldFull === newFull) return; // mudou algo estrutural, não o texto

                const oldWords = new Set(indexWordsOf(oldFull));
                const newWords = new Set(indexWordsOf(newFull));
                oldWords.forEach(word => { if (!newWords.has(word)) pushOp(wordOps, word, { docId, remove: true }); });
                newWords.forEach(word => { if (!oldWords.has(word)) pushOp(wordOps, word, { docId, tf: 1 }); });

                const oldTf = buildTermFrequencies(oldFull);
                const newTf = buildTermFrequencies(newFull);
                Object.keys(oldTf.tf).forEach(term => {
                    if (newTf.tf[term] === undefined) pushOp(stemOps, term, { docId, remove: true });
                });
                Object.keys(newTf.tf).forEach(term => {
                    // Termo que continua presente só é regravado se a contagem
                    // mudou — o caso comum é a maioria continuar igual.
                    if (oldTf.tf[term] !== newTf.tf[term]) {
                        pushOp(stemOps, term, { docId, tf: Math.min(65535, newTf.tf[term]) });
                    }
                });

                docLenDelta += newTf.docLen - oldTf.docLen;
                entry.item.docLen = newTf.docLen;
            });

            if (wordOps.size) await applyPostingOps(db.wordPostings, wordOps, false);
            if (stemOps.size) await applyPostingOps(db.stemPostings, stemOps, true);

            // Grava o estado novo. Monta as linhas UMA vez por chamado —
            // indexRowsFor tokeniza o texto inteiro, e chamá-lo duas vezes
            // (uma pra meta, outra pro texto) dobraria a parte cara à toa.
            const rebuilt = changed.map(entry => {
                const rows = indexRowsFor(entry.item, entry.previous.docId);
                rows.meta.docLen = entry.item.docLen != null ? entry.item.docLen : entry.previous.docLen;
                return rows;
            });
            await db.meta.bulkPut(rebuilt.map(rows => rows.meta));
            await db.texts.bulkPut(rebuilt.map(rows => rows.text));

            if (docLenDelta) {
                const corpus = await db.settings.get("corpus");
                if (corpus) await db.settings.put({ key: "corpus", N: corpus.N, totalLen: Math.max(0, (corpus.totalLen || 0) + docLenDelta) });
            }

            // O acervo em memória precisa refletir o dado novo, senão a tela
            // continuaria mostrando o estado antigo até a próxima carga.
            const byId = new Map(changed.map(entry => [entry.item.id, entry.item]));
            archive.forEach((item, position) => {
                const updated = byId.get(item.id);
                if (!updated) return;
                const wasOffloaded = item.__textOffloaded === true;
                archive[position] = Object.assign({}, updated);
                if (wasOffloaded) offloadText(archive[position]);
                hydrationCache.delete(item.id);
                relevanceCache.delete(item.id);
            });
        }
    }

    function canSyncNowDuringPass() {
        return autoSyncEnabled && !archiveLoading && !searchRunning && document.visibilityState === "visible";
    }

    // "force" é usado logo após uma recarga manual: ali o usuário PEDIU a
    // atualização, então a rodada acontece mesmo com a atualização automática
    // desligada, e mesmo com a aba em segundo plano. As demais proteções
    // (nada carregando, nada indexando, trava entre abas) continuam valendo.
    // ---- Horário da última verificação, guardado em disco ----------------
    // Antes isto vivia só numa variável de sessão: bastava recarregar a página
    // para o usuário perder a noção de quão atualizado está o acervo — que é
    // exatamente o momento em que ele quer saber.
    async function persistLastSync(touched) {
        lastSyncAt = new Date();
        try { await db.settings.put({ key: "lastSync", at: lastSyncAt.getTime(), touched: touched || 0 }); }
        catch (_) {}
    }

    async function loadLastSync() {
        try {
            const row = await db.settings.get("lastSync");
            if (row && row.at) lastSyncAt = new Date(row.at);
        } catch (_) {}
    }

    // Leitura relativa: "há 3 min" comunica frescor melhor que um horário seco,
    // e a data completa aparece quando já faz tempo o bastante para importar.
    function describeLastSync(when) {
        if (!when) return "";
        const minutes = Math.floor((Date.now() - when.getTime()) / 60000);
        if (minutes < 1) return "agora mesmo";
        if (minutes < 60) return `há ${minutes} min`;
        const hoje = new Date();
        const mesmoDia = when.toDateString() === hoje.toDateString();
        const hora = when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
        if (mesmoDia) return `hoje às ${hora}`;
        return `${when.toLocaleDateString("pt-BR")} às ${hora}`;
    }

    async function tickAutoSync(force) {
        if (force) {
            if (syncing || archiveLoading || indexing || liveQueryMode || !archive.length) return;
        } else if (!canSyncNow()) return;
        syncing = true;
        renderIndexStatus();
        try {
            await withSyncLock(runSyncPass);
            await persistLastSync(lastSyncTouched);
        } catch (error) {
            lastSyncResult = `falhou (${error.message || error})`;
        } finally {
            syncing = false;
            renderIndexStatus();
        }
    }

    function startAutoSync() {
        if (autoSyncTimer) clearInterval(autoSyncTimer);
        autoSyncTimer = setInterval(tickAutoSync, SYNC_INTERVAL_MS);
        // O texto do horário é relativo ("há 3 min"), então envelhece sozinho na
        // tela. Este segundo tempo só repinta o rótulo — não consulta nada.
        setInterval(() => { if (!syncing && !indexing) renderIndexStatus(); }, 60000);
        document.addEventListener("visibilitychange", () => {
            // Voltar pra aba dispara verificação na hora: é quando o acervo
            // estar atualizado de fato importa.
            if (document.visibilityState === "visible") tickAutoSync();
        });
    }

    // ============================================================
    // ARMAZENAMENTO PERSISTENTE
    // ============================================================
    // Por padrão o IndexedDB é "melhor esforço": sob pressão de espaço, o
    // navegador pode descartar o banco inteiro sem avisar. Depois de horas
    // indexando, perder tudo em silêncio seria o pior desfecho possível — pior
    // que ocupar espaço. Isto pede ao navegador que trate o acervo como
    // permanente. Em geral é concedido sem perguntar nada quando o site já é
    // usado com frequência, que é o caso do SMAX aqui.
    let persistentStorageGranted = null;
    async function requestPersistentStorage() {
        try {
            if (!navigator.storage || !navigator.storage.persist) return null;
            persistentStorageGranted = await navigator.storage.persisted()
                ? true
                : await navigator.storage.persist();
            return persistentStorageGranted;
        } catch (_) { return null; }
    }

    // ============================================================
    // INVENTÁRIO DO QUE ESTÁ SALVO, POR GSE
    // ============================================================
    async function collectStorageInventory() {
        const [syncRows, totalTickets] = await Promise.all([db.syncState.toArray(), db.meta.count()]);
        const groups = [];
        for (const row of syncRows) {
            const groupId = String(row.groupId);
            // GSE_NAME é só cache de sessão (some ao recarregar a página) — só
            // fica populado pra GSE que você já buscou/digitou nesta sessão.
            // O nome de verdade já está gravado em CADA chamado (groupName,
            // vindo da própria resposta do SMAX na hora da carga), então uma
            // GSE indexada há tempos e nunca tocada nesta sessão aparecia com
            // o ID cru mesmo com o nome disponível — só ninguém tinha ido
            // buscar. Um chamado de amostra resolve isso de forma durável.
            const [count, sample] = await Promise.all([
                db.meta.where("groupId").equals(groupId).count(),
                db.meta.where("groupId").equals(groupId).first()
            ]);
            const name = (sample && sample.groupName) || GSE_NAME[groupId] || groupId;
            if (name && name !== groupId) GSE_NAME[groupId] = name; // aquece o cache pro resto da sessão também
            groups.push({
                groupId,
                name,
                count,
                lastCreateTime: Number(row.lastCreateTime) || 0,
                lastUpdate: Number(row.lastUpdate) || 0
            });
        }
        // GSEs que têm chamados gravados mas perderam a linha de sincronização
        // (por exemplo, cancelamento no meio) — melhor mostrar do que esconder,
        // senão o espaço fica ocupado sem aparecer em lugar nenhum.
        const orphanCount = totalTickets - groups.reduce((sum, entry) => sum + entry.count, 0);
        let estimate = null;
        if (navigator.storage && navigator.storage.estimate) {
            try { estimate = await navigator.storage.estimate(); } catch (_) {}
        }
        groups.sort((a, b) => b.count - a.count);
        return { groups, totalTickets, orphanCount: Math.max(0, orphanCount), estimate };
    }

    // Remove uma GSE do disco. A parte trabalhosa não é apagar os chamados: é
    // tirar os números deles de dentro das listas de postings. Deixar para lá
    // não quebraria a busca (sobrariam candidatos que não correspondem a nada e
    // seriam descartados na conferência), mas desperdiçaria o espaço que a
    // remoção deveria liberar e inflaria o "df" do BM25, distorcendo a busca por
    // semelhança. Então a limpeza é feita de verdade, varrendo os postings em
    // blocos, com progresso — pode demorar em acervo grande.
    async function deleteGseFromDisk(groupId, onProgress) {
        const ids = await db.meta.where("groupId").equals(String(groupId)).primaryKeys();
        if (!ids.length) {
            await db.syncState.delete(String(groupId));
            return 0;
        }
        const metaRows = await db.meta.bulkGet(ids);
        const removedDocIds = new Set();
        let removedLen = 0;
        metaRows.forEach(row => {
            if (!row) return;
            if (row.docId != null) removedDocIds.add(row.docId);
            removedLen += Number(row.docLen) || 0;
        });

        await db.meta.bulkDelete(ids);
        await db.texts.bulkDelete(ids);
        await db.pendingIndex.bulkDelete(ids); // senão o reparo tentaria consertar postings de chamado que não existe mais
        await db.syncState.delete(String(groupId));

        // Varre as duas tabelas de postings tirando os docIds removidos.
        const tables = [db.wordPostings, db.stemPostings];
        let scanned = 0;
        const totalTerms = (await db.wordPostings.count()) + (await db.stemPostings.count());
        for (const table of tables) {
            const terms = await table.toCollection().primaryKeys();
            for (let start = 0; start < terms.length; start += 800) {
                const slice = terms.slice(start, start + 800);
                const rows = await table.bulkGet(slice);
                const toWrite = [];
                const toDrop = [];
                rows.forEach(row => {
                    if (!row || !row.ids || !row.ids.length) return;
                    let hits = 0;
                    for (let i = 0; i < row.ids.length; i++) if (removedDocIds.has(row.ids[i])) hits++;
                    if (!hits) return; // termo intocado: não regrava à toa
                    if (hits === row.ids.length) { toDrop.push(row.term); return; } // termo só existia nesta GSE
                    const keptIds = new Uint32Array(row.ids.length - hits);
                    const keptTfs = row.tfs ? new Uint16Array(row.ids.length - hits) : null;
                    let out = 0;
                    for (let i = 0; i < row.ids.length; i++) {
                        if (removedDocIds.has(row.ids[i])) continue;
                        keptIds[out] = row.ids[i];
                        if (keptTfs) keptTfs[out] = row.tfs[i];
                        out++;
                    }
                    toWrite.push(keptTfs ? { term: row.term, ids: keptIds, tfs: keptTfs } : { term: row.term, ids: keptIds });
                });
                if (toWrite.length) await table.bulkPut(toWrite);
                if (toDrop.length) await table.bulkDelete(toDrop);
                scanned += slice.length;
                if (onProgress) onProgress(scanned, totalTerms);
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // Corrige as estatísticas globais do BM25 pra refletir o que sobrou.
        const corpus = await db.settings.get("corpus");
        if (corpus) {
            await db.settings.put({
                key: "corpus",
                N: Math.max(0, (corpus.N || 0) - removedDocIds.size),
                totalLen: Math.max(0, (corpus.totalLen || 0) - removedLen)
            });
        }

        vocabularyCache = null;
        corpusStats = null;
        hydrationCache.clear();
        relevanceCache.clear();
        return removedDocIds.size;
    }

    // Apaga tudo que está salvo em disco e força a próxima carga a ser
    // "primeira vez". Útil pra testar e pra quando os chamados já indexados
    // mudaram de status (a sincronização incremental só traz chamados novos).
    async function resetIndex() {
        await Promise.all([db.meta.clear(), db.texts.clear(), db.wordPostings.clear(), db.stemPostings.clear(), db.settings.clear(), db.syncState.clear(), db.pendingIndex.clear()]);
        vocabularyCache = null;
        corpusStats = null;
        hydrationCache.clear();
        relevanceCache.clear();
        indexReady = false;
        textInMemory = true;
        forceFullReindex = true;
        loadedSignature = null; // obriga a próxima pesquisa a recarregar do SMAX
        renderIndexStatus();
    }

    // ============================================================
    // BUSCA SEM GSE (só na aba Estatística)
    // ============================================================
    // A carga normal é ancorada em GSE porque é assim que o índice em disco é
    // organizado: marca d'água, cobertura de período e sincronização automática
    // são todas por GSE. Uma busca por pessoa não tem essa âncora — então ela é
    // tratada como CONSULTA AO VIVO: responde do servidor, mostra na tela e não
    // grava nada. Isso mantém a contabilidade de cobertura intacta, que é o que
    // consertamos depois do bug de período ampliado.
    function ignoringGse() {
        return !!(ui && ui.ignoreGse && ui.ignoreGse.checked && searchMode === "stats");
    }

    // A pessoa precisa estar RESOLVIDA (escolhida no combobox, com ID), não só
    // digitada: sem ID o filtro não vai ao servidor, e a busca viraria uma
    // varredura do acervo inteiro.
    function hasResolvedPersonFilter() {
        return !!((ui.specialistCombo && ui.specialistCombo.getSelected().length) || (ui.requestedForCombo && ui.requestedForCombo.getSelected().length));
    }

    function selectedGseIds() {
        const base = Array.from(ui.gseList.querySelectorAll("input[data-gse]:checked")).map(input => input.value);
        const extra = ui.extraGseCombo ? ui.extraGseCombo.getSelected().map(option => option.value) : [];
        return Array.from(new Set(base.concat(extra)));
    }

    // "Assinatura" do que está carregado — tudo que muda o que precisa vir do
    // servidor (GSEs, pessoa filtrada, se Discussão entra no layout, período).
    // O período agora entra aqui porque também restringe a consulta ao SMAX —
    // usamos os valores dos CAMPOS (não o horário resolvido), senão "últimos
    // N dias" invalidaria o cache a cada segundo só por o relógio ter andado.
    // Filtro de texto/VIP continuam de fora — esses sim são 100% em cima do
    // que já está em memória, sem precisar recarregar nada.
    function computeLoadSignature() {
        const gseIds = ignoringGse() ? "SEM-GSE" : selectedGseIds().slice().sort().join(",");
        const specialistId = ui.specialistCombo ? ui.specialistCombo.getSelected().map(o => o.value).sort().join(",") : "";
        const requesterId = ui.requestedForCombo ? ui.requestedForCombo.getSelected().map(o => o.value).sort().join(",") : "";
        const discussion = ui.fieldDiscussion.checked ? "1" : "0";
        const period = `${ui.dateMode.value}|${ui.dateDays.value}|${ui.dateFrom.value}|${ui.dateTo.value}`;
        return `${gseIds}|${specialistId}|${requesterId}|${discussion}|${period}`;
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
            if (match[1] != null) output.push({ type: "TERM", value: match[1], phrase: true });
            else if (raw === "(" || raw === ")") output.push({ type: raw });
            else if (["AND", "E"].includes(upper)) output.push({ type: "AND" });
            else if (["OR", "OU"].includes(upper)) output.push({ type: "OR" });
            else if (["NOT", "NAO", "NÃO"].includes(upper)) output.push({ type: "NOT" });
            else if (raw.startsWith("-") && raw.length > 1) output.push({ type: "NOT" }, { type: "TERM", value: raw.slice(1), phrase: false });
            else output.push({ type: "TERM", value: raw, phrase: false });
        }
        // Termo seguido de NÃO/"-palavra" SEM operador explícito assume E (não
        // o padrão OU) — "certificado NÃO digital" tem que filtrar "certificado
        // E NÃO digital", não "certificado OU NÃO digital" (que praticamente
        // sempre dá match em tudo e não exclui nada, contra a intuição de quem
        // pesquisa). Dois termos soltos sem NÃO continuam com OU implícito.
        const withDefault = [];
        for (const token of output) {
            const previous = withDefault[withDefault.length - 1];
            if (previous && ["TERM", ")"].includes(previous.type) && ["TERM", "(", "NOT"].includes(token.type)) {
                withDefault.push({ type: token.type === "NOT" ? "AND" : defaultJoin });
            }
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
    // VALIDADOR DA EXPRESSÃO DE BUSCA (aba Termos)
    // Reaproveita o MESMO tokenize() que a busca de verdade usa — a
    // explicação mostrada nunca pode divergir do que vai ser realmente
    // pesquisado. compileMatcher/toRpn são tolerantes demais pra servir de
    // validador sozinhos (uma expressão tipo "certificado E" não lança erro
    // nenhum ali, só resulta em zero resultados sem explicação) — por isso
    // um parser dedicado, que entende a gramática (frase entre aspas, E/OU/
    // NÃO, parênteses, atalho "-palavra") e aponta exatamente onde ela para
    // de fazer sentido.
    function parseQueryExpression(tokens) {
        let pos = 0;
        const peek = () => tokens[pos];
        function atom() {
            const t = peek();
            if (!t) throw new Error("Faltou um termo depois do último operador — a expressão terminou antes da hora.");
            if (t.type === "NOT") { pos++; return { type: "NOT", value: atom() }; }
            if (t.type === "(") {
                pos++;
                const inner = orExpr();
                if (!peek() || peek().type !== ")") throw new Error("Há um parêntese aberto “(” sem fechar.");
                pos++;
                return inner;
            }
            if (t.type === "TERM") { pos++; return t; }
            if (t.type === ")") throw new Error("Há um parêntese fechando “)” sem um “(” correspondente.");
            throw new Error("A expressão não faz sentido nesse ponto — revise a sintaxe.");
        }
        function andExpr() { let n = atom(); while (peek() && peek().type === "AND") { pos++; n = { type: "AND", left: n, right: atom() }; } return n; }
        function orExpr() { let n = andExpr(); while (peek() && peek().type === "OR") { pos++; n = { type: "OR", left: n, right: andExpr() }; } return n; }
        const result = orExpr();
        if (pos !== tokens.length) throw new Error("Sobrou algo sem sentido no fim da expressão.");
        return result;
    }

    // Achata cadeias do MESMO operador: "A E B E C" é analisado como
    // ((A E B) E C), mas E e OU são associativos, então esse aninhamento não
    // muda o resultado — é só a forma da árvore. Mostrá-lo com parênteses
    // sugeria um agrupamento que o usuário não escreveu e levava a crer que a
    // precedência tinha sido alterada. Aqui a cadeia vira uma lista plana.
    function flattenSameOperator(node) {
        if (!node || (node.type !== "AND" && node.type !== "OR")) return [node];
        const parts = [];
        const walk = current => {
            if (current && current.type === node.type) { walk(current.left); walk(current.right); }
            else parts.push(current);
        };
        walk(node);
        return parts;
    }

    function describeQueryExpression(node, nested) {
        if (node.type === "TERM") return node.phrase ? `a expressão exata “${node.value}”` : `o termo “${node.value}”`;
        if (node.type === "NOT") return `NÃO contenham ${describeQueryExpression(node.value, true)}`;
        const label = node.type === "AND" ? "E" : "OU";
        const parts = flattenSameOperator(node);
        // Parênteses só quando um ramo mistura o outro operador — que é
        // exatamente onde a precedência importa de verdade.
        const text = parts.map(part => {
            const mistura = part && (part.type === "AND" || part.type === "OR") && part.type !== node.type;
            return describeQueryExpression(part, mistura);
        }).join(` ${label} `);
        return nested ? `(${text})` : text;
    }

    // { valid: true/false/null (null = campo vazio, estado neutro), message }
    function validateQuerySyntax(query, mode) {
        const trimmed = query.trim();
        if (!trimmed) return { valid: null, message: "Digite um termo ou expressão pra ver como a busca será interpretada." };
        if (mode === "exact") return { valid: true, message: `Pesquisará a expressão exata “${trimmed.replace(/^"|"$/g, "")}”.` };
        const quoteCount = (query.match(/"/g) || []).length;
        if (quoteCount % 2 !== 0) return { valid: false, message: 'Existem aspas abertas e não fechadas — falta uma aspa (") pra fechar a expressão exata.' };
        try {
            const tokens = tokenize(query, "OR");
            if (!tokens.length) return { valid: null, message: "Digite um termo ou expressão pra ver como a busca será interpretada." };
            const ast = parseQueryExpression(tokens);
            const message = ast.type === "NOT"
                ? `Pesquisará solicitações que NÃO contenham ${describeQueryExpression(ast.value, true)}.`
                : `Pesquisará solicitações que contenham ${describeQueryExpression(ast, false)}.`;

            // Aspas DENTRO de aspas são ambíguas: `"A "B" C"` tanto pode ser uma
            // frase única contendo aspas quanto frases separadas por operadores.
            // A detecção conta os tokens de frase (phrase:true) e compara com o
            // total de aspas na entrada: cada frase consome exatamente 2 aspas,
            // então se sobram, é sinal de aspas aninhadas (colagem de texto que
            // já trazia aspas no meio). Se batem, todas são estruturais — ex.:
            // `"Atp" e "Automação"` tem 2 frases e 4 aspas, tudo pareado, ok.
            const phraseCount = tokens.filter(t => t.type === "TERM" && t.phrase).length;
            const quoteCount = (trimmed.match(/"/g) || []).length;
            if (quoteCount > 0 && quoteCount !== phraseCount * 2) {
                return {
                    valid: true,
                    message: `${message} ⚠ Como há aspas dentro da expressão, ela foi dividida em partes. Se quer procurar o texto inteiro, exatamente como está, troque "Qualquer palavra" por "Expressão exata".`
                };
            }
            return { valid: true, message };
        } catch (error) {
            return { valid: false, message: `Erro de sintaxe: ${error.message}` };
        }
    }

    // "Pesquisar" fica desabilitado tanto durante o carregamento do acervo
    // (archiveLoading) quanto com erro de sintaxe no campo — as duas causas
    // são independentes, então sempre recalcula combinando as duas em vez de
    // um lado sobrescrever o outro.
    let queryHasSyntaxError = false;
    function refreshSearchButtonState() {
        ui.search.disabled = archiveLoading || queryHasSyntaxError || searchRunning;
    }

    function renderQueryValidator() {
        const result = validateQuerySyntax(ui.query.value, ui.mode.value);
        queryHasSyntaxError = result.valid === false;
        refreshSearchButtonState();
        ui.query.classList.remove("query-valid", "query-invalid");
        if (result.valid === true) ui.query.classList.add("query-valid");
        else if (result.valid === false) ui.query.classList.add("query-invalid");
        ui.queryValidator.hidden = false;
        ui.queryValidator.className = "query-validator " + (result.valid === true ? "valid" : result.valid === false ? "invalid" : "typing");
        const icon = result.valid === true
            ? '<svg viewBox="0 0 24 24"><path d="M5 13l4.5 4.5L19 8"></path></svg>'
            : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16v.01"></path></svg>';
        ui.queryValidator.innerHTML = icon + `<span>${escapeHtml(result.message)}</span>`;
        return result.valid !== false;
    }

    // Enquanto o campo está com foco e você digita, NÃO valida a cada tecla
    // — só mostra um estado neutro de "digitando" pra não ficar piscando erro
    // no meio da frase (e não deixa "Pesquisar" travado por um erro que já
    // pode ter sido corrigido). A validação de verdade roda ao sair do campo
    // (blur), mudar "Qualquer palavra"/"Expressão exata", apertar Enter ou
    // clicar em "Pesquisar" — esses dois últimos revalidam explicitamente
    // antes de agir, pra nunca disparar uma busca com sintaxe inválida.
    function showQueryTyping() {
        queryHasSyntaxError = false;
        refreshSearchButtonState();
        ui.query.classList.remove("query-valid", "query-invalid");
        ui.queryValidator.hidden = false;
        ui.queryValidator.className = "query-validator typing";
        ui.queryValidator.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.3" fill="currentColor" stroke="none"></circle></svg><span>Digitando... a verificação roda quando você sair do campo.</span>';
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

    // Status/Status Operacional/Unidade/Pessoas agora são multi-seleção (combobox de
    // chips) — o item bate se NENHUM valor estiver marcado (filtro vazio =
    // não filtra) ou se bater com QUALQUER UM dos marcados (OU lógico).
    function multiValueMatches(itemValue, selectedOptions, ignoreCase, ignoreAccents) {
        if (!selectedOptions || !selectedOptions.length) return true;
        const normalizedItem = normalize(itemValue, ignoreCase, ignoreAccents);
        return selectedOptions.some(option => normalize(option.value, ignoreCase, ignoreAccents) === normalizedItem);
    }

    // Extraído pra ser reaproveitado tanto pelo período de abertura
    // (data de criação) quanto pelo novo filtro de Data de Envio para
    // Aceite/Solução — mesmas 6 opções de critério nos dois.
    function dateFilterMatches(timestamp, mode, daysValue, fromValue, toValue) {
        if (mode === "any") return true;
        const value = Number(timestamp);
        if (!Number.isFinite(value)) return false;
        if (mode === "days") {
            const days = Number(daysValue);
            if (!days || days <= 0) return true;
            return value >= Date.now() - days * 86400000;
        }
        const from = parseDateInput(fromValue, false);
        const to = parseDateInput(toValue, true);
        if (mode === "on") return from != null && value >= from && value <= parseDateInput(fromValue, true);
        if (mode === "after") return from != null && value >= from;
        if (mode === "before") return to != null && value <= to;
        if (mode === "between") return from != null && to != null && value >= from && value <= to;
        return true;
    }

    // "Passou por GSE" — consulta o audit de cada solicitacao em lotes
    // paralelos e cacheia o resultado no item pra nao repetir chamadas.
    const HISTORY_GSE_FIELDS = ["ExpertGroup", "AssignedToGroup", "ServiceDeskGroup"];
    const HISTORY_BATCH_SIZE = 15;

    async function fetchHistoryGses(itemId) {
        const params = new URLSearchParams({ changeType: "ALL", entityId: itemId, size: "250", skip: "0" });
        const data = await fetchJson(`${getRestBase()}/audit/ems-history-service/Request?${params}`);
        const gseIds = new Set();
        for (const entry of (data.results || [])) {
            const cp = entry.changeProperties || {};
            for (const field of HISTORY_GSE_FIELDS) {
                if (cp[field]) {
                    if (cp[field].newValue) gseIds.add(String(cp[field].newValue));
                    if (cp[field].oldValue) gseIds.add(String(cp[field].oldValue));
                }
            }
        }
        return gseIds;
    }

    // exclude=false (padrão): mantém quem passou por qualquer uma das GSEs
    // marcadas (OU inclusivo). exclude=true: inverte — mantém só quem NÃO
    // passou por nenhuma delas. Item sem histórico conhecido (nunca buscado
    // com sucesso) conta como "não passou", nos dois modos — é o mesmo
    // padrão seguro de antes, só espelhado pro modo excludente.
    async function applyHistoryGseFilter(items, targetGseIds, exclude) {
        if (!targetGseIds.length) return items;
        const targetSet = new Set(targetGseIds);
        const needsFetch = items.filter(item => !item._historyGses);
        if (needsFetch.length && ui.historyGseProgress) {
            ui.historyGseProgress.hidden = false;
            ui.historyGseProgressText.textContent = `Verificando histórico: 0/${needsFetch.length}...`;
        }
        let fetched = 0;
        for (let i = 0; i < needsFetch.length; i += HISTORY_BATCH_SIZE) {
            const batch = needsFetch.slice(i, i + HISTORY_BATCH_SIZE);
            const results = await Promise.allSettled(batch.map(item => fetchHistoryGses(item.id)));
            results.forEach((result, idx) => {
                batch[idx]._historyGses = result.status === "fulfilled" ? result.value : new Set();
            });
            fetched += batch.length;
            if (ui.historyGseProgressText) {
                ui.historyGseProgressText.textContent = `Verificando histórico: ${fetched}/${needsFetch.length}...`;
            }
        }
        if (ui.historyGseProgress) ui.historyGseProgress.hidden = true;
        return items.filter(item => {
            const gses = item._historyGses;
            let passedThrough = false;
            if (gses && gses.size) { for (const id of targetSet) { if (gses.has(id)) { passedThrough = true; break; } } }
            return exclude ? !passedThrough : passedThrough;
        });
    }

    function advancedFiltersMatch(item) {
        const ignoreCase = ui.ignoreCase.checked;
        const ignoreAccents = ui.ignoreAccents.checked;
        if (ui.requestedForCombo && !multiValueMatches(item.requestedForId, ui.requestedForCombo.getSelected(), ignoreCase, ignoreAccents)) return false;
        if (ui.specialistCombo && !multiValueMatches(item.assignedSpecialistId, ui.specialistCombo.getSelected(), ignoreCase, ignoreAccents)) return false;
        if (ui.vipOnly.checked && !item.isVip) return false;
        if (ui.globalOnly && ui.globalOnly.checked && !item.isGlobal) return false;
        if (ui.statusCombo && !multiValueMatches(item.status, ui.statusCombo.getSelected(), ignoreCase, ignoreAccents)) return false;
        if (ui.statusOperacionalCombo && !multiValueMatches(item.statusOperacional, ui.statusOperacionalCombo.getSelected(), ignoreCase, ignoreAccents)) return false;
        if (ui.unidadeCombo && !multiValueMatches(item.unidade, ui.unidadeCombo.getSelected(), ignoreCase, ignoreAccents)) return false;
        if (!dateFilterMatches(item.created, ui.dateMode.value, ui.dateDays.value, ui.dateFrom.value, ui.dateTo.value)) return false;
        if (ui.solutionDateMode && !dateFilterMatches(item.solutionDate, ui.solutionDateMode.value, ui.solutionDateDays.value, ui.solutionDateFrom.value, ui.solutionDateTo.value)) return false;
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

    function updateSolutionDateControls() {
        const mode = ui.solutionDateMode.value;
        ui.solutionDateFromWrap.hidden = !["on", "after", "between"].includes(mode);
        ui.solutionDateToWrap.hidden = !["before", "between"].includes(mode);
        ui.solutionDateDaysWrap.hidden = mode !== "days";
        ui.solutionDateFromLabel.textContent = mode === "between" ? "Data inicial" : mode === "after" ? "A partir de" : "Data";
        ui.solutionDateToLabel.textContent = mode === "between" ? "Data final" : "Até";
    }

    function insertOperator(value) {
        const input = ui.query, start = input.selectionStart == null ? input.value.length : input.selectionStart, end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
        if (value === '""') { input.value = input.value.slice(0, start) + '"' + input.value.slice(start, end) + '"' + input.value.slice(end); input.setSelectionRange(start + 1, end + 1); }
        else if (value === "()") { input.value = input.value.slice(0, start) + "(" + input.value.slice(start, end) + ")" + input.value.slice(end); input.setSelectionRange(start + 1, end + 1); }
        else { input.value = input.value.slice(0, start) + value + input.value.slice(end); input.setSelectionRange(start + value.length, start + value.length); }
        input.focus();
        showQueryTyping();
    }

    // ============================================================
    // MULTI-SELEÇÃO DE PESSOA (Solicitado para / Designado Especialista)
    // Visual e fluxo IGUAIS ao autocomplete de campo único de antes — busca,
    // aparece um menu flutuante de sugestões, escolhe uma. A diferença: cada
    // escolha ENTRA numa lista (chips abaixo do campo) em vez de substituir a
    // anterior, e o campo já limpa e mantém o foco pronto pra próxima busca —
    // é assim que o uso real acontece (busca um nome, escolhe, busca outro
    // nome, escolhe de novo), não marcando vários de uma lista só. Clicar de
    // novo numa sugestão já escolhida remove (mesmo efeito do × no chip).
    // getSelected()/setSelected()/onChange() têm a mesma forma dos
    // comboboxes de GSE/Status/Unidade — quem consome (personConstraintClause,
    // computeLoadSignature, advancedFiltersMatch etc.) não precisa saber qual
    // widget está por trás.
    // Sem restrição por GSE nos dois campos: nem o especialista é restrito
    // (alguns colegas não têm PersonToGroup corretamente cadastrado, ficariam
    // de fora; a matrícula no rótulo já diferencia homônimos sem precisar
    // dessa restrição).
    // ============================================================
    function installPersonMultiAutocomplete(root, shadow) {
        const MIN_CHARS = 2;
        const DEBOUNCE_MS = 320;
        const input = root.querySelector(".person-search-input");
        const menu = root.querySelector(".specialist-menu");
        const chipsWrap = root.querySelector(".person-chips");

        let selected = [];
        let timer = null, controller = null, options = [], active = -1, sequence = 0;
        const changeHandlers = [];
        function notifyChange() { changeHandlers.forEach(fn => { try { fn(); } catch (_) {} }); }

        function isPicked(id) { return selected.some(option => option.value === id); }

        function renderChips() {
            chipsWrap.innerHTML = "";
            selected.forEach(option => {
                const chip = document.createElement("span");
                chip.className = "combo-chip";
                const span = document.createElement("span");
                span.textContent = option.name;
                span.title = option.label; // nome completo + matrícula/Interno-Externo/VIP no hover
                chip.appendChild(span);
                const rm = document.createElement("button");
                rm.type = "button"; rm.textContent = "×"; rm.title = "Remover";
                rm.addEventListener("click", () => { selected = selected.filter(o => o.value !== option.value); renderChips(); notifyChange(); });
                chip.appendChild(rm);
                chipsWrap.appendChild(chip);
            });
        }

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
            if (!persons.length) { showMessage("Nenhuma pessoa localizada com esse nome."); return; }
            menu.innerHTML = "";
            persons.forEach((person, index) => {
                const button = document.createElement("button");
                button.type = "button";
                const picked = isPicked(person.id);
                button.className = "specialist-option" + (index === active ? " active" : "") + (picked ? " picked" : "");
                button.dataset.index = String(index);
                // Contas externas (cidadãos) guardam o CPF/documento tanto em
                // Upn quanto em EmployeeNumber — não é matrícula funcional de
                // verdade. Detectamos isso pelo Upn ser só dígitos (username
                // de servidor nunca é puramente numérico) — é o mesmo sinal
                // usado tanto pro rótulo (ID em vez de Matrícula) quanto pra
                // tag "Externo".
                const looksExternal = /^\d+$/.test(person.upn || "");
                const strong = document.createElement("strong");
                strong.textContent = person.name + (picked ? " ✓" : "");
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
            const looksExternal = /^\d+$/.test(person.upn || "");
            const idLabel = looksExternal ? "ID" : "Mat.";
            const qualifiers = [looksExternal ? "Externo" : "Interno"];
            if (person.isVip) qualifiers.push("VIP");
            const detail = person.employeeNumber ? `${idLabel} ${person.employeeNumber}, ${qualifiers.join(", ")}` : qualifiers.join(", ");
            const label = `${person.name} (${detail})`;
            if (isPicked(person.id)) selected = selected.filter(o => o.value !== person.id);
            else selected.push({ value: person.id, label, name: person.name });
            renderChips();
            notifyChange();
            input.value = "";
            closeMenu();
            input.focus();
        }

        async function searchPersons(query) {
            if (controller) controller.abort();
            controller = new AbortController();
            const current = ++sequence;
            showMessage('<span class="specialist-spinner"></span>Consultando pessoas no SMAX...');
            const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
            const nameClauses = words.map(word => `(PersonalDetails wordstartswith ('${word.replace(/'/g, "''")}'))`).join(" and ");
            const params = new URLSearchParams({
                filter: `(${nameClauses})`, layout: "Name,Upn,IsDeleted,Email,EmployeeNumber,IsVIP", meta: "totalCount", order: "Name asc", size: "30"
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
        shadow.addEventListener("mousedown", event => { if (!event.composedPath().includes(root)) closeMenu(); });

        renderChips();
        return {
            getSelected: () => selected.slice(),
            setSelected: list => { selected = (list || []).slice(); renderChips(); notifyChange(); },
            onChange: fn => { if (typeof fn === "function") changeHandlers.push(fn); }
        };
    }

    // ============================================================
    // COMBOBOX COM MÚLTIPLA SELEÇÃO (GSE / Status / Status Operacional /
    // Unidade-Comarca) — marca/desmarca vários sem o painel fechar sozinho,
    // chips no campo, "Desmarcar todos". Um componente só, reaproveitado
    // pelos 4 campos via installGseCombobox/installLocationCombobox/
    // installStaticCombobox abaixo (cada um só monta o "config" certo).
    // config = { mode: "static", values: () => [{value,label}] }
    //       ou { mode: "search", minChars, searchFn: async (query, signal) => [{value,label}], onSelect, onDeselect }
    // Retorna { getSelected(), setSelected(list) } pra quem instalou.
    // ============================================================
    function installMultiCombobox(root, shadow, config) {
        const box = root.querySelector(".combo-box");
        const placeholder = root.querySelector(".combo-placeholder");
        const panel = root.querySelector(".combo-panel");
        const searchInput = root.querySelector(".combo-search input");
        const optionsEl = root.querySelector(".combo-options");
        const countEl = root.querySelector(".combo-count");
        const clearBtn = root.querySelector(".combo-clear");
        const doneBtn = root.querySelector(".combo-done");

        let selected = [];
        let currentList = [];
        let searchTimer = null, searchController = null, searchSequence = 0;

        function isSelected(value) { return selected.some(option => option.value === value); }

        let chipsExpanded = false;
        function renderChips() {
            root.querySelectorAll(".combo-chip, .combo-chip-more").forEach(el => el.remove());
            placeholder.hidden = !!selected.length;
            // Recolhido mostra os 3 primeiros; clicar em "+N" expande pra ver
            // TODOS os selecionados (antes o "+N" era só um número, sem como ver
            // quais eram os demais).
            const limit = chipsExpanded ? selected.length : 3;
            selected.slice(0, limit).forEach(option => {
                const chip = document.createElement("span");
                chip.className = "combo-chip";
                const span = document.createElement("span");
                span.textContent = option.label;
                span.title = option.label; // nome completo no hover — o chip corta com "..." em listas grandes/nomes longos
                chip.appendChild(span);
                const rm = document.createElement("button");
                rm.type = "button"; rm.textContent = "×"; rm.title = "Remover";
                rm.addEventListener("click", event => { event.stopPropagation(); toggle(option); });
                chip.appendChild(rm);
                box.insertBefore(chip, box.querySelector(".combo-caret"));
            });
            if (selected.length > 3) {
                const more = document.createElement("span");
                more.className = "combo-chip-more";
                more.textContent = chipsExpanded ? "mostrar menos" : `+${selected.length - 3}`;
                more.title = chipsExpanded ? "Recolher" : "Ver todas as GSEs selecionadas";
                more.addEventListener("click", event => { event.stopPropagation(); chipsExpanded = !chipsExpanded; renderChips(); });
                box.insertBefore(more, box.querySelector(".combo-caret"));
            } else {
                chipsExpanded = false;
            }
        }

        const changeHandlers = [];
        function notifyChange() { changeHandlers.forEach(fn => { try { fn(); } catch (_) {} }); }

        function toggle(option) {
            const idx = selected.findIndex(o => o.value === option.value);
            if (idx >= 0) { selected.splice(idx, 1); if (config.onDeselect) config.onDeselect(option); }
            else { selected.push(option); if (config.onSelect) config.onSelect(option); }
            renderChips();
            renderOptionsList(currentList);
            notifyChange();
        }

        function renderOptionsList(list) {
            currentList = list;
            countEl.textContent = `${selected.length} selecionado(s)`;
            if (!list.length) {
                const needsQuery = config.mode === "search" && searchInput.value.trim().length < (config.minChars || 2);
                optionsEl.innerHTML = `<div class="combo-empty">${needsQuery ? "Digite pra buscar..." : "Nenhum resultado."}</div>`;
                return;
            }
            optionsEl.innerHTML = "";
            list.forEach(option => {
                const label = document.createElement("label");
                label.className = "combo-option";
                label.innerHTML = `<input type="checkbox"${isSelected(option.value) ? " checked" : ""}><span title="${escapeHtml(option.label)}">${escapeHtml(option.label)}</span>`;
                label.querySelector("input").addEventListener("change", () => toggle(option));
                optionsEl.appendChild(label);
            });
        }

        function filterStatic(query) {
            const all = config.values();
            const q = normalize(query.trim(), true, true);
            return q ? all.filter(option => normalize(option.label, true, true).includes(q)) : all;
        }

        async function refreshOptions() {
            if (config.mode === "static") { renderOptionsList(filterStatic(searchInput.value)); return; }
            const query = searchInput.value.trim();
            if (query.length < (config.minChars || 2)) { renderOptionsList([]); return; }
            if (searchController) searchController.abort();
            searchController = new AbortController();
            const current = ++searchSequence;
            optionsEl.innerHTML = '<div class="combo-empty"><span class="specialist-spinner"></span>Consultando...</div>';
            try {
                const results = await config.searchFn(query, searchController.signal);
                if (current !== searchSequence) return;
                renderOptionsList(results);
            } catch (error) {
                if (error.name === "AbortError") return;
                if (current !== searchSequence) return;
                optionsEl.innerHTML = `<div class="combo-empty">Não foi possível consultar: ${escapeHtml(error.message || String(error))}</div>`;
            }
        }

        function openPanel() { box.classList.add("open"); panel.classList.add("open"); refreshOptions(); searchInput.focus(); }
        function closePanel() { box.classList.remove("open"); panel.classList.remove("open"); }

        box.addEventListener("click", () => { panel.classList.contains("open") ? closePanel() : openPanel(); });
        doneBtn.addEventListener("click", event => { event.stopPropagation(); closePanel(); });
        clearBtn.addEventListener("click", event => {
            event.stopPropagation();
            if (config.onDeselect) selected.forEach(option => config.onDeselect(option));
            selected = [];
            renderChips();
            refreshOptions();
        });
        searchInput.addEventListener("input", () => {
            if (config.mode === "static") { refreshOptions(); return; }
            clearTimeout(searchTimer);
            searchTimer = setTimeout(refreshOptions, 320);
        });
        searchInput.addEventListener("click", event => event.stopPropagation());
        searchInput.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); closePanel(); } });
        shadow.addEventListener("mousedown", event => { if (!event.composedPath().includes(root)) closePanel(); });

        renderChips();
        return {
            getSelected: () => selected.slice(),
            setSelected: list => { selected = (list || []).slice(); renderChips(); if (panel.classList.contains("open")) refreshOptions(); notifyChange(); },
            onChange: fn => { if (typeof fn === "function") changeHandlers.push(fn); }
        };
    }

    // "Outras GSEs" — busca a entidade PersonGroup (confirmada ao vivo;
    // "Group" dá "operação não permitida", o nome certo é PersonGroup).
    // selectedGseIds() lê o retorno de getSelected() direto, sem precisar de
    // nenhuma lista/checkbox separada na tela.
    function installGseCombobox(root, shadow) {
        return installMultiCombobox(root, shadow, {
            mode: "search", minChars: 2,
            searchFn: async (query, signal) => {
                const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
                const wordClauses = words.map(word => `(Name wordstartswith ('${word.replace(/'/g, "''")}'))`).join(" and ");
                const params = new URLSearchParams({
                    filter: `((Status = 'Active' or Status = null) and (${wordClauses}))`,
                    layout: "Name", order: "Name asc", size: "30"
                });
                const payload = await fetchJson(`${getRestBase()}/ems/PersonGroup?${params}`, { signal });
                const byId = new Map();
                (Array.isArray(payload.entities) ? payload.entities : []).forEach(entity => {
                    const p = entity.properties || {};
                    const id = String(p.Id || ""), name = String(p.Name || "").trim();
                    if (id && name && !byId.has(id)) { byId.set(id, { value: id, label: name }); GSE_NAME[id] = name; }
                });
                return Array.from(byId.values()).sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
            }
        });
    }

    // Unidade/Comarca = "Local de divulgação" no formulário (confirmado ao
    // vivo) — entidade Location, campo de busca LocationDetails, só
    // localizações ativas. value === label (o próprio DisplayName).
    function installLocationCombobox(root, shadow) {
        return installMultiCombobox(root, shadow, {
            mode: "search", minChars: 2,
            searchFn: async (query, signal) => {
                const words = query.split(/\s+/).filter(Boolean).slice(0, 4);
                const wordClauses = words.map(word => `(LocationDetails wordstartswith ('${word.replace(/'/g, "''")}'))`).join(" and ");
                const params = new URLSearchParams({
                    filter: `((Active = 'true' or Active = null) and (${wordClauses}))`,
                    layout: "DisplayName", order: "DisplayName asc", size: "100"
                });
                const payload = await fetchJson(`${getRestBase()}/ems/Location?${params}`, { signal });
                const names = Array.from(new Set(
                    (Array.isArray(payload.entities) ? payload.entities : [])
                        .map(entity => String((entity.properties || {}).DisplayName || "").trim())
                        .filter(Boolean)
                ));
                return names.sort((a, b) => a.localeCompare(b, "pt-BR")).map(name => ({ value: name, label: name }));
            }
        });
    }

    // Status / Status Operacional — sem rede nenhuma: STATUS_LABELS/
    // STATUS_OPERACIONAL_LABELS já são a lista completa e confirmada ao
    // vivo (capturada direto do <select> nativo do formulário de chamado).
    function installStaticCombobox(root, shadow, labelMap) {
        const allOptions = Object.keys(labelMap)
            .map(code => ({ value: code, label: labelMap[code] }))
            .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
        return installMultiCombobox(root, shadow, { mode: "static", values: () => allOptions });
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

    // ------------------------------------------------------------
    // BM25 lendo do disco (usado quando o índice está pronto)
    // ------------------------------------------------------------
    // Mesma fórmula do original — o que muda é de onde vêm os números:
    //   df  ....... o tamanho da lista de postings do termo (nada guardado à parte)
    //   tf  ....... do campo "terms" gravado em cada chamado
    //   docLen .... do campo "docLen" de cada chamado
    //   N/avgDocLen  da linha "corpus" da tabela settings
    // Assim nenhum Map gigante de postings é montado na memória.
    // Agora a consulta lê UMA linha por termo da pergunta (tipicamente ~10),
    // em vez de uma linha por chamado candidato (que eram milhares na v2). A
    // frequência de cada termo em cada chamado vem junto da própria lista.
    async function computeBm25ScoresFromDisk(queryTerms, docLenByDocId) {
        const uniqueTerms = Array.from(new Set(queryTerms));
        const [{ N, avgDocLen }, rows] = await Promise.all([
            getCorpusStats(),
            db.stemPostings.bulkGet(uniqueTerms)
        ]);
        const scores = new Map(); // docId -> pontuação
        const termWeights = new Map();
        if (!N) return { scores, termWeights };

        rows.forEach((row, index) => {
            if (!row || !row.ids || !row.ids.length) return;
            // O "df" é simplesmente o tamanho da lista — não precisa mais ser
            // guardado à parte, o que também elimina o risco de ele sair de
            // sincronia com os postings depois de uma carga incremental.
            const df = row.ids.length;
            const idf = Math.max(0.01, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
            termWeights.set(uniqueTerms[index], idf);
            for (let position = 0; position < row.ids.length; position++) {
                const docId = row.ids[position];
                const tf = row.tfs ? row.tfs[position] : 1;
                const docLen = docLenByDocId.get(docId) || 0;
                const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / (avgDocLen || 1)));
                scores.set(docId, (scores.get(docId) || 0) + idf * (tf * (BM25_K1 + 1)) / (denom || 1));
            }
        });
        return { scores, termWeights };
    }

    // Versão da busca por semelhança que usa o índice em disco. Diferente da
    // original, pontua por ID (não por posição no array), porque o acervo em
    // memória agora guarda só os campos estruturados.
    async function runSemanticSearchIndexed(text) {
        searchMode = "semantic";
        lastSearchIncludedDiscussion = archiveIncludesDiscussion;
        const queryTerms = tokenizeForIndex(text);
        if (!queryTerms.length) { setStatus("Não encontramos termos relevantes nesse texto (tente descrever com mais detalhes).", "warning"); return; }
        // O tamanho de cada chamado (em termos) já veio junto dos metadados, na
        // memória — o BM25 não precisa ir ao disco buscar isso.
        const docLenByDocId = new Map();
        archive.forEach(item => { if (item.docId != null) docLenByDocId.set(item.docId, item.docLen || 0); });
        const { scores, termWeights } = await computeBm25ScoresFromDisk(queryTerms, docLenByDocId);
        const limit = Number(ui.semanticLimit.value) || SEMANTIC_DEFAULT_LIMIT;
        const ranked = archive
            .filter(item => item.docId != null && scores.has(item.docId) && advancedFiltersMatch(item))
            .map(item => ({ item, score: scores.get(item.docId) }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);

        lastQueryTerms = Array.from(termWeights.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([term]) => term);
        relevanceCache.clear();
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
            ? `${results.length.toLocaleString("pt-BR")} caso(s) semelhante(s) encontrado(s) em ${archive.length.toLocaleString("pt-BR")} solicitações carregadas — via índice em disco, 100% local, nada enviado pra fora.`
            : "Nenhum caso semelhante encontrado (tente descrever com outras palavras).", results.length ? "success" : "warning");
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
        userEngagedWithResults = false; // pesquisa nova de propósito — não precisa mais preservar o que estava aberto
        const text = ui.semanticQuery.value.trim();
        if (!text) { setStatus("Cole a descrição do chamado atual no campo de busca por semelhança.", "warning"); return; }
        await ensureArchiveLoaded();
        if (!archive.length) return;
        ui.semanticSearch.disabled = true;
        // Com o índice pronto, não há mais o que "indexar na primeira busca" —
        // as estatísticas do BM25 já foram gravadas na Fase 2, então a busca
        // vai direto ao disco. Sem índice ainda, mantém o comportamento antigo.
        if (indexReady) {
            setStatus("Comparando com o acervo indexado...", "info");
            try { await runSemanticSearchIndexed(text); await maybeApplyHistoryGseFilter(); }
            catch (error) { setStatus(error.message || String(error), "error"); }
            finally { ui.semanticSearch.disabled = false; }
            return;
        }
        setStatus("Indexando o acervo para busca por semelhança (só na primeira busca após carregar)...", "info");
        setTimeout(async () => {
            try { runSemanticSearch(text); await maybeApplyHistoryGseFilter(); }
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
        relevanceCache.clear(); // termos mudaram: as contagens antigas não valem mais
        // Árvore da consulta, usada SÓ pra restringir candidatos pelo índice.
        // A decisão final de "bate ou não bate" continua sendo do matcher
        // acima, exatamente como na produção — o índice só evita ler do disco
        // o que com certeza não interessa. Se a árvore não puder ser montada,
        // segue sem ela (varre tudo), nunca deixa de encontrar resultado.
        let queryAst = null;
        try {
            queryAst = mode === "exact"
                ? { type: "TERM", value: query.trim().replace(/^"|"$/g, ""), phrase: true }
                : parseQueryExpression(tokenize(query, "OR"));
        } catch (_) { queryAst = null; }
        return { matcher, searchDescription, searchSolution, searchDiscussion, ignoreCase, ignoreAccents, queryAst };
    }

    // ============================================================
    // CANCELAMENTO DA PESQUISA
    // ============================================================
    // A busca pelo índice lê o disco em blocos, então dá pra parar no meio. Já
    // a busca em memória (usada enquanto a Fase 2 não terminou) é uma varredura
    // síncrona: ela segura a thread do início ao fim e não há onde interromper.
    // Por isso o botão só aparece no caminho que realmente pode ser cancelado —
    // oferecer um botão que não faz nada seria pior que não ter botão.
    let searchCancelled = false;
    let searchRunning = false;

    function setSearchRunning(running) {
        searchRunning = running;
        if (!ui || !ui.cancelSearch) return;
        ui.cancelSearch.hidden = !running;
        refreshSearchButtonState();
    }

    function reportSearchCancelled() {
        setStatus("Pesquisa cancelada. Os resultados anteriores continuam na tela.", "warning");
    }

    // Monta o texto que o matcher vai receber, respeitando quais campos o
    // usuário marcou em "Buscar em" — mesma regra da versão em memória.
    function matchesText(prepared, item) {
        const { matcher, searchDescription, searchSolution, searchDiscussion, ignoreCase, ignoreAccents } = prepared;
        return (searchDescription && matcher(normalize(item.description, ignoreCase, ignoreAccents))) ||
               (searchSolution && matcher(normalize(item.solution, ignoreCase, ignoreAccents))) ||
               (searchDiscussion && matcher(normalize(item.discussion, ignoreCase, ignoreAccents)));
    }

    // Versão da busca por termos que passa pelo índice em disco. Só é usada
    // depois que a Fase 2 terminou; antes disso vale applyTermSearch (memória),
    // que é idêntica à de produção. As duas TÊM que devolver o mesmo número —
    // é justamente o que a etiqueta "memória"/"índice" permite conferir.
    async function applyTermSearchIndexed(prepared, isPartial) {
        lastSearchIncludedDiscussion = prepared.searchDiscussion;
        searchCancelled = false;
        setSearchRunning(true);
        try {
            await runIndexedTermSearch(prepared, isPartial);
        } finally {
            setSearchRunning(false);
        }
    }

    async function runIndexedTermSearch(prepared, isPartial) {
        const candidateIds = await candidatesForNode(prepared.queryAst);
        if (searchCancelled) return reportSearchCancelled();

        // Primeiro corta pelos filtros estruturados, que são de graça (já estão
        // na memória), e só então vai ao disco confirmar o texto.
        // O terceiro caso é essencial durante a sincronização incremental: o
        // índice do disco já vale, mas os chamados recém-baixados ainda não
        // entraram nele (a Fase 2 está rodando). Como esses ainda têm o texto
        // em memória, entram sempre na lista e são conferidos por ali — sem
        // isso, o que acabou de chegar sumiria da busca até a Fase 2 acabar.
        // Os candidatos agora vêm como docId (número), não como o id do
        // chamado — é assim que eles estão gravados nas listas de postings.
        // Um item SEM docId entra na lista por precaução, em vez de ser
        // descartado. Sem essa rede, qualquer falha que perca o número interno
        // some com o chamado do resultado sem deixar sinal — foi exatamente o
        // que aconteceu com os chamados atualizados pela sincronização. Custa,
        // no pior caso, conferir alguns registros a mais contra o texto.
        const shortlist = archive.filter(item =>
            (!candidateIds || item.docId == null || candidateIds.has(item.docId) || item.__textOffloaded !== true)
            && advancedFiltersMatch(item));

        const confirmed = [];
        for (let start = 0; start < shortlist.length; start += 400) {
            if (searchCancelled) return reportSearchCancelled();
            const slice = shortlist.slice(start, start + 400);
            const rows = await db.texts.bulkGet(slice.map(item => item.id));
            slice.forEach((item, index) => {
                const row = rows[index];
                // Confere contra o texto lido do disco SEM guardá-lo no item —
                // se guardasse aqui, o texto voltaria todo pra memória e o
                // ganho da v2 evaporaria. Só os cartões exibidos hidratam.
                const probe = row
                    ? { description: row.description || "", solution: row.solution || "", discussion: row.discussion || "" }
                    : { description: item.description || "", solution: item.solution || "", discussion: item.discussion || "" };
                if (matchesText(prepared, probe)) confirmed.push(item);
            });
        }

        results = confirmed;
        currentPage = 1;
        applySort();
        activeIndex = results.length ? 0 : -1;
        const discussionWarning = prepared.searchDiscussion && !archiveIncludesDiscussion
            ? ' ⚠ Discussão não foi incluída — o acervo carregado não tem esse campo. Marque "Discussão" ANTES de clicar em "Pesquisar" e recarregue.'
            : "";
        const partialNote = isPartial ? " (carregando o restante em segundo plano...)" : "";
        setStatus(`${results.length.toLocaleString("pt-BR")} resultado(s) em ${archive.length.toLocaleString("pt-BR")} solicitações carregadas${partialNote} · via índice em disco.${discussionWarning}`, discussionWarning ? "warning" : (results.length ? "success" : "warning"));
        if (userEngagedWithResults) { syncFocusCounters(); return; }
        focusedIndex = -1;
        if (ui.focusOverlay) ui.focusOverlay.hidden = true;
        renderResults();
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
        applySort();
        activeIndex = results.length ? 0 : -1;
        const discussionWarning = searchDiscussion && !archiveIncludesDiscussion
            ? ' ⚠ Discussão não foi incluída — o acervo carregado não tem esse campo. Marque "Discussão" ANTES de clicar em "Pesquisar" e recarregue.'
            : "";
        const partialNote = isPartial ? " (carregando o restante em segundo plano...)" : "";
        const pathNote = indexing ? " · em memória (indexando em segundo plano)" : " · em memória";
        setStatus(`${results.length.toLocaleString("pt-BR")} resultado(s) em ${archive.length.toLocaleString("pt-BR")} solicitações carregadas${partialNote}${pathNote}.${discussionWarning}`, discussionWarning ? "warning" : (results.length ? "success" : "warning"));
        // Enquanto você está com o foco expandido ou um "Mostrar mais"
        // aberto, NUNCA derruba a tela — nem em atualização parcial, nem na
        // final (que antes escapava dessa checagem por vir com isPartial
        // falso, mesmo com o usuário ainda lendo). Os dados novos já estão
        // em `results`; só atualiza os números "X de Y"/Anterior-Próximo,
        // sem tocar no conteúdo que está sendo lido. A tela só é
        // reconstruída de fato quando você fecha o foco ou pesquisa de novo.
        if (userEngagedWithResults) { syncFocusCounters(); return; }
        focusedIndex = -1;
        if (ui.focusOverlay) ui.focusOverlay.hidden = true;
        renderResults();
    }

    // Se a busca inclui Discussão mas o índice já carregado NÃO tem a discussão
    // (acervo indexado sem ela, ou por versão antiga), invalida a assinatura de
    // carga pra forçar um recarregamento — que aí reindexa com a discussão.
    // Sem isto, re-pesquisar não recarregava (a assinatura não tinha mudado) e a
    // busca seguia dando 0 pelo índice velho.
    async function forceReloadIfDiscussionMissing() {
        if (!ui.fieldDiscussion.checked || ignoringGse()) return;
        const groupIds = selectedGseIds();
        if (!groupIds.length) return;
        const rows = await db.syncState.bulkGet(groupIds.map(String));
        const anyMissing = rows.some(row => row && row.hasDiscussion !== true);
        if (anyMissing) loadedSignature = null;
    }

    async function maybeApplyHistoryGseFilter() {
        if (!ui.historyGseCombo) return;
        const selected = ui.historyGseCombo.getSelected();
        if (!selected.length) return;
        const exclude = !!(ui.historyGseExclude && ui.historyGseExclude.checked);
        const before = results.length;
        results = await applyHistoryGseFilter(results, selected.map(o => o.value), exclude);
        currentPage = 1;
        applySort();
        activeIndex = results.length ? 0 : -1;
        const verb = exclude ? "NÃO passaram por nenhuma das" : "passaram por alguma das";
        setStatus(`${results.length.toLocaleString("pt-BR")} resultado(s) ${verb} GSEs filtradas (de ${before.toLocaleString("pt-BR")} antes do filtro de histórico).`, results.length ? "success" : "warning");
        focusedIndex = -1;
        if (ui.focusOverlay) ui.focusOverlay.hidden = true;
        renderResults();
    }

    async function performSearch() {
        userEngagedWithResults = false;
        try {
            searchMode = "terms";
            if (sortMode === "similarity") { sortMode = "recent"; ui.sortSelect.value = "recent"; }
            const prepared = prepareTermSearch();
            await forceReloadIfDiscussionMissing();
            await ensureArchiveLoaded(() => applyTermSearch(prepared, true));
            if (!archive.length) return;
            if (indexReady) await applyTermSearchIndexed(prepared, false);
            else applyTermSearch(prepared, false);
            await maybeApplyHistoryGseFilter();
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
        applySort();
        activeIndex = results.length ? 0 : -1;
        const partialNote = isPartial ? " (carregando o restante em segundo plano...)" : "";
        setStatus(`${results.length.toLocaleString("pt-BR")} solicitação(ões) com esses filtros, em ${archive.length.toLocaleString("pt-BR")} carregadas${partialNote}.`, results.length ? "success" : "warning");
        if (userEngagedWithResults) { syncFocusCounters(); return; }
        focusedIndex = -1;
        if (ui.focusOverlay) ui.focusOverlay.hidden = true;
        renderResults();
    }

    async function performStatsSearch() {
        userEngagedWithResults = false;
        try {
            searchMode = "stats";
            if (sortMode === "similarity") { sortMode = "recent"; ui.sortSelect.value = "recent"; }
            await ensureArchiveLoaded(() => applyStatsFilter(true));
            if (!archive.length) return;
            applyStatsFilter(false);
            await maybeApplyHistoryGseFilter();
        } catch (error) {
            setStatus(error.message || String(error), "error");
        }
    }

    // Contagem de ocorrências por chamado, quando o texto já vive só no disco.
    // Preenchido sob demanda pela ordenação por relevância.
    const relevanceCache = new Map(); // id -> nº de ocorrências dos termos da busca
    let relevancePending = false;

    function countOccurrencesInText(text, ignoreCase, ignoreAccents) {
        const haystack = normalize(text, ignoreCase, ignoreAccents);
        return lastQueryTerms.reduce((sum, term) => {
            const needle = normalize(term, ignoreCase, ignoreAccents);
            if (!needle) return sum;
            return sum + haystack.split(needle).length - 1;
        }, 0);
    }

    function countOccurrences(item) {
        if (!lastQueryTerms.length) return 0;
        // Texto liberado da memória: usa o que já foi contado a partir do
        // disco. Enquanto a contagem não chega, vale 0 e a tela é reordenada
        // sozinha quando ela termina.
        if (needsHydration(item)) return relevanceCache.get(item.id) || 0;
        return countOccurrencesInText(`${item.description} ${item.solution} ${item.discussion}`, ui.ignoreCase.checked, ui.ignoreAccents.checked);
    }

    // Lê o texto dos resultados em blocos só pra contar ocorrências, guardando
    // apenas o número — o texto em si é descartado logo em seguida, então a
    // ordenação por relevância não desfaz o ganho de memória da v2.
    async function ensureRelevanceScores() {
        if (relevancePending || !lastQueryTerms.length) return false;
        const missing = results.filter(item => needsHydration(item) && !relevanceCache.has(item.id));
        if (!missing.length) return false;
        relevancePending = true;
        const ignoreCase = ui.ignoreCase.checked, ignoreAccents = ui.ignoreAccents.checked;
        try {
            for (let start = 0; start < missing.length; start += 400) {
                const slice = missing.slice(start, start + 400);
                const stored = await db.texts.bulkGet(slice.map(item => item.id));
                stored.forEach((row, index) => {
                    const text = row ? `${row.description || ""} ${row.solution || ""} ${row.discussion || ""}` : "";
                    relevanceCache.set(slice[index].id, countOccurrencesInText(text, ignoreCase, ignoreAccents));
                });
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        } finally { relevancePending = false; }
        return true;
    }

    function applySort() {
        if (sortMode === "recent") results.sort((a, b) => Number(b.created) - Number(a.created));
        else if (sortMode === "oldest") results.sort((a, b) => Number(a.created) - Number(b.created));
        else if (sortMode === "relevance") {
            results.sort((a, b) => countOccurrences(b) - countOccurrences(a));
            // Se algum resultado ainda não tem contagem (texto no disco), conta
            // em segundo plano e reordena quando terminar.
            ensureRelevanceScores().then(changed => {
                if (!changed || sortMode !== "relevance") return;
                results.sort((a, b) => countOccurrences(b) - countOccurrences(a));
                renderResults();
            });
        }
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

    function setSelection(item, checked) {
        if (checked) { selectedIds.add(item.id); selectedRecords.set(item.id, item); }
        else { selectedIds.delete(item.id); selectedRecords.delete(item.id); }
        updateSelectionUi();
    }

    function selectPage() {
        const start = (currentPage - 1) * PAGE_RESULTS;
        results.slice(start, start + PAGE_RESULTS).forEach(item => { selectedIds.add(item.id); selectedRecords.set(item.id, item); });
        updateSelectionUi();
        renderResults();
    }

    function selectAllResults() {
        results.forEach(item => { selectedIds.add(item.id); selectedRecords.set(item.id, item); });
        updateSelectionUi();
        renderResults();
    }

    function clearSelection() {
        selectedIds.clear();
        selectedRecords.clear();
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
        // Usa selectedRecords (não archive.filter): o item marcado pode vir
        // de uma pesquisa anterior, com GSEs/filtros diferentes dos de agora
        // — nesse caso ele nem está mais no `archive` atual, que foi
        // substituído. selectedRecords guarda o registro real, independente
        // do que está carregado neste momento.
        if (selectedIds.size) return Array.from(selectedIds).map(id => selectedRecords.get(id)).filter(Boolean);
        return results.length ? results : archive;
    }

    // Exportação é o único lugar que legitimamente precisa do texto de MUITOS
    // chamados de uma vez. Lê do disco em blocos e devolve cópias avulsas, sem
    // prender esse texto nos itens do acervo nem no cache — terminada a
    // geração do arquivo, o navegador recolhe tudo e a memória volta ao normal.
    // ============================================================
    // CAMPOS EXPORTÁVEIS — um modelo único, usado por TODOS os formatos
    // ============================================================
    // Cada campo sabe seu rótulo e como extrair o valor de uma solicitação.
    // Assim a seleção de campos ("quero descrição, não quero solução") vale
    // igual para Excel, HTML, TXT e Markdown, sem duplicar essa lógica em cada
    // um. A ordem aqui é a ordem em que aparecem no relatório.
    const EXPORT_FIELDS = [
        { key: "id", label: "Nº do chamado", get: item => item.id },
        { key: "created", label: "Data de criação", get: item => formatDate(item.created) },
        { key: "requestedFor", label: "Solicitante", get: item => item.requestedFor || "Não informado" },
        { key: "assignedSpecialist", label: "Especialista", get: item => item.assignedSpecialist || "Não informado" },
        { key: "groupName", label: "GSE", get: item => item.groupName || "Não informado" },
        { key: "unidade", label: "Unidade", get: item => item.unidade || "Não informada" },
        { key: "status", label: "Status", get: item => STATUS_LABELS[item.status] || item.status || "—" },
        { key: "statusOperacional", label: "Status operacional", get: item => STATUS_OPERACIONAL_LABELS[item.statusOperacional] || item.statusOperacional || "—" },
        { key: "solutionDate", label: "Data de solução", get: item => formatDate(item.solutionDate) },
        { key: "badges", label: "Selos (VIP / Global)", get: item => [item.isVip ? "VIP" : "", item.isGlobal ? "Global" : ""].filter(Boolean).join(" · ") || "—" },
        { key: "description", label: "Descrição", get: item => item.description || "Não informado", long: true },
        { key: "solution", label: "Solução", get: item => item.solution || "Não informado", long: true },
        { key: "discussion", label: "Discussão", get: item => item.discussion || "Não informado", long: true }
    ];
    const EXPORT_FIELDS_DEFAULT = ["id", "created", "requestedFor", "assignedSpecialist", "groupName", "description"];
    const EXPORT_FIELDS_STORAGE_KEY = "tjspArchivoCamposExport";

    function loadExportFieldSelection() {
        try {
            const saved = JSON.parse(localStorage.getItem(EXPORT_FIELDS_STORAGE_KEY) || "null");
            if (Array.isArray(saved) && saved.length) {
                const valid = new Set(EXPORT_FIELDS.map(f => f.key));
                const filtered = saved.filter(k => valid.has(k));
                if (filtered.length) return filtered;
            }
        } catch (_) {}
        return EXPORT_FIELDS_DEFAULT.slice();
    }
    function saveExportFieldSelection(keys) {
        try { localStorage.setItem(EXPORT_FIELDS_STORAGE_KEY, JSON.stringify(keys)); } catch (_) {}
    }
    // Devolve os campos escolhidos, na ordem canônica de EXPORT_FIELDS.
    function selectedExportFields(keys) {
        const set = new Set(keys && keys.length ? keys : EXPORT_FIELDS_DEFAULT);
        return EXPORT_FIELDS.filter(f => set.has(f.key));
    }

    // ============================================================
    // GERADOR DE .xlsx — sem biblioteca, sem CDN
    // ============================================================
    // Um .xlsx é um arquivo ZIP com alguns XML dentro. Em vez de trazer uma
    // biblioteca externa (mais uma dependência de CDN a falhar), montamos o ZIP
    // aqui com o método "store" (sem compressão, o que dispensa qualquer
    // compressor). O resultado é um arquivo que o Excel abre sem o aviso de
    // "formato diferente" que a alternativa (tabela HTML salva como .xls) causa.
    const CRC32_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        return table;
    })();
    function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xFF];
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function zipStore(files) {
        const enc = new TextEncoder();
        const chunks = [];
        const central = [];
        let offset = 0;
        const u16 = v => [v & 0xFF, (v >>> 8) & 0xFF];
        const u32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
        files.forEach(file => {
            const nameBytes = enc.encode(file.name);
            const data = file.data instanceof Uint8Array ? file.data : enc.encode(file.data);
            const crc = crc32(data);
            const local = [].concat(
                u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
                u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0)
            );
            chunks.push(new Uint8Array(local), nameBytes, data);
            central.push([].concat(
                u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
                u32(crc), u32(data.length), u32(data.length),
                u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
            ), nameBytes);
            offset += local.length + nameBytes.length + data.length;
        });
        const centralStart = offset;
        let centralSize = 0;
        central.forEach(part => {
            const arr = part instanceof Uint8Array ? part : new Uint8Array(part);
            chunks.push(arr); centralSize += arr.length;
        });
        chunks.push(new Uint8Array([].concat(
            u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
            u32(centralSize), u32(centralStart), u16(0)
        )));
        let total = 0;
        chunks.forEach(c => { total += c.length; });
        const out = new Uint8Array(total);
        let pos = 0;
        chunks.forEach(c => { out.set(c, pos); pos += c.length; });
        return out;
    }
    function xmlEscape(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
            // Excel recusa caracteres de controle no XML — remove os inválidos.
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
    }
    function xlsxColLetter(n) {
        let s = "";
        n++;
        while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
        return s;
    }
    // Uma aba: cabeçalho em azul/negrito, corpo com quebra de texto e alinhado
    // ao topo (para os campos longos não estourarem a linha).
    function xlsxSheetXml(sheet) {
        const cell = (col, rowIdx, value, styleId) =>
            `<c r="${xlsxColLetter(col)}${rowIdx}" t="inlineStr" s="${styleId}"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
        const rowsXml = [`<row r="1">${sheet.header.map((h, c) => cell(c, 1, h, 1)).join("")}</row>`];
        sheet.rows.forEach((row, r) => rowsXml.push(`<row r="${r + 2}">${row.map((v, c) => cell(c, r + 2, v, 2)).join("")}</row>`));
        const cols = sheet.header.map((_, c) => {
            const width = sheet.longFlags && sheet.longFlags[c] ? 60 : Math.min(30, Math.max(12, String(sheet.header[c]).length + 4));
            return `<col min="${c + 1}" max="${c + 1}" width="${width}" customWidth="1"/>`;
        }).join("");
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${cols}</cols><sheetData>${rowsXml.join("")}</sheetData></worksheet>`;
    }
    // Monta um .xlsx com uma ou mais abas. Cada aba = {name, header:[...],
    // rows:[[...]], longFlags:[bool]}. Nome de aba não pode ter : \ / ? * [ ]
    // nem passar de 31 caracteres — o Excel recusa o arquivo se passar.
    function buildXlsx(sheets) {
        const clean = sheets.filter(s => s && Array.isArray(s.header) && s.header.length);
        const safeName = (name, index) => (String(name || `Planilha${index + 1}`).replace(/[:\\/?*\[\]]/g, " ").slice(0, 31) || `Planilha${index + 1}`);
        const files = [];
        const wbSheets = [], wbRels = [], ctOverrides = [];
        clean.forEach((sheet, index) => {
            const n = index + 1;
            files.push({ name: `xl/worksheets/sheet${n}.xml`, data: xlsxSheetXml(sheet) });
            wbSheets.push(`<sheet name="${xmlEscape(safeName(sheet.name, index))}" sheetId="${n}" r:id="rId${n}"/>`);
            wbRels.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`);
            ctOverrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
        });
        const stylesRelId = `rId${clean.length + 1}`;
        const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B6EE0"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>`;
        const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${ctOverrides.join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;
        const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
        const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbSheets.join("")}</sheets></workbook>`;
        const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels.join("")}<Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
        return zipStore([
            { name: "[Content_Types].xml", data: contentTypes },
            { name: "_rels/.rels", data: rootRels },
            { name: "xl/workbook.xml", data: workbook },
            { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
            { name: "xl/styles.xml", data: styles }
        ].concat(files));
    }

    async function exportRowsReady(opts) {
        const o = opts || {};
        const rows = exportRows();
        const pending = rows.filter(needsHydration);
        let out = rows;
        if (pending.length) {
            setStatus(`Preparando ${rows.length.toLocaleString("pt-BR")} solicitação(ões) para exportar (lendo o texto do disco)...`, "info");
            const textById = new Map();
            for (let start = 0; start < pending.length; start += 400) {
                const slice = pending.slice(start, start + 400);
                const stored = await db.texts.bulkGet(slice.map(item => item.id));
                stored.forEach((row, index) => { if (row) textById.set(slice[index].id, row); });
                await new Promise(resolve => setTimeout(resolve, 0));
            }
            out = rows.map(item => {
                if (!needsHydration(item)) return item;
                const row = textById.get(item.id);
                return Object.assign({}, item, {
                    description: (row && row.description) || "",
                    solution: (row && row.solution) || "",
                    discussion: (row && row.discussion) || "",
                    discussionEntries: (row && row.discussionEntries) || []
                });
            });
        }
        // A Discussão é um campo do relatório INDEPENDENTE de ter sido buscada:
        // o usuário pode pesquisar em Descrição/Solução e ainda querer ver as
        // discussões no relatório. Se ela foi pedida como campo mas não está no
        // acervo (não foi marcada na carga), busca sob demanda agora.
        if (o.needDiscussion) {
            out = await fillDiscussionForExport(out);
            out = await formatDiscussionForExport(out);
        }
        return out;
    }

    // Busca as Discussões (Comments) em lote, direto do SMAX, para as
    // solicitações que ainda não têm esse campo — usado só na exportação,
    // quando "Discussão" é um campo escolhido mas o acervo foi carregado sem
    // ela. Não grava nada: preenche apenas as cópias que vão pro relatório.
    // Reaproveita normalizeRecord (o mesmo parser da carga normal) em vez de
    // extrair os campos de novo — assim Solicitante/Especialista saem
    // resolvidos por nome igual a uma carga normal, não genéricos.
    async function fillDiscussionForExport(rows) {
        const missing = rows.filter(item => !item.discussion || !String(item.discussion).trim());
        if (!missing.length) return rows;
        setStatus(`Buscando as discussões de ${missing.length.toLocaleString("pt-BR")} solicitação(ões) para o relatório...`, "info");
        const byId = new Map();
        const BATCH = 60;
        const layout = `${ARCHIVE_LAYOUT_BASE},Comments`;
        for (let start = 0; start < missing.length; start += BATCH) {
            const slice = missing.slice(start, start + BATCH);
            const filter = `(${slice.map(item => `Id = '${item.id}'`).join(" or ")})`;
            const params = new URLSearchParams({ filter, layout, size: String(BATCH), skip: "0" });
            try {
                const payload = await fetchJson(`${getRestBase()}/ems/Request?${params}`);
                (Array.isArray(payload.entities) ? payload.entities : []).forEach(entity => {
                    const normalized = normalizeRecord(entity);
                    if (normalized.id) byId.set(normalized.id, normalized);
                });
            } catch (_) { /* uma falha de lote não impede o resto do relatório */ }
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        return rows.map(item => {
            if (item.discussion && String(item.discussion).trim()) return item;
            const normalized = byId.get(String(item.id));
            return normalized ? Object.assign({}, item, { discussion: normalized.discussion, discussionEntries: normalized.discussionEntries }) : item;
        });
    }

    // ---- Detalhamento por comentário na exportação -----------------------
    // O campo "Discussão" na tela já separa por comentário (autor + Interno/
    // Público); a exportação até agora jogava tudo achatado num bloco só de
    // texto. Aqui, só na hora de exportar e só para os chamados que estão no
    // resultado filtrado (não o acervo inteiro), resolve nome + GSE/lotação
    // de quem comentou — inclusive colegas que não são nem o solicitante nem
    // o especialista do chamado, que hoje aparecem só como "Outro
    // colaborador". Pessoa sem nenhuma GSE (comum em servidores não
    // vinculados) aparece como "sem GSE" em vez de ficar em branco.
    //
    // PersonToGroup.Name como layout pra achar a GSE da pessoa é o melhor
    // palpite a partir do padrão já usado no filtro de especialista
    // (`PersonToGroup[Id in (...)]` — confirma que Person tem uma coleção
    // PersonToGroup) — não foi confirmado ao vivo ainda. Se o nome da GSE
    // não aparecer no relatório, é o primeiro lugar a conferir com uma
    // captura de rede.
    const exportPersonCache = new Map(); // Person Id -> {name, gseName} | null (não achado)

    async function resolveCommentAuthors(rows) {
        const idsNeeded = new Set();
        rows.forEach(item => {
            (item.discussionEntries || []).forEach(entry => {
                if (entry.submitterId && !exportPersonCache.has(entry.submitterId)) idsNeeded.add(entry.submitterId);
            });
        });
        const ids = Array.from(idsNeeded);
        if (!ids.length) return;
        const BATCH = 60;
        for (let start = 0; start < ids.length; start += BATCH) {
            const slice = ids.slice(start, start + BATCH);
            const filter = `(${slice.map(id => `Id = '${id}'`).join(" or ")})`;
            const params = new URLSearchParams({ filter, layout: "Name,PersonToGroup.Name", size: String(slice.length), skip: "0" });
            try {
                const payload = await fetchJson(`${getRestBase()}/ems/Person?${params}`);
                (Array.isArray(payload.entities) ? payload.entities : []).forEach(entity => {
                    const p = entity.properties || {};
                    const id = String(p.Id || "");
                    if (!id) return;
                    const gseRaw = p["PersonToGroup.Name"];
                    const gseName = Array.isArray(gseRaw) ? gseRaw.filter(Boolean).join(", ") : (gseRaw ? String(gseRaw).trim() : "");
                    exportPersonCache.set(id, { name: String(p.Name || "").trim(), gseName });
                });
            } catch (_) { /* segue sem detalhar esses autores; o resto do relatório sai normalmente */ }
            slice.forEach(id => { if (!exportPersonCache.has(id)) exportPersonCache.set(id, null); }); // não achou: não repete a consulta à toa numa próxima exportação
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    // Troca o bloco único de texto por um detalhamento por comentário. Só
    // roda quando "Discussão" foi escolhida como campo do relatório — não
    // mexe no que aparece na tela (que já usa discussionEntries direto).
    async function formatDiscussionForExport(rows) {
        await resolveCommentAuthors(rows);
        return rows.map(item => {
            const entries = item.discussionEntries;
            if (!entries || !entries.length) return item;
            const formatted = entries.map(entry => {
                const info = entry.submitterId ? exportPersonCache.get(entry.submitterId) : null;
                // Solicitante/Especialista já vêm com nome certo do próprio
                // chamado — só troca pelo nome resolvido aqui quando o autor
                // é o genérico "Outro colaborador".
                const who = (entry.author && entry.author !== "Outro colaborador") ? entry.author : ((info && info.name) || entry.author);
                const gseSuffix = info ? (info.gseName ? ` · ${info.gseName}` : " · sem GSE") : "";
                const visibility = entry.isInternal ? "Interno" : "Visível ao usuário";
                const when = entry.time ? formatDate(entry.time) : "";
                return `[${when}] ${who} (${visibility}${gseSuffix}):\n${entry.text}`;
            }).join("\n\n---\n\n");
            return Object.assign({}, item, { discussion: formatted });
        });
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

    // Todos os exportadores abaixo recebem os CAMPOS já escolhidos (na ordem
    // canônica) e só emitem esses — é o que faz a seleção de campos valer igual
    // em qualquer formato. As "seções extras" (filtros, índice, distribuição)
    // também são compartilhadas, via os helpers abaixo.

    // Dados das seções extras, em estrutura neutra, para HTML/Excel/Markdown
    // renderizarem cada um à sua maneira a partir da MESMA fonte.
    function reportDistributionData(rows) {
        return {
            byGse: countRowsBy(rows, item => shortGseLabel(item.groupName)),
            byStatus: countRowsBy(rows, item => STATUS_LABELS[item.status] || item.status || "—")
        };
    }

    async function exportXlsx(fields, opts) {
        const o = opts || {};
        const rows = await exportRowsReady({ needDiscussion: fields.some(f => f.key === "discussion") });
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const sheets = [{
            name: "Solicitações",
            header: fields.map(f => f.label),
            rows: rows.map(item => fields.map(f => f.get(item))),
            longFlags: fields.map(f => !!f.long)
        }];
        // Cada seção extra vira uma aba própria — o equivalente natural em
        // planilha às seções do relatório HTML.
        if (o.includeFilters !== false) {
            const fr = buildFilterSummaryRows();
            if (fr.length) sheets.push({ name: "Filtros utilizados", header: ["Filtro", "Valor"], rows: fr.map(r => [r.label, r.items.join(" · ")]), longFlags: [false, true] });
        }
        if (o.includeIndice !== false) {
            sheets.push({ name: "Índice", header: ["#", "Chamado", "Solicitante", "Data de criação"],
                rows: rows.map((item, i) => [String(i + 1), item.id, item.requestedFor || "", formatDate(item.created)]), longFlags: [false, false, false, false] });
        }
        if (o.includeDistribuicao !== false) {
            const dist = reportDistributionData(rows);
            const distRows = dist.byGse.map(([label, count]) => ["Por GSE", label, String(count)])
                .concat(dist.byStatus.map(([label, count]) => ["Por status", label, String(count)]));
            if (distRows.length) sheets.push({ name: "Distribuição", header: ["Agrupamento", "Valor", "Quantidade"], rows: distRows, longFlags: [false, true, false] });
        }
        downloadFile(`acervo-smax-${timestamp()}.xlsx`, buildXlsx(sheets),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em Excel (.xlsx).`, "success");
    }

    async function exportTxt(fields, reportName) {
        const rows = await exportRowsReady({ needDiscussion: fields.some(f => f.key === "discussion") });
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const head = [reportName && reportName.trim() ? reportName.trim() : "Pesquisa no Acervo SMAX",
            `${rows.length} solicitação(ões) · ${new Date().toLocaleString("pt-BR")}`, "=".repeat(60), ""].join("\n");
        const parts = rows.map(item => fields.map(f => `${f.label}: ${f.get(item)}`).concat("-".repeat(60)).join("\n"));
        downloadFile(`acervo-smax-${timestamp()}.txt`, head + parts.join("\n\n"), "text/plain");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em TXT.`, "success");
    }

    async function exportMarkdown(fields, opts) {
        const o = opts || {};
        const rows = await exportRowsReady({ needDiscussion: fields.some(f => f.key === "discussion") });
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const esc = v => String(v == null ? "" : v).replace(/\r/g, "").replace(/\|/g, "\\|");
        const escBlock = v => String(v == null ? "" : v).replace(/\r/g, "");
        const idField = fields.find(f => f.key === "id");
        const shortFields = fields.filter(f => !f.long && f.key !== "id");
        const longFields = fields.filter(f => f.long);
        const lines = [`# ${o.reportName && o.reportName.trim() ? escBlock(o.reportName.trim()) : "Pesquisa no Acervo SMAX"}`,
            "", `${rows.length} solicitação(ões) · exportado em ${new Date().toLocaleString("pt-BR")}`, ""];

        if (o.includeFilters !== false) {
            const fr = buildFilterSummaryRows();
            if (fr.length) { lines.push("## Filtros utilizados", ""); fr.forEach(r => lines.push(`- **${esc(r.label)}:** ${esc(r.items.join(" · "))}`)); lines.push(""); }
        }
        if (o.includeIndice !== false) {
            lines.push("## Índice", "", "| # | Chamado | Solicitante | Data |", "| --- | --- | --- | --- |");
            rows.forEach((item, i) => lines.push(`| ${i + 1} | ${esc(item.id)} | ${esc(item.requestedFor || "")} | ${esc(formatDate(item.created))} |`));
            lines.push("");
        }
        if (o.includeDistribuicao !== false) {
            const dist = reportDistributionData(rows);
            lines.push("## Distribuição", "", "**Por GSE**", "");
            dist.byGse.forEach(([label, count]) => lines.push(`- ${esc(label)}: ${count}`));
            lines.push("", "**Por status**", "");
            dist.byStatus.forEach(([label, count]) => lines.push(`- ${esc(label)}: ${count}`));
            lines.push("");
        }

        if (o.layout === "table") {
            // Layout tabela: uma linha por chamado, campos longos truncados.
            lines.push("## Solicitações", "", `| ${fields.map(f => esc(f.label)).join(" | ")} |`, `| ${fields.map(() => "---").join(" | ")} |`);
            rows.forEach(item => lines.push(`| ${fields.map(f => { const v = f.get(item); return esc(f.long && v.length > 120 ? v.slice(0, 120) + "…" : v).replace(/\n/g, " "); }).join(" | ")} |`));
            lines.push("");
        } else {
            rows.forEach(item => {
                lines.push(`## ${idField ? "Chamado " + escBlock(idField.get(item)) : "Solicitação"}`);
                if (shortFields.length) lines.push(shortFields.map(f => `**${f.label}:** ${escBlock(f.get(item))}`).join("  \n"));
                longFields.forEach(f => { lines.push("", `**${f.label}**`, "", escBlock(f.get(item))); });
                lines.push("");
            });
        }
        downloadFile(`acervo-smax-${timestamp()}.md`, lines.join("\n"), "text/markdown");
        setStatus(`${rows.length.toLocaleString("pt-BR")} solicitação(ões) exportada(s) em Markdown.`, "success");
    }

    // Descreve um filtro de data (mesmas 6 opções usadas em Período e Data de
    // solução) em texto legível, pro bloco "Filtros utilizados" do relatório.
    function describeDateFilterValue(mode, daysValue, fromValue, toValue) {
        const fmt = value => {
            const parsed = parseDateInput(value, false);
            return parsed != null ? new Date(parsed).toLocaleDateString("pt-BR") : value;
        };
        if (mode === "days") { const days = Number(daysValue); return days > 0 ? `Últimos ${days} dia(s)` : ""; }
        if (mode === "on") return fromValue ? `Em ${fmt(fromValue)}` : "";
        if (mode === "after") return fromValue ? `A partir de ${fmt(fromValue)}` : "";
        if (mode === "before") return toValue ? `Até ${fmt(toValue)}` : "";
        if (mode === "between") return (fromValue && toValue) ? `Entre ${fmt(fromValue)} e ${fmt(toValue)}` : "";
        return "";
    }

    // Nome completo do GSE tem sempre o mesmo prefixo repetido ("GSE - SGS -
    // EPROC..."), que só atrapalha quando são vários juntos no relatório —
    // aqui fica só a sigla/parte que de fato distingue um do outro.
    function shortGseLabel(name) {
        return String(name || "").replace(/^GSE\s*-\s*SGS\s*-\s*EPROC(\s*1G)?\s*-\s*/i, "") || name;
    }

    // Só os filtros que de fato restringiram o resultado — vazio/padrão fica
    // de fora pra não poluir o relatório. Modo de busca, termo pesquisado e
    // ignorar maiúsculas/acentos ficam sempre de fora, por pedido do Leonardo.
    // Cada linha guarda uma LISTA (items) — quando tem mais de um valor, o
    // relatório mostra como selos em vez de um parágrafo corrido.
    function buildFilterSummaryRows() {
        const rows = [];
        if (searchMode === "terms") {
            const fields = [];
            if (ui.fieldDescription.checked) fields.push("Descrição");
            if (ui.fieldSolution.checked) fields.push("Solução");
            if (ui.fieldDiscussion.checked) fields.push("Discussão");
            if (fields.length) rows.push({ label: "Campos buscados", items: fields });
        }
        const gseIds = selectedGseIds();
        if (gseIds.length) rows.push({ label: "GSEs", items: gseIds.map(id => shortGseLabel(GSE_NAME[id] || id)) });
        if (ui.requestedForCombo && ui.requestedForCombo.getSelected().length) rows.push({ label: "Solicitado para", items: ui.requestedForCombo.getSelected().map(o => o.label) });
        if (ui.specialistCombo && ui.specialistCombo.getSelected().length) rows.push({ label: "Designado especialista", items: ui.specialistCombo.getSelected().map(o => o.label) });
        if (ui.statusCombo && ui.statusCombo.getSelected().length) rows.push({ label: "Status", items: ui.statusCombo.getSelected().map(o => o.label) });
        if (ui.statusOperacionalCombo && ui.statusOperacionalCombo.getSelected().length) rows.push({ label: "Status operacional", items: ui.statusOperacionalCombo.getSelected().map(o => o.label) });
        if (ui.unidadeCombo && ui.unidadeCombo.getSelected().length) rows.push({ label: "Unidade/Comarca", items: ui.unidadeCombo.getSelected().map(o => o.label) });
        if (ui.dateMode.value !== "any") {
            const text = describeDateFilterValue(ui.dateMode.value, ui.dateDays.value, ui.dateFrom.value, ui.dateTo.value);
            if (text) rows.push({ label: "Período (abertura)", items: [text] });
        }
        if (ui.solutionDateMode && ui.solutionDateMode.value !== "any") {
            const text = describeDateFilterValue(ui.solutionDateMode.value, ui.solutionDateDays.value, ui.solutionDateFrom.value, ui.solutionDateTo.value);
            if (text) rows.push({ label: "Data de solução", items: [text] });
        }
        if (ui.vipOnly.checked) rows.push({ label: "Usuário VIP", items: ["Sim"] });
        if (ui.globalOnly && ui.globalOnly.checked) rows.push({ label: "Global", items: ["Sim"] });
        if (ui.historyGseCombo && ui.historyGseCombo.getSelected().length) {
            const excludeLabel = ui.historyGseExclude && ui.historyGseExclude.checked ? "Não passou por GSE" : "Passou por GSE";
            rows.push({ label: excludeLabel, items: ui.historyGseCombo.getSelected().map(o => o.label) });
        }
        return rows;
    }

    function filterValueHtml(items) {
        if (items.length === 1) return `<span style="font-size:13px">${escapeHtml(items[0])}</span>`;
        return items.map(value => `<span style="display:inline-block;background:#eaf2fc;color:#0b6ee0;font-size:11.5px;font-weight:700;border-radius:5px;padding:3px 9px;margin:2px 5px 2px 0">${escapeHtml(value)}</span>`).join("");
    }

    // Contagem por categoria (GSE/status) entre as linhas exportadas, maior
    // pra menor — base do índice estatístico do relatório HTML.
    function countRowsBy(rows, keyFn) {
        const map = new Map();
        rows.forEach(item => {
            const key = keyFn(item) || "Não informado";
            map.set(key, (map.get(key) || 0) + 1);
        });
        return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
    }

    function reportBarRowsHtml(counts) {
        const max = counts.length ? counts[0][1] : 1;
        return counts.slice(0, 8).map(([label, count]) => `
            <div style="display:grid;grid-template-columns:130px 1fr 34px;align-items:center;gap:10px;margin-bottom:8px;font-size:12.5px">
                <span>${escapeHtml(label)}</span>
                <div style="height:8px;border-radius:4px;background:#eaf0f6;overflow:hidden"><div style="height:100%;background:#0b6ee0;border-radius:4px;width:${Math.round(count / max * 100)}%"></div></div>
                <span style="text-align:right;color:#526477">${count}</span>
            </div>`).join("");
    }

    async function exportHtml(fields, options) {
        const opts = options || {};
        const rows = await exportRowsReady({ needDiscussion: fields.some(f => f.key === "discussion") });
        if (!rows.length) return setStatus("Nada para exportar ainda.", "warning");
        const reportName = String(opts.reportName || "").trim();
        const layout = opts.layout === "table" ? "table" : "cards";
        const shortFields = fields.filter(f => !f.long && f.key !== "id");
        const longFields = fields.filter(f => f.long);
        const showId = fields.some(f => f.key === "id");
        const includeFilters = opts.includeFilters !== false;
        const includeIndice = opts.includeIndice !== false;
        const includeDistribuicao = opts.includeDistribuicao !== false;

        const filterRows = includeFilters ? buildFilterSummaryRows() : [];
        const filtersBlock = filterRows.length ? `
            <section style="background:#fff;border:1px solid #d5e0ea;border-radius:10px;padding:16px 18px;margin-bottom:18px;break-inside:avoid;page-break-inside:avoid">
                <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#0b6ee0;margin:0 0 12px">Filtros utilizados</h2>
                <dl style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px 24px;margin:0">
                    ${filterRows.map(row => `<dt style="font-size:10.5px;text-transform:uppercase;color:#7a8b9b;margin:0">${escapeHtml(row.label)}</dt><dd style="margin:1px 0 10px">${filterValueHtml(row.items)}</dd>`).join("")}
                </dl>
            </section>` : "";

        const indiceSumarioBlock = includeIndice ? `
            <section style="background:#fff;border:1px solid #d5e0ea;border-radius:10px;padding:16px 18px;margin-bottom:18px;break-inside:avoid;page-break-inside:avoid">
                <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#0b6ee0;margin:0 0 12px">Índice do relatório</h2>
                <table style="width:100%;border-collapse:collapse;font-size:12.5px">
                    <tr>
                        <th style="text-align:left;color:#7a8b9b;text-transform:uppercase;font-size:10px;padding:0 8px 6px 0;border-bottom:1px solid #eef2f6">#</th>
                        <th style="text-align:left;color:#7a8b9b;text-transform:uppercase;font-size:10px;padding:0 8px 6px 0;border-bottom:1px solid #eef2f6">Chamado</th>
                        <th style="text-align:left;color:#7a8b9b;text-transform:uppercase;font-size:10px;padding:0 8px 6px 0;border-bottom:1px solid #eef2f6">Solicitante</th>
                        <th style="text-align:left;color:#7a8b9b;text-transform:uppercase;font-size:10px;padding:0 8px 6px 0;border-bottom:1px solid #eef2f6">Data</th>
                    </tr>
                    ${rows.map((item, index) => `
                    <tr style="break-inside:avoid;page-break-inside:avoid">
                        <td style="padding:6px 8px 6px 0;border-bottom:1px solid #eef2f6;color:#526477">${index + 1}</td>
                        <td style="padding:6px 8px 6px 0;border-bottom:1px solid #eef2f6"><a href="#req-${escapeHtml(item.id)}" style="color:#0b6ee0;font-weight:800;text-decoration:none">${escapeHtml(item.id)}</a>${item.isVip ? ' <span style="font-size:10px;font-weight:800;color:#8a6300;background:#ffe9a8;border-radius:4px;padding:2px 7px">⭐ VIP</span>' : ""}</td>
                        <td style="padding:6px 8px 6px 0;border-bottom:1px solid #eef2f6">${escapeHtml(item.requestedFor)}</td>
                        <td style="padding:6px 8px 6px 0;border-bottom:1px solid #eef2f6;color:#7a8b9b;white-space:nowrap">${escapeHtml(formatDate(item.created))}</td>
                    </tr>`).join("")}
                </table>
            </section>` : "";

        const distribuicaoBlock = includeDistribuicao ? `
            <section style="background:#fff;border:1px solid #d5e0ea;border-radius:10px;padding:16px 18px;margin-bottom:18px;break-inside:avoid;page-break-inside:avoid">
                <h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:#0b6ee0;margin:0 0 12px">Distribuição do que foi exportado</h2>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:0 28px">
                    <div>
                        <h3 style="font-size:11px;text-transform:uppercase;color:#7a8b9b;margin:4px 0 10px">Por GSE</h3>
                        ${reportBarRowsHtml(countRowsBy(rows, item => shortGseLabel(item.groupName)))}
                    </div>
                    <div>
                        <h3 style="font-size:11px;text-transform:uppercase;color:#7a8b9b;margin:4px 0 10px">Por status</h3>
                        ${reportBarRowsHtml(countRowsBy(rows, item => STATUS_LABELS[item.status] || item.status))}
                    </div>
                </div>
            </section>` : "";

        // Layout FICHAS — uma ficha por chamado, texto completo. Cabeçalho com
        // Nº e selos; campos curtos no rodapé; campos longos em blocos próprios.
        const cardsHtml = () => rows.map(item => {
            const header = `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                    ${showId ? `<a href="${escapeHtml(location.origin)}/saw/Request/${encodeURIComponent(item.id)}/general" style="color:#0b6ee0;font-weight:800;text-decoration:none;font-size:15px">${escapeHtml(item.id)}</a>` : ""}
                    ${item.isVip ? '<span style="font-size:10px;font-weight:800;color:#8a6300;background:#ffe9a8;border-radius:4px;padding:2px 7px">⭐ VIP</span>' : ""}
                    ${item.isGlobal ? '<span style="font-size:10px;font-weight:800;color:#0b6ee0;background:#eaf2fc;border:1px solid #c7dff8;border-radius:4px;padding:1px 7px">GLOBAL</span>' : ""}
                </div>`;
            const longBlocks = longFields.map(f => `<div style="margin-bottom:8px"><strong style="display:block;font-size:10.5px;text-transform:uppercase;color:#0b6ee0;margin-bottom:3px">${escapeHtml(f.label)}</strong><p style="margin:0;white-space:pre-wrap">${escapeHtml(f.get(item))}</p></div>`).join("");
            const footer = shortFields.length ? `<footer style="display:flex;flex-wrap:wrap;gap:16px;margin-top:10px;padding-top:8px;border-top:1px solid #eef2f6;font-size:11.5px;color:#526477">
                    ${shortFields.map(f => `<span><strong style="color:#7a8b9b;font-weight:600">${escapeHtml(f.label)}:</strong> ${escapeHtml(f.get(item))}</span>`).join("")}
                </footer>` : "";
            return `<article id="req-${escapeHtml(item.id)}" style="border:1px solid #d5e0ea;border-left:4px solid #0b6ee0;border-radius:8px;padding:14px 16px;margin-bottom:14px;background:#fff;break-inside:avoid;page-break-inside:avoid">${header}${longBlocks}${footer}</article>`;
        }).join("");

        // Layout TABELA COMPACTA — uma linha por chamado. Campos longos entram
        // truncados, para caber muito mais por página numa visão de conjunto.
        const tableHtml = () => {
            const cols = fields.slice();
            const th = cols.map(f => `<th style="text-align:left;color:#7a8b9b;text-transform:uppercase;font-size:10px;padding:7px 8px;border-bottom:2px solid #d5e0ea;white-space:nowrap">${escapeHtml(f.label)}</th>`).join("");
            const body = rows.map(item => `<tr style="break-inside:avoid;page-break-inside:avoid">${cols.map(f => {
                const raw = f.get(item);
                const val = f.long ? (raw.length > 160 ? raw.slice(0, 160) + "…" : raw) : raw;
                const idCell = f.key === "id"
                    ? `<a href="${escapeHtml(location.origin)}/saw/Request/${encodeURIComponent(item.id)}/general" style="color:#0b6ee0;font-weight:800;text-decoration:none">${escapeHtml(val)}</a>`
                    : escapeHtml(val);
                return `<td style="padding:6px 8px;border-bottom:1px solid #eef2f6;color:#3c556b;vertical-align:top${f.long ? "" : ";white-space:nowrap"}">${idCell}</td>`;
            }).join("")}</tr>`).join("");
            return `<table style="width:100%;border-collapse:collapse;font-size:11.5px;background:#fff;border:1px solid #d5e0ea;border-radius:8px">
                <thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
        };

        const body = layout === "table" ? tableHtml() : cardsHtml();

        const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Acervo SMAX — Exportação</title>
            <style>@media print { .no-print { display: none; } }</style></head>
            <body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f2f5f8;color:#273746;margin:0;padding:28px">
                <h1 style="color:#0b6ee0;margin:0 0 4px">Pesquisa no Acervo SMAX</h1>
                ${reportName ? `<p style="color:#273746;font-size:15px;font-weight:700;margin:0 0 6px">${escapeHtml(reportName)}</p>` : ""}
                <p style="color:#526477;margin:0 0 4px">Exportado em ${escapeHtml(new Date().toLocaleString("pt-BR"))} · ${rows.length.toLocaleString("pt-BR")} solicitação(ões).</p>
                <p class="no-print" style="color:#526477;margin:0 0 20px">Imprima esta página (Ctrl+P) para gerar um PDF.</p>
                ${filtersBlock}
                ${indiceSumarioBlock}
                ${distribuicaoBlock}
                ${body}
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

    function timestamp() {
        const now = new Date();
        const pad = n => String(n).padStart(2, "0");
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
    }

    // ============================================================
    // FORMATAÇÃO / DESTAQUE
    // ============================================================
    function setStatus(message, type) { ui.status.textContent = message || ""; ui.status.className = "status " + (type || ""); }
    // A barra fica escondida de propósito — a ideia é o usuário focar em
    // ler o primeiro resultado (que já aparece rápido) em vez de acompanhar
    // "quanto falta". O texto/percentual continuam sendo calculados aqui
    // (não custa nada), só não são exibidos.
    function setProgress(message, percent) { ui.progressText.textContent = message; ui.progressBar.style.width = `${Math.max(0, Math.min(100, percent))}%`; }

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

    // kind = "desc"/"sol"/"disc" (cor e selo), badge = letra mostrada (D/S/C).
    // O estilo (preenchido/3B ou só barra/3D) vem 100% de CSS — variáveis
    // --rc-* trocadas pela classe .card-style-3d no host, sem precisar
    // renderizar de novo ao alternar. copyHtml opcional (só Solução no card
    // compacto, por pedido explícito) mostra um botão de copiar com formatação.
    function contentBlock(kind, label, badge, text, copyHtml) {
        const long = String(text || "").length > 650;
        const copyBtn = copyHtml ? `<button class="copy-rich" type="button" data-copy-kind="${kind}" title="Copiar ${label.toLowerCase()} com formatação"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 012-2h10"></path></svg>Copiar</button>` : "";
        return `<div class="field f-${kind}${long ? " collapsed" : ""}"><span class="badge">${badge}</span><div class="field-body"><span class="field-label">${label}${copyBtn}</span><p>${highlight(text)}</p>${long ? '<button class="expand-text" type="button">Mostrar mais</button>' : ""}</div></div>`;
    }

    // Discussão em entradas separadas (autor + Interno/Público + texto),
    // sempre em texto puro com o destaque do termo buscado.
    function discussionBlock(entries) {
        if (!entries || !entries.length) return "";
        const rows = entries.map(entry => {
            const badgeClass = entry.isInternal ? "disc-internal" : "disc-public";
            const badgeLabel = entry.isInternal ? "Interno" : "Público";
            return `<div class="disc-entry"><div class="disc-meta"><strong>${escapeHtml(entry.author)}</strong><span class="disc-visibility ${badgeClass}">${badgeLabel}</span><span class="disc-time">${escapeHtml(formatDate(entry.time))}</span></div><div class="disc-body"><p>${highlight(entry.text)}</p></div></div>`;
        }).join("");
        return `<div class="field f-disc"><span class="badge">C</span><div class="field-body"><span class="field-label">Discussão</span>${rows}</div></div>`;
    }


    // O HTML original do SMAX NÃO é mais buscado ao abrir o modo expandido —
    // só na hora de copiar. Motivos, em ordem de peso:
    //   1. Buscar pra EXIBIR substituía o texto com os termos da busca
    //      destacados por um HTML sem destaque nenhum. Num script de pesquisa,
    //      ver onde o termo bateu vale mais que ver o negrito.
    //   2. Custava uma requisição por chamado aberto, o que pesava ao navegar
    //      com as setas, e ainda mostrava "Carregando formatação original…".
    //   3. A formatação original só é realmente necessária pra colar em outro
    //      lugar — que é exatamente o botão Copiar.
    // Consequência aceita: imagens aparecem como "[Imagem anexada]" aqui, mas
    // vêm corretamente na cópia.
    function richContentBlock(kind, label, badge, text, withCopy) {
        const copyButton = withCopy
            ? `<button class="copy-rich" type="button" data-copy-kind="${kind}" title="Copiar ${label.toLowerCase()} com a formatação original do SMAX"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 012-2h10"></path></svg>Copiar</button>`
            : "";
        return `<div class="field f-${kind} rich">
            <span class="badge">${badge}</span>
            <div class="field-body">
                <span class="field-label">${label}${copyButton}</span>
                <div class="rich-html" data-rich-slot="${kind}"><p>${highlight(text)}</p></div>
            </div>
        </div>`;
    }

    // fallbackText é o texto puro que já estava na tela (vindo do próprio
    // Copia via seleção real + document.execCommand("copy") — o mesmo
    // caminho que o navegador usa quando você seleciona texto formatado
    // numa página e aperta Ctrl+C manualmente (por isso interopera bem com
    // colar em Word/Teams/editor do SMAX). Cria um contenteditable fora da
    // tela, joga o HTML nele, seleciona tudo e manda copiar; o navegador
    // monta o formato de área de transferência (inclusive o CF_HTML que o
    // Windows exige) sozinho, do jeito que esses apps esperam — diferente
    // de montar um Blob "na mão" via ClipboardItem, que não estava sendo
    // reconhecido como rico fora do próprio navegador (precisava do modo
    // "código fonte" pra colar). Retorna true/false.
    function copyHtmlViaSelection(html) {
        const container = document.createElement("div");
        container.setAttribute("contenteditable", "true");
        container.style.position = "fixed";
        container.style.left = "-9999px";
        container.style.top = "0";
        container.style.opacity = "0";
        container.innerHTML = html;
        document.body.appendChild(container);
        let ok = false;
        try {
            container.focus();
            const range = document.createRange();
            range.selectNodeContents(container);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            ok = document.execCommand("copy");
            selection.removeAllRanges();
        } catch (_) { ok = false; }
        document.body.removeChild(container);
        return ok;
    }

    // NÃO mexe no status principal (ali de cima fica a contagem de
    // resultados/solicitações carregadas — copiar não pode sobrescrever
    // isso); o feedback de sucesso/falha é só no próprio botão, feito por
    // quem chama. Retorna "rich" (copiou com formatação), "plain" (copiou
    // só o texto — navegador não deixou com HTML) ou null (falhou de vez).
    // As imagens do SMAX moram em endereços autenticados (/rest/.../frs/...),
    // então copiar o <img src="..."> copia só um PONTEIRO: ao colar em outro
    // lugar, o destino tenta buscar a imagem sem a sessão do usuário — ou o
    // editor descarta imagens externas de saída — e o resultado é o texto sem
    // as figuras. Aqui cada imagem é baixada com a sessão atual e embutida no
    // próprio conteúdo (data URI), de modo que a colagem passa a ser
    // autossuficiente e funciona em qualquer destino, inclusive fora do SMAX.
    const COPY_MAX_IMAGES = 20;
    const COPY_MAX_IMAGE_BYTES = 3 * 1024 * 1024; // acima disso, o ganho não paga o tamanho na área de transferência

    function blobToDataUri(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error("falha ao ler imagem"));
            reader.readAsDataURL(blob);
        });
    }

    async function inlineImagesAsDataUris(html) {
        if (!html || !/<img/i.test(html)) return html;
        const box = document.createElement("div");
        box.innerHTML = html;
        const images = Array.from(box.querySelectorAll("img[src]")).slice(0, COPY_MAX_IMAGES);
        await Promise.all(images.map(async img => {
            const src = img.getAttribute("src") || "";
            if (/^data:/i.test(src)) return; // já embutida
            try {
                const response = await fetch(src, { credentials: "include" });
                if (!response.ok) return;
                const blob = await response.blob();
                if (blob.size > COPY_MAX_IMAGE_BYTES) return;
                img.setAttribute("src", await blobToDataUri(blob));
            } catch (_) {
                // Falhou uma imagem: mantém o endereço original e segue — é
                // melhor colar o texto com uma figura quebrada do que não colar.
            }
        }));
        return box.innerHTML;
    }

    async function copyRichHtml(html, plainText) {
        // ORDEM IMPORTA, e já esteve errada aqui. Antes esta função tentava
        // primeiro o caminho antigo (copyHtmlViaSelection, via execCommand) e
        // só usava a API moderna se aquele falhasse. Só que o execCommand
        // devolve true mesmo quando não copiou nada aproveitável — então ele
        // "dava certo", o botão dizia "Copiado!" e a área de transferência
        // ficava vazia. Pior neste script do que em geral, porque a interface
        // roda dentro de um shadow DOM e a seleção que aquele método cria fica
        // fora dessa árvore: é justamente o caso em que o navegador copia vazio
        // e ainda assim reporta sucesso.
        //
        // A API moderna não depende de seleção nenhuma, então virou a primeira
        // opção. O caminho antigo continua aqui só como último recurso, para
        // navegador que não tenha ClipboardItem.
        // Embute as imagens antes de qualquer tentativa de cópia, pra que todos
        // os caminhos abaixo levem o conteúdo completo.
        let richHtml = html;
        try { richHtml = await inlineImagesAsDataUris(html); } catch (_) { richHtml = html; }

        try {
            if (navigator.clipboard && window.ClipboardItem) {
                // FRAGMENTO, não documento. Antes isto envolvia o conteúdo em
                // `<!doctype html><html><body>...`, e editores de texto rico
                // costumam descartar uma colagem que chega como documento
                // inteiro — o que explicava o sintoma: "colar sem formatação"
                // funcionava (o formato texto puro estava correto) mas a
                // colagem normal vinha vazia.
                const htmlBlob = new Blob([richHtml || ""], { type: "text/html" });
                const textBlob = new Blob([plainText || ""], { type: "text/plain" });
                await navigator.clipboard.write([new ClipboardItem({ "text/html": htmlBlob, "text/plain": textBlob })]);
                return "rich";
            }
        } catch (_) { /* cai para os caminhos abaixo */ }

        if (richHtml && copyHtmlViaSelection(richHtml)) return "rich";

        try {
            await navigator.clipboard.writeText(plainText || "");
            return "plain";
        } catch (_) {
            return null;
        }
    }

    // Busca o HTML sob demanda na hora do clique (com cache — se o modo
    // expandido já buscou, é instantâneo) em vez de exigir isso de todo
    // registro carregado. Todo o feedback (buscando/copiado/falha) fica só
    // no próprio botão — nunca no status principal ali de cima, que mostra
    // a contagem de resultados/solicitações carregadas e não pode ser
    // sobrescrito por uma ação pontual de copiar.
    function wireRichCopyButtons(root, item) {
        root.querySelectorAll(".copy-rich").forEach(button => button.addEventListener("click", async event => {
            event.stopPropagation();
            if (button.disabled) return;
            const kind = button.dataset.copyKind;
            const original = button.innerHTML;
            button.disabled = true;
            button.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 012-2h10"></path></svg>Buscando...`;
            try {
                const rich = await fetchRichFields(item.id);
                const html = kind === "desc" ? rich.descriptionHtml : rich.solutionHtml;
                const text = kind === "desc" ? item.description : item.solution;
                const result = await copyRichHtml(html, text);
                button.innerHTML = result
                    ? `<svg viewBox="0 0 24 24"><path d="M5 13l4.5 4.5L19 8"></path></svg>${result === "rich" ? "Copiado!" : "Copiado (sem fmt.)"}`
                    : `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"></path></svg>Falha ao copiar`;
            } catch (error) {
                button.innerHTML = `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"></path></svg>Falha ao buscar`;
            }
            await new Promise(resolve => setTimeout(resolve, 1300));
            button.disabled = false;
            button.innerHTML = original;
        }));
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
        // Modo expandido mostra o texto inteiro — se ele já saiu da memória,
        // busca no disco e reabre. Também aquece os vizinhos, porque ↑/↓ nesta
        // tela são o jeito normal de navegar e assim a troca fica instantânea.
        if (needsHydration(results[index])) {
            const neighbours = results.slice(Math.max(0, index - 2), index + 3);
            hydrateItems(neighbours).then(() => { if (focusedIndex === index || activeIndex === index) openFocus(index); });
            return;
        }
        activeIndex = index;
        focusedIndex = index;
        focusedItemId = results[index].id;
        userEngagedWithResults = true;
        const item = results[index];
        const url = `${location.origin}/saw/Request/${encodeURIComponent(item.id)}/general`;
        ui.focusBody.innerHTML = `
            <header class="focus-header">
                <div>
                    <span class="focus-position">Chamado ${index + 1} de ${results.length}${item.isVip ? " · ⭐ VIP" : ""}</span>
                    <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.id)}</a>
                    <small>Criado em ${escapeHtml(formatDate(item.created))}<span class="focus-gse">${escapeHtml(item.groupName)}</span></small>
                </div>
                <label class="focus-select"><input type="checkbox" class="focus-checkbox" ${isSelected(item.id) ? "checked" : ""}>Selecionar</label>
                <button class="focus-close" type="button">×</button>
            </header>
            <nav class="focus-nav">
                <button class="focus-prev" type="button" ${index === 0 ? "disabled" : ""}>Anterior</button>
                <span class="focus-nav-counter">${index + 1} de ${results.length}</span>
                <button class="focus-next" type="button" ${index === results.length - 1 ? "disabled" : ""}>Próximo</button>
                <small>Use ↑ e ↓ para navegar</small>
            </nav>
            <div class="focus-scroll">
                ${richContentBlock("desc", "Descrição", "D", item.description, false)}
                ${richContentBlock("sol", "Solução", "S", item.solution, true)}
                ${lastSearchIncludedDiscussion && item.discussion ? discussionBlock(item.discussionEntries) : ""}
                <footer>
                    <div><small>Solicitado para</small><span>${escapeHtml(item.requestedFor)}</span></div>
                    <div><small>Designado Especialista</small><span>${escapeHtml(item.assignedSpecialist)}</span></div>
                    <div><small>Data de Solução</small><span>${escapeHtml(formatDate(item.solutionDate))}</span></div>
                </footer>
            </div>`;
        ui.focusBody.querySelector(".focus-close").addEventListener("click", closeFocus);
        ui.focusBody.querySelector(".focus-prev").addEventListener("click", () => { if (activeIndex > 0) { activateResult(activeIndex - 1, false); openFocus(activeIndex); } });
        ui.focusBody.querySelector(".focus-next").addEventListener("click", () => { if (activeIndex < results.length - 1) { activateResult(activeIndex + 1, false); openFocus(activeIndex); } });
        ui.focusBody.querySelector(".focus-checkbox").addEventListener("change", event => setSelection(item, event.target.checked));
        wireRichCopyButtons(ui.focusBody, item);
        ui.focusOverlay.hidden = false;
        const scroller = ui.focusBody.querySelector(".focus-scroll");
        if (scroller) scroller.scrollTop = 0;
        updateNavigator();

        // Nada de rede aqui: o conteúdo já está na tela, com os termos da busca
        // destacados. A formatação original só é buscada quando o botão Copiar
        // é acionado — ver o comentário em richContentBlock.
    }

    function closeFocus() {
        focusedIndex = -1;
        focusedItemId = null;
        userEngagedWithResults = false;
        if (ui && ui.focusOverlay) ui.focusOverlay.hidden = true;
        renderResults();
    }

    // Chamada quando `results` muda em segundo plano (mais uma janela de
    // período terminou de carregar) enquanto o usuário está com o modo
    // expandido aberto — NÃO reconstrói o conteúdo (isso derrubaria a
    // leitura), só reencontra a posição do MESMO chamado (por id, não por
    // índice — a ordem pode mudar) e atualiza os números "X de Y" e os
    // botões Anterior/Próximo.
    function syncFocusCounters() {
        if (focusedIndex < 0 || !focusedItemId || !ui.focusOverlay || ui.focusOverlay.hidden) return;
        const newIndex = results.findIndex(item => item.id === focusedItemId);
        if (newIndex === -1) return;
        focusedIndex = newIndex;
        activeIndex = newIndex;
        const item = results[newIndex];
        const posEl = ui.focusBody.querySelector(".focus-position");
        if (posEl) posEl.textContent = `Chamado ${newIndex + 1} de ${results.length}${item.isVip ? " · ⭐ VIP" : ""}`;
        const counterEl = ui.focusBody.querySelector(".focus-nav-counter");
        if (counterEl) counterEl.textContent = `${newIndex + 1} de ${results.length}`;
        const prevBtn = ui.focusBody.querySelector(".focus-prev");
        if (prevBtn) prevBtn.disabled = newIndex === 0;
        const nextBtn = ui.focusBody.querySelector(".focus-next");
        if (nextBtn) nextBtn.disabled = newIndex === results.length - 1;
        updateNavigator();
    }

    // Termos e Semelhança continuam compartilhando o mesmo resultado (você
    // busca por termo e depois usa o mesmo acervo pra buscar semelhança, sem
    // perder nada) — só a Busca Estatística guarda o próprio resultado à
    // parte, porque misturar os dois não faz sentido nenhum na tela.
    // Estado dos filtros guardado por aba. Sem isto, um "Status = Fechado"
    // deixado na Busca Estatística continuava valendo ao voltar para a Pesquisa
    // por termos e reduzia o resultado em silêncio — o mesmo tipo de vazamento
    // que já tínhamos corrigido para os resultados, agora na direção contrária.
    // A GSE fica de fora de propósito: ela define QUAL acervo está carregado,
    // não filtra o resultado, e as configurações dizem que vale para as 3 abas.
    let textFilterStash = null;
    let statsFilterStash = null;

    const EMPTY_FILTERS = {
        specialistIds: [], requestedForIds: [],
        statusValues: [], statusOperacionalValues: [], unidadeValues: [],
        vipOnly: false, globalOnly: false, ignoreGse: false,
        dateMode: "days", dateFrom: "", dateTo: "", dateDays: "180"
    };

    function swapFilterState(fromBucket, toBucket) {
        const outgoing = captureStatsFilters();
        outgoing.ignoreGse = !!(ui.ignoreGse && ui.ignoreGse.checked);
        if (fromBucket === "text") textFilterStash = outgoing; else statsFilterStash = outgoing;

        const incoming = toBucket === "text" ? textFilterStash : statsFilterStash;
        // Aba nunca visitada começa limpa, em vez de herdar o que estava na
        // outra — que é justamente o problema a evitar.
        const target = Object.assign({}, incoming || EMPTY_FILTERS, { gseIds: selectedGseIds() });
        applyStatsFilters(target);
        if (ui.ignoreGse) ui.ignoreGse.checked = toBucket === "stats" && !!target.ignoreGse;
    }

    function enterResultsBucket(bucket) {
        if (bucket === resultsBucket) return;
        swapFilterState(resultsBucket, bucket);
        const outgoing = { results, currentPage, activeIndex, focusedIndex, sortMode, lastQueryTerms, lastSearchIncludedDiscussion, semanticScores, semanticMaxScore, searchMode };
        if (resultsBucket === "text") textResultsStash = outgoing; else statsResultsStash = outgoing;
        resultsBucket = bucket;
        const incoming = bucket === "text" ? textResultsStash : statsResultsStash;
        if (incoming) {
            results = incoming.results; currentPage = incoming.currentPage; activeIndex = incoming.activeIndex; focusedIndex = incoming.focusedIndex;
            sortMode = incoming.sortMode; lastQueryTerms = incoming.lastQueryTerms; lastSearchIncludedDiscussion = incoming.lastSearchIncludedDiscussion;
            semanticScores = incoming.semanticScores; semanticMaxScore = incoming.semanticMaxScore; searchMode = incoming.searchMode;
        } else {
            results = []; currentPage = 1; activeIndex = -1; focusedIndex = -1;
            lastQueryTerms = []; lastSearchIncludedDiscussion = false; semanticScores = new Map(); semanticMaxScore = 1;
            sortMode = "recent"; searchMode = bucket === "stats" ? "stats" : "terms";
        }
        if (ui.sortSelect) ui.sortSelect.value = sortMode;
        if (ui.focusOverlay) ui.focusOverlay.hidden = true;

        // A consulta ao vivo (sem GSE) pertence SÓ à aba Estatística: o que
        // está em memória é o resultado dela, não o acervo indexado que as
        // outras abas usam. Sair da aba levando isso junto mostraria, na
        // Pesquisa por termos, a contagem e o gráfico de GSEs de uma consulta
        // que não é dela. Então o resultado ao vivo é descartado ao sair.
        if (liveQueryMode && bucket !== "stats") {
            archive = [];
            liveQueryMode = false;
            loadedSignature = null; // a próxima pesquisa recarrega o acervo certo
            // A seleção NÃO zera aqui: itens marcados durante a consulta ao
            // vivo continuam guardados em selectedRecords e podem ser
            // exportados depois, mesmo com o `archive` descartado acima.
            updateSelectionUi();
            renderStats();
            renderIndexStatus();
        }

        // A mensagem de status também é por aba: sem isto, a contagem da
        // pesquisa anterior continuava na tela depois de trocar de aba.
        setStatus(results.length
            ? `${results.length.toLocaleString("pt-BR")} resultado(s) desta aba.`
            : (archive.length ? "" : "Escolha os filtros e pesquise."), results.length ? "success" : "info");

        renderResults();
    }

    // ============================================================
    // RENDERIZAÇÃO DE RESULTADOS
    // ============================================================
    // Enquanto a carga por período está rolando, um rodapé fino avisa qual
    // período está em andamento — sem revelar o total final (isso só
    // aparece no status do topo quando o acervo termina de carregar por
    // completo, igual sempre foi).
    function renderLoadingTrickleFooter() {
        if (!loadingProgressInfo) return;
        const footer = document.createElement("div");
        footer.className = "trickle-footer";
        footer.innerHTML = `<span class="specialist-spinner"></span>Carregando período ${loadingProgressInfo.windowIndex + 1} de ${loadingProgressInfo.windowCount} (${escapeHtml(loadingProgressInfo.label)})...`;
        ui.results.appendChild(footer);
    }

    function renderResults() {
        ui.results.innerHTML = "";
        ui.statsViewToggle.hidden = searchMode !== "stats";
        ui.cardStyleToggle.hidden = searchMode === "stats";
        if (!results.length) {
            ui.results.innerHTML = loadingProgressInfo
                ? '<div class="empty">Carregando os resultados mais recentes primeiro...</div>'
                : '<div class="empty">Nenhuma solicitação corresponde aos critérios (ou o acervo ainda não foi carregado).</div>';
            renderLoadingTrickleFooter();
            ui.pagination.hidden = true;
            updateNavigator();
            return;
        }
        const pages = Math.ceil(results.length / PAGE_RESULTS);
        currentPage = Math.max(1, Math.min(currentPage, pages));
        const start = (currentPage - 1) * PAGE_RESULTS;
        const pageItems = results.slice(start, start + PAGE_RESULTS);
        // Depois que a Fase 2 liberou o texto da memória, os cartões desta
        // página precisam buscá-lo de volta no disco. São no máximo 15 leituras
        // por chave primária (poucos milissegundos): pinta já com o que tem e
        // repinta assim que o texto chega. Enquanto o texto ainda está na
        // memória (Fase 1), nada disso dispara e o caminho é o de sempre.
        if (pageItems.some(needsHydration)) {
            hydrateItems(pageItems).then(changed => { if (changed) renderResults(); });
        }
        if (searchMode === "stats") renderStatsResults(pageItems, start);
        else renderDetailedResults(pageItems, start);
        renderLoadingTrickleFooter();
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
                    ${item.isVip ? '<span class="vip-badge"><svg viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" fill="currentColor"><path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 7-6.3-3.9-6.3 3.9 1.7-7L2 9.2l7.1-.6z"></path></svg>VIP</span>' : ""}${item.isGlobal ? '<span class="global-badge">GLOBAL</span>' : ""}
                    <span class="gse-tag">${escapeHtml(item.groupName)}</span>
                    ${isSemanticResult ? `<span class="sim-badge">${similarityPct}% semelhante</span>` : (occurrences ? `<span class="occ-badge">${occurrences}×</span>` : "")}
                    <span class="date">Criado em ${escapeHtml(formatDate(item.created))}</span>
                    <button class="icon-btn expand-one" type="button" title="Expandir"><svg viewBox="0 0 24 24"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"></path></svg></button>
                </header>
                ${contentBlock("desc", "Descrição", "D", item.description)}
                ${contentBlock("sol", "Solução", "S", item.solution, true)}
                ${lastSearchIncludedDiscussion && item.discussion ? discussionBlock(item.discussionEntries) : ""}
                <footer><span><small>Solicitado para</small>${escapeHtml(item.requestedFor)}</span><span><small>Designado Especialista</small>${escapeHtml(item.assignedSpecialist)}</span><span><small>Data de Solução</small>${escapeHtml(formatDate(item.solutionDate))}</span></footer>`;

            card.querySelector(".row-select").addEventListener("click", event => event.stopPropagation());
            card.querySelector(".row-select").addEventListener("change", event => setSelection(item, event.target.checked));
            card.querySelector(".expand-one").addEventListener("click", event => { event.stopPropagation(); activateResult(globalIndex, false); openFocus(globalIndex); });
            wireRichCopyButtons(card, item);
            card.querySelectorAll(".expand-text").forEach(button => button.addEventListener("click", event => {
                event.stopPropagation();
                const field = button.closest(".field");
                field.classList.toggle("collapsed");
                button.textContent = field.classList.contains("collapsed") ? "Mostrar mais" : "Recolher";
                userEngagedWithResults = true;
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
        el.querySelector(".row-select").addEventListener("change", event => setSelection(item, event.target.checked));
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

    function loadGseDefaults() {
        try {
            const parsed = JSON.parse(localStorage.getItem(GSE_DEFAULTS_STORAGE_KEY) || "null");
            return Array.isArray(parsed) ? parsed.filter(entry => entry && entry.id && entry.name) : [];
        } catch (_) { return []; }
    }

    function saveGseDefaults(list) {
        userDefaultGses = list;
        list.forEach(entry => { GSE_NAME[entry.id] = entry.name; });
        try { localStorage.setItem(GSE_DEFAULTS_STORAGE_KEY, JSON.stringify(list)); } catch (_) {}
    }

    function buildGseList() {
        ui.gseList.innerHTML = userDefaultGses.map(({ id, name }) => `<label class="gse-item"><input type="checkbox" data-gse value="${id}" checked><span>${escapeHtml(name)}</span></label>`).join("");
    }

    function loadCustomTeams() {
        try {
            const parsed = JSON.parse(localStorage.getItem(CUSTOM_TEAMS_STORAGE_KEY) || "null");
            return Array.isArray(parsed) ? parsed.filter(team => team && team.id && team.name && Array.isArray(team.gses)) : [];
        } catch (_) { return []; }
    }

    function saveCustomTeams(list) {
        customTeams = list;
        try { localStorage.setItem(CUSTOM_TEAMS_STORAGE_KEY, JSON.stringify(list)); } catch (_) {}
    }

    function getAllTeams() { return NATIVE_TEAMS.concat(customTeams); }

    // Equipes "adotadas" — todas as GSEs dela já estão nas GSEs padrão
    // SALVAS (userDefaultGses), não no que está sendo digitado ao vivo em
    // Configurações antes de clicar Salvar. É essa lista, e não getAllTeams(),
    // que decide quais atalhos de equipe aparecem em Passou por GSE e na
    // lista principal de GSEs — desmarcar uma equipe em Configurações e
    // salvar tira o atalho dos dois; desmarcar GSEs individuais direto num
    // desses filtros não mexe na adoção, o atalho continua lá.
    function adoptedTeams() {
        const defaultIds = new Set(userDefaultGses.map(entry => entry.id));
        return getAllTeams().filter(team => team.gses.length && team.gses.every(g => defaultIds.has(g.id)));
    }

    // Adapta a lista de checkboxes "GSEs incluídas na carga" (não é um combo
    // de installMultiCombobox) pra reaproveitar renderTeamTogglers/
    // teamFullyInCombo/mergeTeamIntoCombo sem duplicar essa lógica.
    function gseListCombo() {
        return {
            getSelected: () => Array.from(ui.gseList.querySelectorAll("input[data-gse]:checked")).map(input => ({
                value: input.value,
                label: input.nextElementSibling ? input.nextElementSibling.textContent : (GSE_NAME[input.value] || input.value)
            })),
            setSelected: list => {
                const ids = new Set((list || []).map(option => option.value));
                ui.gseList.querySelectorAll("input[data-gse]").forEach(input => { input.checked = ids.has(input.value); });
            },
            onChange: fn => { if (typeof fn === "function") ui.gseList.addEventListener("change", fn); }
        };
    }

    // Uma equipe está "adotada" quando TODAS as GSEs dela já estão na seleção.
    function teamFullyInCombo(combo, team) {
        if (!team.gses.length) return false;
        const selected = new Set(combo.getSelected().map(o => o.value));
        return team.gses.every(g => selected.has(g.id));
    }

    // Equipes com estado marcado/desmarcado e feedback visual. Clicar ADOTA
    // (marca todas as GSEs da equipe) ou DESADOTA (remove todas), e o selo
    // mostra em qual dos dois estados está — antes o clique só adicionava, sem
    // como ver se estava marcada nem como desmarcar.
    function renderTeamTogglers(container, teams, combo, afterChange) {
        if (!container) return;
        if (!teams.length) { container.innerHTML = ""; container.hidden = true; return; }
        container.hidden = false;
        const draw = () => {
            container.innerHTML = teams.map(team => {
                const on = teamFullyInCombo(combo, team);
                const icon = on
                    ? '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"></path></svg>'
                    : '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle></svg>';
                return `<button type="button" class="team-pill${on ? " selected" : ""}" data-team-id="${escapeHtml(team.id)}">${icon}${escapeHtml(team.name)}<span class="n">${team.gses.length} GSE(s)</span></button>`;
            }).join("");
            container.querySelectorAll(".team-pill").forEach(button => {
                button.addEventListener("click", () => {
                    const team = teams.find(t => t.id === button.dataset.teamId);
                    if (!team) return;
                    if (teamFullyInCombo(combo, team)) {
                        const ids = new Set(team.gses.map(g => g.id));
                        combo.setSelected(combo.getSelected().filter(o => !ids.has(o.value)));
                        setStatus(`Equipe "${team.name}" desmarcada.`, "info");
                    } else {
                        mergeTeamIntoCombo(combo, team);
                        setStatus(`Equipe "${team.name}" adotada — ${team.gses.length} GSE(s) marcada(s).`, "success");
                    }
                    draw();
                    if (afterChange) afterChange();
                });
            });
        };
        draw();
    }

    // Igual a renderTeamTogglers, mas também mostra/esconde um rótulo
    // "Minhas equipes" e (opcional) uma dica junto dos selos — usado nos dois
    // lugares fora de Configurações (Passou por GSE e a lista principal de
    // GSEs), onde os selos só aparecem se houver equipe adotada.
    function renderTeamPillGroup(container, titleEl, hintEl, teams, combo) {
        renderTeamTogglers(container, teams, combo);
        const show = !!teams.length;
        if (titleEl) titleEl.hidden = !show;
        if (hintEl) hintEl.hidden = !show;
    }

    function mergeTeamIntoCombo(combo, team) {
        const existing = combo.getSelected();
        const merged = existing.slice();
        team.gses.forEach(g => {
            GSE_NAME[g.id] = g.name;
            if (!merged.some(o => o.value === g.id)) merged.push({ value: g.id, label: g.name });
        });
        combo.setSelected(merged);
    }

    // ============================================================
    // CONFIGURAÇÕES DO SCRIPT (GSEs padrão — sem lista de fábrica)
    // Primeira vez: obrigatório configurar (sem isso não tem o que
    // pesquisar). Depois disso, o ícone de engrenagem no cabeçalho reabre
    // pra alterar quando quiser — nunca mais é forçado.
    // ============================================================
    // ============================================================
    // PAINEL "ACERVO SALVO EM DISCO" (dentro das Configurações)
    // ============================================================
    let storageBusy = false;

    function setStorageBusy(busy, progress) {
        storageBusy = busy;
        if (!ui || !ui.storageProgress) return;
        ui.storageProgress.hidden = !busy;
        if (busy && progress) ui.storageProgressFill.style.width = `${Math.round(progress * 100)}%`;
        ui.storageRefresh.disabled = busy;
        ui.storageWipe.disabled = busy;
        ui.storageList.querySelectorAll(".storage-row-del").forEach(button => { button.disabled = busy; });
    }

    async function renderStoragePanel() {
        if (!ui || !ui.storageList) return;
        ui.storageList.innerHTML = '<p class="storage-empty">Lendo o que está salvo...</p>';
        let inventory;
        try { inventory = await collectStorageInventory(); }
        catch (error) {
            ui.storageList.innerHTML = `<p class="storage-empty">Não foi possível ler: ${escapeHtml(error.message || String(error))}</p>`;
            return;
        }

        const mb = bytes => (bytes / 1048576).toFixed(1);
        const perTicket = inventory.estimate && inventory.totalTickets
            ? inventory.estimate.usage / inventory.totalTickets
            : 0;

        // O total do navegador é por DOMÍNIO, não por banco: com uma versão
        // anterior ainda instalada, o acervo dela entra na conta e infla tanto
        // o total quanto o rateio por GSE (que é proporcional). Sem este aviso
        // o número parece indicar que cada chamado passou a ocupar bem mais do
        // que ocupa de fato.
        let siblingDbs = [];
        try {
            if (indexedDB.databases) {
                siblingDbs = (await indexedDB.databases())
                    .map(entry => entry && entry.name)
                    .filter(name => name && name !== INDEX_DB_NAME && /acervo/i.test(name));
            }
        } catch (_) {}

        ui.storageSummary.innerHTML = inventory.totalTickets
            ? `<strong>${inventory.totalTickets.toLocaleString("pt-BR")}</strong> solicitação(ões) salvas em <strong>${inventory.groups.length}</strong> GSE(s)${inventory.estimate ? ` · <strong>${mb(inventory.estimate.usage)} MB</strong> em disco` : ""}${describeLastSync(lastSyncAt) ? ` · atualizado <strong>${escapeHtml(describeLastSync(lastSyncAt))}</strong>` : ""}.`
              + (siblingDbs.length
                  ? `<br><span style="color:var(--v-warning-text)">O espaço acima é do domínio inteiro e inclui ${siblingDbs.length === 1 ? "o banco" : "os bancos"} de versão anterior (${siblingDbs.map(escapeHtml).join(", ")}), então os valores por GSE aparecem maiores do que realmente são. Desinstale a versão antiga e apague o banco dela para ver o número certo.</span>`
                  : "")
            : "Nada salvo em disco ainda.";

        if (!inventory.groups.length) {
            ui.storageList.innerHTML = '<p class="storage-empty">Nenhuma GSE indexada. Carregue um acervo para que ele passe a ficar salvo aqui.</p>';
        } else {
            ui.storageList.innerHTML = "";
            inventory.groups.forEach(group => {
                const row = document.createElement("div");
                row.className = "storage-row";
                // O espaço por GSE é rateado pelo número de chamados: o
                // navegador não informa o consumo por parte do banco, e chutar
                // um número exato seria pior que assumir a proporção.
                const share = perTicket ? ` · ~${mb(perTicket * group.count)} MB` : "";
                row.innerHTML = `
                    <div class="storage-row-main">
                        <span class="storage-row-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
                        <span class="storage-row-meta">${group.count.toLocaleString("pt-BR")} solicitação(ões)${share} · atualizada até ${escapeHtml(formatDate(group.lastUpdate || group.lastCreateTime))}</span>
                    </div>
                    <button type="button" class="storage-row-del">Apagar</button>`;
                row.querySelector(".storage-row-del").addEventListener("click", async () => {
                    if (storageBusy) return;
                    if (!window.confirm(`Apagar do disco os ${group.count.toLocaleString("pt-BR")} chamados de "${group.name}"?\n\nAs outras GSEs não são afetadas. A próxima carga desta GSE vai baixar tudo de novo.`)) return;
                    setStorageBusy(true, 0);
                    ui.storageNote.textContent = `Removendo "${group.name}" e limpando o índice...`;
                    try {
                        const removed = await deleteGseFromDisk(group.groupId, (done, total) => {
                            setStorageBusy(true, total ? done / total : 0);
                        });
                        // O acervo em memória também precisa deixar de mostrar
                        // essa GSE, senão a tela ficaria exibindo chamados cujo
                        // texto não existe mais no disco.
                        archive = archive.filter(item => String(item.groupId) !== group.groupId);
                        results = results.filter(item => String(item.groupId) !== group.groupId);
                        renderResults();
                        renderStats();
                        renderIndexStatus();
                        ui.storageNote.textContent = `"${group.name}" removida — ${removed.toLocaleString("pt-BR")} chamado(s) apagados do disco.`;
                    } catch (error) {
                        ui.storageNote.textContent = `Falha ao remover: ${error.message || error}`;
                    } finally {
                        setStorageBusy(false);
                        renderStoragePanel();
                    }
                });
                ui.storageList.appendChild(row);
            });
        }

        const notes = [];
        if (inventory.orphanCount > 0) {
            notes.push(`${inventory.orphanCount.toLocaleString("pt-BR")} chamado(s) salvos sem GSE identificada (provavelmente de uma carga interrompida) — "Apagar tudo" limpa esses também.`);
        }
        if (persistentStorageGranted === true) {
            notes.push("Armazenamento permanente concedido: o navegador não vai descartar este acervo para liberar espaço.");
        } else if (persistentStorageGranted === false) {
            notes.push("Atenção: o navegador NÃO concedeu armazenamento permanente, então pode descartar este acervo se o disco ficar cheio. Nesse caso basta carregar de novo.");
        }
        ui.storageNote.textContent = notes.join(" ");
    }

    function openSettingsModal(mandatory) {
        settingsMandatory = !!mandatory;
        ui.settingsGseCombo.setSelected(userDefaultGses.map(entry => ({ value: entry.id, label: entry.name })));
        ui.settingsError.hidden = true;
        ui.settingsClose.hidden = settingsMandatory;
        ui.settingsCancel.hidden = settingsMandatory;
        ui.settingsOverlay.querySelector("h3").textContent = settingsMandatory ? "Bem-vindo! Escolha suas GSEs" : "Configurações do script";
        ui.settingsOverlay.querySelector(".settings-hint").textContent = settingsMandatory
            ? "Para começar, escolha as GSEs que você acompanha. Você pode selecioná-las abaixo, adotar uma equipe pronta em \"Equipes sugeridas\", ou montar a sua em \"Criar equipe\". Elas ficam marcadas toda vez que abrir o script, e valem pras 3 abas."
            : "Ficam marcadas toda vez que você abrir a pesquisa. Dá pra desmarcar ou adicionar outras pontualmente em cada busca (inclusive pela busca de \"Outras GSEs\") sem afetar essa configuração — e valem pras 3 abas (Termos, Semelhança e Estatística), que compartilham a mesma seleção.";
        // Equipes com estado marcado/desmarcado, refletindo o que já está na
        // seleção de GSEs padrão. Adotar/desadotar atualiza os dois lados.
        renderTeamTogglers(ui.settingsUserTeams, customTeams, ui.settingsGseCombo);
        renderTeamTogglers(ui.suggestedTeams, NATIVE_TEAMS, ui.settingsGseCombo);
        ui.suggestedTeamsBox.hidden = true;
        ui.settingsSuggestedToggle.classList.remove("open");
        ui.teamNewForm.hidden = true;
        ui.settingsOverlay.hidden = false;
        // Na primeira configuração ainda não existe acervo salvo — mostrar um
        // painel vazio ali só atrapalharia quem está começando. Esconde o bloco
        // inteiro (título, explicação e painel), não só o painel.
        ui.settingsOverlay.querySelectorAll(".storage-only").forEach(node => { node.hidden = settingsMandatory; });
        if (ui.autoSyncToggle) ui.autoSyncToggle.checked = autoSyncEnabled;
        if (!settingsMandatory) renderStoragePanel();
    }

    function closeSettingsModal() {
        if (settingsMandatory) return; // não fecha sem salvar na primeira vez
        ui.settingsOverlay.hidden = true;
    }

    function saveGseSettings() {
        const selected = ui.settingsGseCombo.getSelected();
        if (!selected.length) { ui.settingsError.hidden = false; return; }
        saveGseDefaults(selected.map(option => ({ id: option.value, name: option.label })));
        buildGseList();
        // A adoção de equipe (o que aparece como atalho aqui e em "Passou por
        // GSE") é definida por userDefaultGses — que acabou de mudar — não
        // pelo estado ao vivo do combo de Configurações. Os dois precisam
        // ser redesenhados agora que o que foi salvo pode ter mudado.
        if (gseListComboInstance) renderTeamPillGroup(ui.gseTeams, ui.gseTeamsTitle, null, adoptedTeams(), gseListComboInstance);
        if (ui.historyGseCombo) renderTeamPillGroup(ui.historyTeams, ui.historyTeamsTitle, ui.historyTeamsHint, adoptedTeams(), ui.historyGseCombo);
        settingsMandatory = false;
        ui.settingsOverlay.hidden = true;
        setStatus(`${selected.length} GSE(s) padrão salva(s).`, "success");
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
            specialistIds: ui.specialistCombo ? ui.specialistCombo.getSelected() : [],
            requestedForIds: ui.requestedForCombo ? ui.requestedForCombo.getSelected() : [],
            statusValues: ui.statusCombo.getSelected(), statusOperacionalValues: ui.statusOperacionalCombo.getSelected(),
            unidadeValues: ui.unidadeCombo.getSelected(), vipOnly: ui.vipOnly.checked, globalOnly: ui.globalOnly ? ui.globalOnly.checked : false,
            dateMode: ui.dateMode.value, dateFrom: ui.dateFrom.value, dateTo: ui.dateTo.value, dateDays: ui.dateDays.value
        };
    }

    // Abre (e marca ativa) a tag de um filtro opcional só quando a preferência
    // aplicada de fato trouxe algo pra ele — senão o campo fica preenchido
    // mas escondido atrás da tag, parecendo que "não aplicou nada".
    function openStatsTagIfFilled(slotId, hasValue) {
        if (!hasValue) return;
        const shadow = host.shadowRoot;
        const slot = shadow.getElementById(slotId);
        const tag = shadow.querySelector(`.stats-tag[data-slot="${slotId}"]`);
        if (slot) slot.hidden = false;
        if (tag) tag.classList.add("active");
    }

    // specialistPersonId/requestedForPersonId (valor único) são o formato
    // ANTIGO de preferências salvas, de antes dos campos virarem multi-
    // seleção — convertidos aqui pra não perder presets já salvos por
    // Leonardo quando ele aplicar um criado numa versão anterior do script.
    function applyStatsFilters(filters) {
        if (!filters) return;
        ui.gseList.querySelectorAll("input[data-gse]").forEach(input => { input.checked = (filters.gseIds || []).includes(input.value); });
        const specialistIds = filters.specialistIds || (filters.specialistPersonId ? [{ value: filters.specialistPersonId, label: filters.specialistValue || filters.specialistPersonId }] : []);
        const requestedForIds = filters.requestedForIds || (filters.requestedForPersonId ? [{ value: filters.requestedForPersonId, label: filters.requestedForValue || filters.requestedForPersonId }] : []);
        if (ui.specialistCombo) ui.specialistCombo.setSelected(specialistIds);
        if (ui.requestedForCombo) ui.requestedForCombo.setSelected(requestedForIds);
        ui.statusCombo.setSelected(filters.statusValues || []);
        ui.statusOperacionalCombo.setSelected(filters.statusOperacionalValues || []);
        ui.unidadeCombo.setSelected(filters.unidadeValues || []);
        ui.vipOnly.checked = !!filters.vipOnly;
        if (ui.globalOnly) ui.globalOnly.checked = !!filters.globalOnly;
        ui.dateMode.value = filters.dateMode || "any";
        ui.dateFrom.value = filters.dateFrom || "";
        ui.dateTo.value = filters.dateTo || "";
        ui.dateDays.value = filters.dateDays || "";
        updateDateControls();
        openStatsTagIfFilled("statsEspSlot", specialistIds.length);
        openStatsTagIfFilled("statsSolSlot", requestedForIds.length);
        openStatsTagIfFilled("statsStatusSlot", (filters.statusValues && filters.statusValues.length) || (filters.statusOperacionalValues && filters.statusOperacionalValues.length));
        openStatsTagIfFilled("statsUnidadeSlot", filters.unidadeValues && filters.unidadeValues.length);
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
                /* Preferências de aparência (por navegador/pessoa, como o
                   tema): 1 = padrão. --v-modal-scale multiplica a largura/
                   altura máxima do modal; --v-font-zoom usa a propriedade
                   CSS zoom no .dialog-zoom (o CONTEÚDO do modal, não a caixa
                   externa — ver comentário lá) — texto E espaçamento juntos,
                   igual ao zoom nativo do navegador. São independentes,
                   ajustar um não move o outro sozinho (exceto que zoom alto
                   pode sobrar mais conteúdo pra rolar dentro do modal). */
                --v-modal-scale: 1;
                --v-font-zoom: 1;
                /* Estilo dos campos Descrição/Solução/Discussão nos resultados
                   (Termos/Semelhança) — 3B (padrão, preenchido) por aqui;
                   3D (só barra no topo) sobrescreve em :host(.card-style-3d).
                   Referenciam --v-* pra já acompanhar claro/escuro sozinhos. */
                --rc-desc-bg: var(--v-warning-bg); --rc-desc-badge: var(--v-warning-text); --rc-desc-label: var(--v-warning-text); --rc-desc-top: none;
                --rc-sol-bg: var(--v-success-bg); --rc-sol-top: none; --rc-sol-text: var(--v-success-text); --rc-sol-weight: 600;
                --rc-disc-bg: var(--v-panel-alt); --rc-disc-badge: var(--v-muted); --rc-disc-label: var(--v-muted); --rc-disc-top: none; --rc-disc-text: var(--v-text-soft);
                color: var(--v-text);
            }
            :host(.card-style-3d) {
                --rc-desc-bg: transparent; --rc-desc-badge: var(--v-warning-text); --rc-desc-label: var(--v-warning-text); --rc-desc-top: 3px solid var(--v-warning-text);
                --rc-sol-bg: transparent; --rc-sol-top: 3px solid #1f9d55; --rc-sol-text: var(--v-text-soft); --rc-sol-weight: 400;
                --rc-disc-bg: transparent; --rc-disc-badge: var(--v-muted); --rc-disc-label: var(--v-muted); --rc-disc-top: 3px solid var(--v-muted-3); --rc-disc-text: var(--v-text-soft);
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
            .launcher.dragging { transition: none; cursor: grabbing; }
            .launcher.dragging:hover { transform: none; }

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
                width: min(calc(1720px * var(--v-modal-scale)), 99vw); height: min(calc(1180px * var(--v-modal-scale)), 98vh); margin: auto;
                background: var(--v-page); color: var(--v-text); border: 1px solid var(--v-outer-border); border-radius: 14px;
                box-shadow: 0 24px 70px rgba(16,39,64,.35); overflow: hidden;
                transition: background .2s, color .2s, border-color .2s;
            }
            /* O zoom da fonte fica AQUI, não em .dialog: .dialog usa vw/vh pra
               caber na tela (99vw/98vh), e zoom num elemento que também usa
               unidades de viewport pra definir o próprio tamanho embaralha as
               duas contas — foi isso que fazia o modal de Configurações ficar
               mais alto que a tela com a fonte aumentada, cortando os botões
               do rodapé e do "Acervo salvo em disco". Isolando o zoom num
               wrapper interno (100% do .dialog, já com tamanho fixo e correto),
               só o CONTEÚDO aumenta — a caixa externa nunca sai do que cabe. */
            .dialog-zoom {
                position: relative; /* vira o "contexto de posicionamento" dos
                    overlays internos (.settings-overlay, .export-opts-overlay,
                    ambos position:absolute+inset:0) — assim eles ficam
                    inteiramente DENTRO do mesmo sistema de coordenadas com
                    zoom, em vez de serem ancorados no .dialog (que fica FORA
                    do zoom) e só depois renderizados com zoom por herança —
                    essa mistura de contextos era a causa real do corte. */
                width: 100%; height: 100%; display: flex; flex-direction: column; overflow: hidden;
                zoom: var(--v-font-zoom);
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
            /* Faixa de estado do índice em disco — reaproveita a mesma base
               visual da faixa de estatísticas logo acima, pra não introduzir
               uma linguagem visual nova na tela. */
            .index-strip { display: flex; align-items: center; gap: 10px; padding: 6px 20px; background: var(--v-stats-bg); border-bottom: 1px solid var(--v-stats-border); flex-shrink: 0; font-size: 11.5px; color: var(--v-muted); }
            .index-strip[hidden] { display: none; }
            .index-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--v-muted); flex-shrink: 0; }
            .index-dot.working { background: var(--v-accent); animation: tjspIndexPulse 1.1s ease-in-out infinite; }
            .index-dot.ready { background: #2e7d32; }
            @keyframes tjspIndexPulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
            .index-label { flex: 1; }
            .index-track { width: 160px; height: 5px; border-radius: 3px; background: var(--v-stats-border); overflow: hidden; flex-shrink: 0; }
            .index-track[hidden] { display: none; }
            .index-fill { height: 100%; width: 0%; background: var(--v-accent); transition: width .18s linear; }
            .index-reset, .index-measure { border: 1px solid var(--v-stats-border); background: transparent; color: var(--v-muted); border-radius: 999px; padding: 3px 10px; font-size: 10.5px; cursor: pointer; flex-shrink: 0; }
            .index-reset:hover, .index-measure:hover { border-color: var(--v-accent); color: var(--v-accent); }
            .index-report { padding: 10px 20px 12px; background: var(--v-stats-bg); border-bottom: 1px solid var(--v-stats-border); font-size: 11.5px; color: var(--v-text-2); flex-shrink: 0; max-height: 42vh; overflow-y: auto; }
            .index-report[hidden] { display: none; }
            .index-report strong { color: var(--v-accent); }
            .index-report table { border-collapse: collapse; width: 100%; margin: 8px 0; }
            .index-report th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--v-muted); border-bottom: 1px solid var(--v-stats-border); padding: 3px 6px; }
            .index-report td { padding: 3px 6px; border-bottom: 1px solid var(--v-stats-border); }
            .index-report td:nth-child(2), .index-report td:nth-child(3) { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
            .index-report td:nth-child(4) { color: var(--v-muted); font-size: 10.5px; }
            .index-report p { margin: 6px 0 0; line-height: 1.5; }
            .index-report-note { color: var(--v-muted); font-size: 10.5px; }
            .index-report-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
            .index-report-head span { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--v-accent); font-weight: 700; }
            .index-report-close { border: 1px solid var(--v-stats-border); background: var(--v-card-bg); color: var(--v-text-2); border-radius: 6px; width: 24px; height: 24px; font-size: 15px; line-height: 1; cursor: pointer; flex-shrink: 0; }
            .index-report-close:hover { border-color: var(--v-danger-border); color: var(--v-danger-text); }
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
            .card-style-toggle { display: flex; gap: 4px; }
            .card-style-toggle[hidden] { display: none; }
            .view-btn { width: 28px; height: 28px; padding: 0; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; }
            .view-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; }
            .view-btn.active { background: var(--v-accent); color: #fff; border-color: transparent; }

            /* Cabeçalho SEM position:sticky, de propósito. Duas tentativas de
               mantê-lo fixo falharam (z-index e border-collapse) e ele continuava
               aparecendo no meio da lista, por cima das linhas. Rolando junto com
               o conteúdo o problema simplesmente não existe. border-spacing zero
               fica porque o visual com bordas separadas é idêntico. */
            .stats-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 12px; }
            .stats-table th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; color: var(--v-muted); font-weight: 800; padding: 7px 10px; border-bottom: 1px solid var(--v-panel-border); background: var(--v-page); }
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
            .query.query-valid { border-color: var(--v-success-text); box-shadow: 0 0 0 3px var(--v-success-bg); }
            .query.query-invalid { border-color: var(--v-error-text); box-shadow: 0 0 0 3px var(--v-error-bg); }
            .query-validator { display: flex; gap: 7px; align-items: flex-start; margin-top: 7px; font-size: 11.5px; line-height: 1.5; }
            .query-validator[hidden] { display: none; }
            .query-validator svg { width: 13px; height: 13px; flex-shrink: 0; margin-top: 1px; fill: none; stroke: currentColor; stroke-width: 2.3; }
            .query-validator.valid { color: var(--v-success-text); }
            .query-validator.invalid { color: var(--v-error-text); }
            .query-validator.typing { color: var(--v-muted-3); }
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
            .period-group { display: flex; align-items: center; gap: 6px; }
            .period-icon-label { font-size: 11px; font-weight: 700; color: var(--v-muted); text-transform: uppercase; letter-spacing: .03em; }
            .period-group select.date-mode { height: 32px; padding: 0 8px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); font-size: 12px; }
            .period-group .control { display: flex; align-items: center; gap: 5px; }
            .period-group .control[hidden] { display: none; }
            .period-group .control label { margin: 0; font-size: 10.5px; font-weight: 700; color: var(--v-muted); text-transform: none; white-space: nowrap; }
            .period-group input[type="date"] { height: 32px; padding: 0 8px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); font-size: 12px; }
            .period-group input[type="number"] { height: 32px; width: 68px; padding: 0 8px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); font-size: 12px; }
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
                position: absolute; right: 0; top: calc(100% + 8px); z-index: 60;
                width: min(820px, 90vw); max-height: 60vh; overflow: auto;
                background: var(--v-panel); border: 1px solid var(--v-outer-border); border-radius: 10px;
                box-shadow: 0 16px 40px rgba(16,39,64,.28); padding: 16px;
                display: grid; grid-template-columns: 1fr 1fr; gap: 14px;
            }
            .advanced-panel[hidden] { display: none; }
            .panel { padding: 13px; border: 1px solid var(--v-panel-alt-border); border-radius: 8px; background: var(--v-panel-alt); }
            .panel h3 { margin: 0 0 11px; color: var(--v-muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
            .control { position: relative; }
            .control label:not(.option) { display: block; margin-bottom: 5px; font-size: 11px; font-weight: 700; color: var(--v-muted); text-transform: uppercase; letter-spacing: .04em; }
            .control input, .control select { width: 100%; height: 32px; padding: 0 9px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); font-size: 12.5px; }
            .people-grid { display: grid; gap: 10px; }
            .date-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
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
            .extra-gse-block { margin-top: 10px; }
            /* Separada do bloco "Outras GSEs" por uma linha, senão a dica daquele
               bloco parece pertencer a esta caixa. */
            .ignore-gse-wrap { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--v-panel-border); align-items: flex-start; }
            .ignore-gse-wrap[hidden] { display: none; }
            .ignore-gse-hint { display: block; margin-top: 3px; font-size: 10.5px; color: var(--v-muted-3); font-weight: 400; text-transform: none; letter-spacing: normal; }
            .history-gse-progress { margin-top: 8px; font-size: 11.5px; color: var(--v-primary); font-weight: 600; }
            .history-gse-progress[hidden] { display: none; }

            .person-control { position: relative; }
            .person-hint { display: block; margin-top: 4px; font-size: 10.5px; color: var(--v-muted-3); font-weight: 400; text-transform: none; letter-spacing: normal; }
            .specialist-spinner { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border: 2px solid var(--v-stats-border); border-top-color: var(--v-accent); border-radius: 50%; vertical-align: -2px; animation: tjspArchiveSpecialistSpin .65s linear infinite; }
            @keyframes tjspArchiveSpecialistSpin { to { transform: rotate(360deg); } }

            /* Solicitado para / Designado Especialista: campo de busca igual
               ao autocomplete de antes (não o combobox de chips+checkbox das
               GSEs/Status) — mas cada sugestão escolhida ENTRA numa lista em
               vez de substituir a anterior, e o campo limpa sozinho pronto
               pra próxima busca. É assim que o uso real acontece: busca um
               nome, escolhe, busca outro nome, escolhe de novo. */
            .person-multi { position: relative; }
            .person-search-input { width: 100%; height: 34px; padding: 0 10px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); color: var(--v-text); }
            .person-search-input:focus { outline: none; border-color: var(--v-accent); box-shadow: 0 0 0 3px var(--v-focus-shadow); }
            .person-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
            .person-chips:empty { display: none; }
            .specialist-menu {
                position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 80;
                max-height: 220px; overflow: auto; background: var(--v-panel); border: 1px solid var(--v-outer-border); border-radius: 8px;
                box-shadow: 0 10px 26px rgba(32,55,78,.2); padding: 4px;
            }
            .specialist-menu[hidden] { display: none !important; }
            .specialist-option { width: 100%; padding: 8px 10px; border: 0; border-radius: 5px; background: var(--v-panel); color: var(--v-text); text-align: left; cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; }
            .specialist-option:hover, .specialist-option.active { background: var(--v-accent-soft); color: var(--v-accent); }
            .specialist-option.picked { opacity: .5; cursor: default; }
            .specialist-option strong { font-size: 12px; line-height: 1.3; }
            .specialist-option small { font-size: 10px; color: var(--v-muted-3); align-self: center; }
            .specialist-option span { grid-column: 1/-1; font-size: 10px; color: var(--v-muted-3); }
            .specialist-vip { display: inline-block; grid-column: auto; font-size: 9px; font-weight: 800; color: var(--v-vip-text); background: var(--v-vip-bg); border-radius: 4px; padding: 1px 6px; vertical-align: 1px; }
            .specialist-external { display: inline-block; grid-column: auto; font-size: 9px; font-weight: 800; color: var(--v-external-text); background: var(--v-external-bg); border-radius: 4px; padding: 1px 6px; vertical-align: 1px; }
            .specialist-internal { display: inline-block; grid-column: auto; font-size: 9px; font-weight: 800; color: var(--v-internal-text); background: var(--v-internal-bg); border-radius: 4px; padding: 1px 6px; vertical-align: 1px; }
            .specialist-message { padding: 10px; color: var(--v-muted-3); font-size: 11px; text-align: center; }

            /* Combobox com múltipla seleção (GSE / Status / Status Operacional /
               Unidade) — marca/desmarca sem fechar o painel, chips no campo. */
            .combo { position: relative; }
            .combo-box { min-height: 34px; padding: 4px 30px 4px 7px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); display: flex; flex-wrap: wrap; gap: 4px; align-items: center; cursor: text; }
            .combo-box.open, .combo-box:focus-within { border-color: var(--v-accent); box-shadow: 0 0 0 3px var(--v-focus-shadow); }
            .combo-placeholder { color: var(--v-muted-3); font-size: 12px; padding: 2px; }
            .combo-placeholder[hidden] { display: none; }
            .combo-chip { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 5px 0 8px; border-radius: 99px; background: var(--v-accent-soft); border: 1px solid var(--v-accent-soft-border); color: var(--v-accent); font-size: 11px; font-weight: 700; white-space: nowrap; max-width: 160px; }
            .combo-chip span { overflow: hidden; text-overflow: ellipsis; }
            .combo-chip button { border: 0; background: transparent; color: var(--v-accent); font-size: 12px; line-height: 1; cursor: pointer; padding: 0; opacity: .75; flex-shrink: 0; }
            .combo-chip button:hover { opacity: 1; }
            .combo-chip-more { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 99px; background: var(--v-accent-soft); color: var(--v-accent); font-size: 10.5px; font-weight: 700; cursor: pointer; }
            .combo-chip-more:hover { background: var(--v-accent-soft-hover, var(--v-accent-soft)); }
            .combo-caret { position: absolute; right: 8px; top: 50%; transform: translateY(-50%); width: 13px; height: 13px; color: var(--v-muted-3); pointer-events: none; transition: transform .15s; }
            .combo-caret svg { width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 2; }
            .combo-box.open .combo-caret { transform: translateY(-50%) rotate(180deg); }
            .combo-panel { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 30; background: var(--v-panel); border: 1px solid var(--v-outer-border); border-radius: 8px; box-shadow: 0 12px 28px rgba(16,39,64,.22); overflow: hidden; display: none; }
            .combo-panel.open { display: block; }
            .combo-search { padding: 7px; border-bottom: 1px solid var(--v-panel-border); }
            .combo-search input { width: 100%; height: 28px; padding: 0 8px; border: 1px solid var(--v-input-border); border-radius: 5px; background: var(--v-panel); color: var(--v-text); font-size: 12px; }
            .combo-toolbar { display: flex; align-items: center; justify-content: space-between; padding: 5px 10px; background: var(--v-panel-alt); border-bottom: 1px solid var(--v-panel-alt-border); font-size: 10.5px; color: var(--v-muted); }
            .combo-toolbar button { border: 0; background: transparent; color: var(--v-accent); font-weight: 700; font-size: 10.5px; cursor: pointer; padding: 0; }
            .combo-toolbar button:hover { text-decoration: underline; }
            .combo-options { max-height: 220px; overflow-y: auto; overflow-x: hidden; padding: 4px; }
            .combo-option { display: flex; align-items: center; gap: 6px; padding: 6px 7px; border-radius: 5px; cursor: pointer; font-size: 11.5px; color: var(--v-text-2); }
            .combo-option:hover { background: var(--v-accent-soft); }
            .combo-option input { width: 13px; height: 13px; accent-color: var(--v-accent); flex-shrink: 0; }
            .combo-option span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            /* .control label/.control input (estilo dos campos "normais" do
               formulário) são mais específicos que as regras acima sozinhas e
               "vazam" pra cá, já que o combobox mora dentro de um .control —
               essas versões com .combo-panel na frente ganham a disputa de
               especificidade e restauram o layout pretendido. */
            .combo-panel .combo-option { display: flex; text-transform: none; font-weight: 400; font-size: 11.5px; color: var(--v-text-2); letter-spacing: normal; margin-bottom: 0; }
            .combo-panel .combo-option input { width: 13px; height: 13px; padding: 0; border: 0; border-radius: 0; background: none; }
            .combo-panel .combo-option span { display: inline; flex: 1; min-width: 0; }
            .combo-footer { padding: 6px 10px; border-top: 1px solid var(--v-panel-border); display: flex; justify-content: flex-end; }
            .combo-done { height: 25px; padding: 0 12px; border: none; border-radius: 5px; background: var(--v-accent); color: #fff; font-weight: 700; font-size: 10.5px; cursor: pointer; }

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
            .global-badge { font-size: 10px; font-weight: 800; color: var(--v-accent); background: var(--v-accent-soft); border: 1px solid var(--v-accent-soft-border); border-radius: 4px; padding: 1px 7px; }
            .gse-tag { font-size: 10.5px; font-weight: 700; color: var(--v-accent); background: var(--v-accent-soft); border-radius: 4px; padding: 2px 8px; }
            .occ-badge { font-size: 10px; font-weight: 800; color: var(--v-occ-text); background: var(--v-occ-bg); border-radius: 4px; padding: 2px 7px; }
            .sim-badge { font-size: 10px; font-weight: 800; color: var(--v-accent); background: var(--v-sim-bg); border: 1px solid var(--v-sim-border); border-radius: 4px; padding: 2px 7px; }
            .result-card header .date { margin-left: auto; font-size: 11px; color: var(--v-muted-3); }
            .icon-btn { width: 26px; height: 26px; padding: 0; border: 1px solid var(--v-accent-soft-border); border-radius: 6px; background: var(--v-accent-soft); color: var(--v-accent); cursor: pointer; display: flex; align-items: center; justify-content: center; }
            .icon-btn:hover { background: var(--v-accent-soft-hover); }
            .icon-btn svg { width: 13px; fill: none; stroke: currentColor; stroke-width: 2; }
            .field { display: flex; gap: 10px; margin-top: 12px; padding: 9px 11px; border-radius: 8px; font-size: 13px; }
            .field .badge { flex-shrink: 0; width: 20px; height: 20px; margin-top: 1px; border-radius: 6px; font-size: 10px; font-weight: 900; color: #fff; display: flex; align-items: center; justify-content: center; }
            .field .field-body { flex: 1; min-width: 0; }
            .field .field-label { display: flex; align-items: center; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; margin-bottom: 3px; }
            .field p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; color: var(--v-text-soft); }
            .field.collapsed p { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
            .field mark { background: var(--v-mark-bg); color: var(--v-mark-text); border-radius: 2px; padding: 0 1px; }
            .field.f-desc { background: var(--rc-desc-bg); border-top: var(--rc-desc-top); }
            .field.f-desc .badge { background: var(--rc-desc-badge); }
            .field.f-desc .field-label { color: var(--rc-desc-label); }
            .field.f-sol { background: var(--rc-sol-bg); border-top: var(--rc-sol-top); }
            .field.f-sol .badge { background: #1f9d55; }
            .field.f-sol .field-label { color: #1f9d55; }
            .field.f-sol p { color: var(--rc-sol-text); font-weight: var(--rc-sol-weight); }
            .field.f-disc { background: var(--rc-disc-bg); border-top: var(--rc-disc-top); }
            .field.f-disc .badge { background: var(--rc-disc-badge); }
            .field.f-disc .field-label { color: var(--rc-disc-label); }
            .field.f-disc p { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.7; color: var(--rc-disc-text); }
            .expand-text { margin-top: 6px; padding: 0; border: 0; background: transparent; color: var(--v-accent); font-size: 11.5px; font-weight: 700; cursor: pointer; }

            /* Discussão em entradas separadas (autor + Interno/Público) em vez
               de texto corrido. Reaproveita as mesmas cores de Interno/Externo
               já usadas no autocomplete de pessoa — mesma lógica de "visível
               por fora ou não". */
            .disc-entry { margin-top: 10px; padding: 8px 10px; border-radius: 6px; background: var(--v-panel); border: 1px solid var(--v-panel-border); }
            .disc-entry:first-child { margin-top: 4px; }
            .disc-meta { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; font-size: 10.5px; }
            .disc-meta strong { color: var(--v-text-2); font-size: 11px; }
            .disc-visibility { font-size: 9px; font-weight: 800; border-radius: 4px; padding: 1px 6px; text-transform: uppercase; letter-spacing: .03em; }
            .disc-visibility.disc-internal { color: var(--v-internal-text); background: var(--v-internal-bg); }
            .disc-visibility.disc-public { color: var(--v-external-text); background: var(--v-external-bg); }
            .disc-time { margin-left: auto; color: var(--v-muted-3); }
            .disc-body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.6; color: var(--v-text-soft); }
            .disc-body p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
            .focus-scroll .disc-body { font-family: inherit; font-size: 13.5px; line-height: 1.6; }
            .focus-scroll .disc-entry { background: var(--v-panel-alt); border-color: var(--v-panel-alt-border); }

            /* Modo expandido: Descrição/Solução com formatação e imagem
               originais, mais o botão de copiar com formatação. */
            .field.rich .field-label { display: flex; align-items: center; gap: 8px; }
            .copy-rich { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; height: 22px; padding: 0 8px; border: 1px solid var(--v-accent-soft-border); border-radius: 5px; background: var(--v-accent-soft); color: var(--v-accent); font-size: 10.5px; font-weight: 700; cursor: pointer; text-transform: none; letter-spacing: normal; }
            .copy-rich:hover { background: var(--v-accent-soft-hover); }
            .copy-rich svg { width: 12px; height: 12px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
            .rich-html { margin-top: 6px; font-size: 14px; line-height: 1.65; color: var(--v-text-soft); overflow-wrap: anywhere; }
            .rich-html img { max-width: 100%; border-radius: 6px; margin: 6px 0; display: block; }
            .rich-html p { margin: 0 0 10px; }
            .rich-html p:last-child { margin-bottom: 0; }
            .rich-html a { color: var(--v-accent); }
            .rich-html ul, .rich-html ol { padding-left: 20px; margin: 0 0 10px; }
            .result-card footer { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--v-panel-border); font-size: 12px; color: var(--v-text-2); }
            .result-card footer small { display: block; font-size: 10px; text-transform: uppercase; color: var(--v-muted); margin-bottom: 2px; }
            .empty { padding: 60px; text-align: center; color: var(--v-muted-3); }
            .trickle-footer { display: flex; align-items: center; gap: 9px; margin-top: 6px; padding: 10px 14px; background: var(--v-stats-bg); border: 1px solid var(--v-stats-border); border-radius: 8px; font-size: 12px; color: var(--v-muted-2); }
            .trickle-footer .specialist-spinner { margin-right: 0; }
            .pagination { padding: 11px 20px; background: var(--v-panel); border-top: 1px solid var(--v-panel-border); display: flex; justify-content: center; align-items: center; gap: 12px; flex-shrink: 0; }
            .pagination[hidden] { display: none; }
            .pagination button { height: 32px; padding: 0 12px; border: 1px solid var(--v-input-border); background: var(--v-panel); color: var(--v-text); border-radius: 6px; cursor: pointer; }
            .pagination button:disabled { opacity: .45; cursor: not-allowed; }
            .pagination span { font-size: 12px; color: var(--v-muted); }

            .focus-overlay { position: absolute; inset: 0; z-index: 25; padding: 18px; background: var(--v-overlay); backdrop-filter: blur(2px); display: flex; }
            .focus-overlay[hidden] { display: none; }

            .export-opts-overlay { position: absolute; inset: 0; z-index: 30; padding: 18px; background: var(--v-overlay); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; }
            .export-opts-overlay[hidden] { display: none; }
            /* max-height em % do .export-opts-overlay (que já preenche o
               .dialog inteiro via inset:0), não em vh: vh dentro do
               .dialog-zoom com zoom aplicado mede errado (mesma causa do bug
               do .settings-body — ver comentário lá). % do ancestral com
               altura definida não tem essa ambiguidade. */
            .export-opts-body { width: min(460px,100%); max-height: 100%; overflow-y: auto; background: var(--v-card-bg); border: 1px solid var(--v-outer-border); border-top: 4px solid var(--v-header-border); border-radius: 10px; box-shadow: 0 18px 50px rgba(15,35,55,.32); padding: 20px 22px; }
            .export-opts-body h3 { margin: 0 0 14px; font-size: 15px; color: var(--v-text); }
            .export-opts-sub { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--v-accent); font-weight: 700; margin: 16px 0 8px; }
            .export-opts-checks { display: flex; flex-direction: column; gap: 10px; margin: 8px 0 4px; }
            .export-opts-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
            .export-format-seg, .export-layout-seg { display: flex; flex-wrap: wrap; gap: 6px; }
            .fmt-btn, .lay-btn { border: 1px solid var(--v-input-border); background: var(--v-panel); color: var(--v-text-2); border-radius: 999px; padding: 6px 13px; font-size: 12px; cursor: pointer; }
            .fmt-btn.active, .lay-btn.active { background: var(--v-accent); border-color: var(--v-accent); color: #fff; font-weight: 700; }
            .export-fields-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
            .export-field { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--v-text); padding: 6px 8px; border: 1px solid var(--v-input-border); border-radius: 6px; background: var(--v-panel); cursor: pointer; }
            .export-field input { accent-color: var(--v-accent); }
            .export-field.on { border-color: var(--v-accent-soft-border); background: var(--v-accent-soft); }
            .export-sheets-note { text-transform: none; letter-spacing: normal; font-weight: 400; color: var(--v-muted); }
            .export-sheets-note[hidden], .export-layout-wrap[hidden], .export-doc-opts[hidden] { display: none; }

            .settings-overlay { position: absolute; inset: 0; z-index: 31; padding: 18px; background: var(--v-overlay); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; }
            .settings-overlay[hidden] { display: none; }
            /* max-height em % do .settings-overlay (que já preenche o .dialog
               inteiro via inset:0), NÃO em vh — era esse o bug: .settings-
               overlay vive dentro de .dialog-zoom, que tem zoom aplicado, e
               unidades de viewport (vh/vw) medidas de dentro de um elemento
               com zoom saem erradas — 90vh acabava sendo maior que o espaço
               real disponível, cortando rodapé e conteúdo. % do ancestral (já
               corretamente limitado ao tamanho real do .dialog, calculado
               FORA do zoom) não sofre disso. */
            .settings-body { width: min(480px,100%); max-height: 100%; display: flex; flex-direction: column; background: var(--v-card-bg); border: 1px solid var(--v-outer-border); border-top: 4px solid var(--v-header-border); border-radius: 10px; box-shadow: 0 18px 50px rgba(15,35,55,.32); }
            .settings-body header { flex-shrink: 0; display: flex; align-items: center; padding: 14px 18px; border-bottom: 1px solid var(--v-panel-alt-border); background: var(--v-panel-alt); border-radius: 9px 9px 0 0; }
            .settings-body header h3 { flex: 1; margin: 0; font-size: 15px; color: var(--v-text); }
            .settings-close { border: none; background: transparent; color: var(--v-muted); font-size: 20px; line-height: 1; cursor: pointer; }
            .settings-content { padding: 18px 22px; position: relative; overflow-y: auto; flex: 1; }
            .settings-section-label { display: flex; align-items: center; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; color: var(--v-muted); margin: 0 0 6px; }
            .settings-hint { font-size: 12px; line-height: 1.5; color: var(--v-muted-2); margin: 0 0 12px; }
            .settings-team-hint { font-size: 12px; line-height: 1.5; color: var(--v-muted-2); margin: 0 0 10px; }
            .settings-error { font-size: 12px; color: var(--v-error-text); margin: 10px 0 0; }
            .settings-error[hidden] { display: none; }
            .settings-body footer { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--v-panel-alt-border); }
            .storage-panel { border: 1px solid var(--v-panel-alt-border); border-radius: 8px; padding: 10px 12px; background: var(--v-panel-alt); }
            .storage-summary { font-size: 11.5px; color: var(--v-text-2); margin-bottom: 8px; line-height: 1.5; }
            .storage-summary strong { color: var(--v-accent); }
            .storage-list { display: flex; flex-direction: column; gap: 6px; max-height: 190px; overflow-y: auto; }
            .storage-row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; background: var(--v-card-bg); border: 1px solid var(--v-panel-alt-border); border-radius: 6px; }
            .storage-row-main { flex: 1; min-width: 0; }
            .storage-row-name { display: block; font-size: 12px; font-weight: 600; color: var(--v-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .storage-row-meta { display: block; font-size: 10.5px; color: var(--v-muted); margin-top: 1px; }
            .storage-row-del { border: 1px solid var(--v-danger-border); background: transparent; color: var(--v-danger-text); border-radius: 999px; padding: 3px 9px; font-size: 10.5px; cursor: pointer; flex-shrink: 0; }
            .storage-row-del:disabled { opacity: .45; cursor: not-allowed; }
            .storage-empty { font-size: 11.5px; color: var(--v-muted); padding: 6px 2px; }
            .storage-actions { display: flex; gap: 8px; margin-top: 10px; }
            .storage-actions .btn { font-size: 11.5px; padding: 5px 12px; }
            .storage-progress { height: 5px; border-radius: 3px; background: var(--v-panel-alt-border); overflow: hidden; margin-top: 8px; }
            .storage-progress[hidden] { display: none; }
            .storage-progress-fill { height: 100%; width: 0%; background: var(--v-accent); transition: width .18s linear; }
            .storage-note { font-size: 10.5px; color: var(--v-muted); margin: 6px 0 0; line-height: 1.5; }
            .appearance-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
            .appearance-row label { flex: 1; font-size: 12.5px; font-weight: 600; color: var(--v-text-2); display: flex; align-items: center; gap: 8px; }
            .appearance-value { font-size: 11px; font-weight: 700; color: var(--v-accent); min-width: 34px; }
            .appearance-control { display: flex; align-items: center; gap: 8px; }
            .appearance-control input[type="range"] { width: 140px; accent-color: var(--v-accent); cursor: pointer; }
            .appearance-reset { height: 26px; width: 26px; padding: 0; border-radius: 6px; font-size: 13px; justify-content: center; flex-shrink: 0; }
            .settings-team-add-toggle { margin-left: auto; border: none; background: transparent; color: var(--v-accent); font-size: 11px; font-weight: 700; text-transform: none; letter-spacing: normal; cursor: pointer; }
            .team-pills { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
            .team-pills[hidden] { display: none; }
            .settings-suggested-toggle { margin-left: auto; border: 1px solid var(--v-input-border); background: transparent; color: var(--v-accent); font-size: 11px; font-weight: 700; text-transform: none; letter-spacing: normal; cursor: pointer; border-radius: 999px; padding: 3px 11px; }
            .settings-suggested-toggle.open { background: var(--v-accent-soft); border-color: var(--v-accent-soft-border); }
            .settings-team-add-toggle { margin-left: 8px; }
            .suggested-teams-box { border: 1px solid var(--v-panel-border); border-radius: 8px; padding: 10px 12px; margin: 0 0 14px; background: var(--v-panel-alt); }
            .suggested-teams-box[hidden] { display: none; }
            .suggested-teams-box .team-pills { margin: 0; }
            /* Não adotada: contorno neutro. Adotada (.selected): preenchida no
               azul, com ícone de check — o feedback claro de marcado/desmarcado. */
            .team-pill { display: inline-flex; align-items: center; gap: 6px; height: 27px; padding: 0 11px 0 9px; border: 1px solid var(--v-input-border); border-radius: 14px; background: transparent; color: var(--v-text-2); font-size: 11.5px; font-weight: 700; cursor: pointer; }
            .team-pill:hover { border-color: var(--v-accent); color: var(--v-accent); }
            .team-pill.selected { background: var(--v-accent); border-color: var(--v-accent); color: #fff; }
            .team-pill.selected:hover { color: #fff; }
            .team-pill svg { width: 13px; height: 13px; stroke: currentColor; fill: none; stroke-width: 2.3; }
            .team-pill .n { color: inherit; opacity: .7; font-weight: 400; }
            .team-new-form { border: 1px solid var(--v-panel-border); border-radius: 8px; padding: 12px; margin: 0 0 16px; background: var(--v-panel-alt); }
            .team-new-form[hidden] { display: none; }
            .team-new-form .control { margin-bottom: 10px; }
            .team-new-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
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
            .focus-scroll .field { margin-top: 18px; }
            .focus-scroll .field:first-child { margin-top: 0; }
            .focus-scroll .field p { font-size: 14px; line-height: 1.65; }
            /* No modal expandido mostra o texto inteiro sempre — o recurso de
               truncar/"Mostrar mais" só faz sentido no card compacto. */
            .focus-scroll .field.collapsed p { display: block; -webkit-line-clamp: unset; overflow: visible; }
            .focus-scroll .expand-text { display: none; }
            .focus-scroll footer { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; padding: 14px; background: var(--v-panel-alt); border: 1px solid var(--v-panel-alt-border); border-radius: 8px; }
            .focus-scroll footer small { display: block; font-size: 10px; text-transform: uppercase; color: var(--v-muted); margin-bottom: 3px; }
            /* Mesma tipografia do rodapé dos cartões não expandidos (12px, sem
               negrito), só que proporcionalmente maior para a tela expandida.
               A GSE saiu daqui: já aparece no cabeçalho, ao lado da data. */
            .focus-scroll footer span { display: block; font-size: 13.5px; font-weight: 400; color: var(--v-text-2); line-height: 1.4; }
            /* Separa a GSE da data de criação com um respiro e um traço leve,
               em vez do ponto colado que as deixava parecendo um campo só. */
            .focus-gse { margin-left: 12px; padding-left: 12px; border-left: 1px solid var(--v-header-border); }

            @media (max-width: 960px) {
                .advanced-panel, .date-grid { grid-template-columns: 1fr; }
                .stats-gse { display: none; }
                .keyboard-help { display: none; }
            }
        </style>
        <button class="launcher" type="button" title="Pesquisa completa no acervo SMAX"><svg viewBox="0 0 24 24"><path d="M4 6h16M4 11h16M4 16h10"></path><circle cx="18" cy="18" r="3.2"></circle><path d="M20.3 20.3L23 23"></path></svg></button>
        <button class="restore-pill" type="button" hidden></button>
        <div class="overlay"><section class="dialog"><div class="dialog-zoom">
            <header class="top">
                <svg class="top-icon" viewBox="0 0 24 24"><path d="M4 6h16M4 11h16M4 16h10"></path><circle cx="18" cy="18" r="3.2"></circle><path d="M20.3 20.3L23 23"></path></svg>
                <div class="top-titles"><h2>Pesquisa Avançada SMAX</h2><small>v${VERSION} · Pesquisa por termos, por semelhança e estatística nas solicitações do SMAX</small></div>
                <button class="header-icon-btn theme-toggle" type="button" title="Alternar tema claro/escuro">
                    <svg class="icon-moon" viewBox="0 0 24 24"><path d="M21 12.5A8.5 8.5 0 1111.5 3a7 7 0 009.5 9.5z"></path></svg>
                    <svg class="icon-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"></path></svg>
                </button>
                <button class="header-icon-btn settings-toggle" type="button" title="Configurações do script">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 005 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"></path></svg>
                </button>
                <button class="header-icon-btn minimize" type="button" title="Minimizar (sem perder o acervo carregado)"><svg viewBox="0 0 24 24"><path d="M5 12h14"></path></svg></button>
                <button class="header-icon-btn close" type="button">×</button>
            </header>
            <div class="stats-strip" hidden>
                <div class="stats-main"><span class="count"></span><small class="loaded-at"></small><small class="range"></small></div>
                <div class="stats-gse"></div>
            </div>
            <div class="index-strip" hidden>
                <span class="index-dot"></span>
                <span class="index-label"></span>
                <div class="index-track" hidden><div class="index-fill"></div></div>
                <button class="index-measure" type="button" title="Lê uma amostra do que está salvo e mostra quanto cada campo ocupa, para decidir onde vale economizar espaço.">Medir espaço</button>
                <button class="index-reset" type="button" title="Apaga o acervo salvo em disco e força a próxima carga a baixar e indexar tudo de novo. Use quando chamados já indexados mudaram de status — a sincronização incremental só traz chamados novos.">Reindexar do zero</button>
            </div>
            <div class="index-report" hidden></div>
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
                    <div class="query-validator" hidden></div>
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
                    <p class="stats-intro">GSE já vem pronta pra usar (sem ela não tem o que contar) — o período fica sempre visível ali embaixo, junto das opções de busca, e já entra na própria consulta ao SMAX. Os demais filtros são opcionais — clique pra abrir só os que for usar.</p>
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
                            <div class="control"><label>Status</label>
                                <div class="combo" id="statusCombo">
                                    <div class="combo-box" tabindex="0"><span class="combo-placeholder">Qualquer status</span><span class="combo-caret"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></span></div>
                                    <div class="combo-panel">
                                        <div class="combo-search"><input type="text" placeholder="Digite pra filtrar..."></div>
                                        <div class="combo-toolbar"><span class="combo-count">0 selecionado(s)</span><button type="button" class="combo-clear">Desmarcar todos</button></div>
                                        <div class="combo-options"></div>
                                        <div class="combo-footer"><button type="button" class="combo-done">Concluído</button></div>
                                    </div>
                                </div>
                            </div>
                            <div class="control"><label>Status Operacional</label>
                                <div class="combo" id="statusOperacionalCombo">
                                    <div class="combo-box" tabindex="0"><span class="combo-placeholder">Qualquer status operacional</span><span class="combo-caret"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></span></div>
                                    <div class="combo-panel">
                                        <div class="combo-search"><input type="text" placeholder="Digite pra filtrar..."></div>
                                        <div class="combo-toolbar"><span class="combo-count">0 selecionado(s)</span><button type="button" class="combo-clear">Desmarcar todos</button></div>
                                        <div class="combo-options"></div>
                                        <div class="combo-footer"><button type="button" class="combo-done">Concluído</button></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="stats-tag-slot control" id="statsUnidadeSlot" hidden><label>Unidade/Comarca</label>
                            <div class="combo" id="unidadeCombo">
                                <div class="combo-box" tabindex="0"><span class="combo-placeholder">Buscar e marcar unidades...</span><span class="combo-caret"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></span></div>
                                <div class="combo-panel">
                                    <div class="combo-search"><input type="text" placeholder="Ex.: campinas, araraquara..."></div>
                                    <div class="combo-toolbar"><span class="combo-count">0 selecionado(s)</span><button type="button" class="combo-clear">Desmarcar todos</button></div>
                                    <div class="combo-options"></div>
                                    <div class="combo-footer"><button type="button" class="combo-done">Concluído</button></div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="stats-row"><button class="stats-search" type="button">Calcular</button></div>
                </div>
            </section>
            <div class="actions-row">
                <button class="btn btn-secondary load" type="button" title="Pesquisar já carrega/recarrega sozinho quando precisa — use isto só se quiser forçar dados mais recentes do SMAX sem mudar nenhum filtro."><svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0114-5.3M20 12a8 8 0 01-14 5.3"></path><path d="M18 4v4h-4M6 20v-4h4"></path></svg>Recarregar acervo</button>
                <button class="btn btn-danger cancel-load" type="button" hidden>Cancelar</button>
                <button class="btn btn-danger cancel-search" type="button" hidden title="Interrompe a pesquisa em andamento. Os resultados anteriores continuam na tela.">Cancelar pesquisa</button>
                <div class="field-checks"><span class="field-checks-label">Buscar em:</span>
                    <label class="option-inline"><input class="field-description" type="checkbox" checked><span>Descrição</span></label>
                    <label class="option-inline"><input class="field-solution" type="checkbox" checked><span>Solução</span></label>
                    <label class="option-inline" title="Precisa estar marcada ANTES de clicar em Pesquisar/Buscar semelhantes na primeira vez — o acervo recarrega sozinho quando isso muda."><input class="field-discussion" type="checkbox"><span>Discussão</span><svg class="info-icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5.5"></path><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"></circle></svg></label>
                </div>
                <select class="mode control-inline"><option value="any">Qualquer palavra</option><option value="exact">Expressão exata</option></select>
                <select class="sort-select"><option value="recent">Mais recentes</option><option value="oldest">Mais antigas</option><option value="relevance" class="sort-text-only">Mais ocorrências</option><option value="similarity" class="sort-text-only">Mais semelhantes</option></select>
                <div class="period-group" title="Restringe a própria consulta ao SMAX — mudar o período recarrega o acervo.">
                    <span class="period-icon-label">Período</span>
                    <select class="date-mode"><option value="any">Qualquer data</option><option value="days" selected>Últimos N dias</option><option value="on">Em uma data</option><option value="after">A partir de</option><option value="before">Até uma data</option><option value="between">Entre duas datas</option></select>
                    <div class="control date-days-wrap"><input class="date-days" type="number" min="1" value="180"></div>
                    <div class="control date-from-wrap" hidden><label class="date-from-label">Data</label><input class="date-from" type="date"></div>
                    <div class="control date-to-wrap" hidden><label class="date-to-label">Até</label><input class="date-to" type="date"></div>
                </div>
                <div class="advanced-toggle-wrap">
                    <button class="btn btn-secondary advanced-toggle" type="button" aria-expanded="false">Filtros avançados<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></button>
                    <div class="advanced-panel" hidden>
                        <section class="panel"><h3>Pessoas</h3><div class="people-grid">
                            <div class="control person-control" id="filterRequestedForControl"><label>Solicitado para</label>
                                <div class="person-multi" id="requestedForCombo">
                                    <input type="text" class="person-search-input" placeholder="Digite 2+ letras para sugestões" autocomplete="off">
                                    <div class="specialist-menu" hidden></div>
                                    <div class="person-chips"></div>
                                </div>
                                <small class="person-hint">Busque, escolha, busque de novo — cada pessoa marcada fica guardada</small>
                            </div>
                            <div class="control person-control" id="filterSpecialistControl"><label>Designado Especialista</label>
                                <div class="person-multi" id="specialistCombo">
                                    <input type="text" class="person-search-input" placeholder="Digite 2+ letras para sugestões" autocomplete="off">
                                    <div class="specialist-menu" hidden></div>
                                    <div class="person-chips"></div>
                                </div>
                                <small class="person-hint">Busque, escolha, busque de novo — cada pessoa marcada fica guardada</small>
                            </div>
                        </div>
                        <label class="option" style="margin-top:10px" id="filterVipControl"><input class="vip-only" type="checkbox"><span>Usuário VIP</span></label>
                        <label class="option" id="filterGlobalControl"><input class="global-only" type="checkbox"><span>Global</span></label>
                        <div style="margin-top:14px">
                            <h3 style="margin:0 0 11px">Data de Envio para Aceite (Solução)</h3>
                            <div class="date-grid">
                                <div class="control"><label>Critério</label><select class="solution-date-mode"><option value="any" selected>Qualquer data</option><option value="days">Últimos N dias</option><option value="on">Em uma data</option><option value="after">A partir de</option><option value="before">Até uma data</option><option value="between">Entre duas datas</option></select></div>
                                <div class="control solution-date-from-wrap" hidden><label class="solution-date-from-label">Data</label><input class="solution-date-from" type="date"></div>
                                <div class="control solution-date-to-wrap" hidden><label class="solution-date-to-label">Até</label><input class="solution-date-to" type="date"></div>
                                <div class="control solution-date-days-wrap" hidden><label>Dias corridos</label><input class="solution-date-days" type="number" min="1" placeholder="Ex.: 7"></div>
                            </div>
                        </div>
                        </section>
                        <section class="panel" id="filterGseSection"><h3>GSEs incluídas na carga</h3>
                            <p class="stats-tag-title team-pills-title" id="gseTeamsTitle" hidden>Minhas equipes</p>
                            <div class="team-pills" id="gseTeams"></div>
                            <div class="gse-tools"><button class="tiny select-all" type="button">Selecionar todas</button><button class="tiny clear-gse" type="button">Limpar</button></div>
                            <div class="gse-list"></div>
                            <div class="extra-gse-block">
                                <p class="stats-tag-title" style="margin-top:10px">Outras GSEs</p>
                                <div class="combo" id="extraGseCombo">
                                    <div class="combo-box" tabindex="0"><span class="combo-placeholder">Buscar e marcar GSEs...</span><span class="combo-caret"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></span></div>
                                    <div class="combo-panel">
                                        <div class="combo-search"><input type="text" placeholder="Ex.: sti, gmud, aciv..."></div>
                                        <div class="combo-toolbar"><span class="combo-count">0 selecionado(s)</span><button type="button" class="combo-clear">Desmarcar todos</button></div>
                                        <div class="combo-options"></div>
                                        <div class="combo-footer"><button type="button" class="combo-done">Concluído</button></div>
                                    </div>
                                </div>
                                <small class="person-hint">Busca em todas as GSEs do SMAX · fica só nesta sessão (some ao recarregar a página)</small>
                            </div>
                            <label class="option ignore-gse-wrap" hidden><input class="ignore-gse" type="checkbox"><span>Ignorar GSE e buscar em todas as solicitações<small class="ignore-gse-hint">Exige Solicitado para ou Designado Especialista. O resultado não é salvo em disco.</small></span></label>
                        </section>
                        <section class="panel" style="grid-column:1/-1"><h3>Passou por GSE</h3>
                            <small class="person-hint">Mostrar somente solicitações que passaram por estas GSEs (consulta o histórico de cada uma).</small>
                            <div class="control" style="margin-top:8px">
                                <p class="stats-tag-title team-pills-title" id="historyTeamsTitle" hidden>Minhas equipes</p>
                                <div class="team-pills" id="historyTeams"></div>
                                <small class="person-hint team-pills-hint" id="historyTeamsHint" hidden>A equipe é expandida em suas GSEs; depois você ainda pode ajustar os itens individualmente.</small>
                                <div class="combo" id="historyGseCombo" style="margin-top:8px">
                                    <div class="combo-box" tabindex="0"><span class="combo-placeholder">Buscar GSEs no histórico...</span><span class="combo-caret"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></span></div>
                                    <div class="combo-panel">
                                        <div class="combo-search"><input type="text" placeholder="Ex.: sti, gmud, aciv..."></div>
                                        <div class="combo-toolbar"><span class="combo-count">0 selecionado(s)</span><button type="button" class="combo-clear">Desmarcar todos</button></div>
                                        <div class="combo-options"></div>
                                        <div class="combo-footer"><button type="button" class="combo-done">Concluído</button></div>
                                    </div>
                                </div>
                                <label class="option history-gse-exclude-wrap"><input class="history-gse-exclude" type="checkbox"><span>Excludente — mostrar só quem NÃO passou por nenhuma das GSEs marcadas</span></label>
                                <small class="person-hint history-gse-hint">Lógica OU — basta ter passado por qualquer uma das GSEs marcadas. Consulta o histórico de cada solicitação (pode levar alguns segundos).</small>
                            </div>
                            <div class="history-gse-progress" hidden><span class="history-gse-progress-text"></span></div>
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
                        <button class="export-open" data-format="xlsx" type="button">📊 Excel (.xlsx)</button>
                        <button class="export-open" data-format="html" type="button">🌐 HTML (imprimível/PDF)</button>
                        <button class="export-open" data-format="md" type="button">✍ Markdown (.md)</button>
                        <button class="export-open" data-format="txt" type="button">📝 Texto (.txt)</button>
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
                <div class="card-style-toggle">
                    <button type="button" class="view-btn active" data-card-style="3b" title="Descrição/Solução/Discussão com fundo preenchido"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3" fill="currentColor" stroke="none"></rect></svg></button>
                    <button type="button" class="view-btn" data-card-style="3d" title="Descrição/Solução/Discussão só com barra colorida no topo"><svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="3"></rect><path d="M4.8 4h14.4" stroke-width="3.5"></path></svg></button>
                </div>
                <span class="keyboard-help">Teclas ↑ e ↓ navegam · Enter expande</span>
            </nav>
            <div class="progress" hidden><div class="progress-text"></div><div class="track"><div class="fill"></div></div></div>
            <div class="status"></div>
            <main class="results"><div class="empty">Carregue o acervo completo e pesquise.</div></main>
            <footer class="pagination" hidden><button class="prev-page">Anterior</button><span class="page-info"></span><button class="next-page">Próxima</button></footer>
            <div class="focus-overlay" hidden><div class="focus-body"></div></div>
            <div class="export-opts-overlay" hidden>
                <div class="export-opts-body">
                    <h3>Exportar relatório</h3>
                    <p class="export-opts-sub">Formato</p>
                    <div class="export-format-seg">
                        <button type="button" class="fmt-btn" data-format="xlsx">Excel</button>
                        <button type="button" class="fmt-btn" data-format="html">HTML</button>
                        <button type="button" class="fmt-btn" data-format="md">Markdown</button>
                        <button type="button" class="fmt-btn" data-format="txt">Texto</button>
                    </div>
                    <div class="control" style="margin-top:14px">
                        <label>Nome do relatório (opcional)</label>
                        <input type="text" class="export-opts-name" placeholder="Ex.: Levantamento GSE — julho/2026">
                    </div>
                    <p class="export-opts-sub">Campos de cada solicitação</p>
                    <div class="export-fields-grid"></div>
                    <div class="export-doc-opts" hidden>
                        <div class="export-layout-wrap">
                            <p class="export-opts-sub">Layout do relatório</p>
                            <div class="export-layout-seg">
                                <button type="button" class="lay-btn" data-layout="cards">Fichas (texto completo)</button>
                                <button type="button" class="lay-btn" data-layout="table">Tabela compacta</button>
                            </div>
                        </div>
                        <p class="export-opts-sub">Seções extras<span class="export-sheets-note"> (no Excel, cada uma vira uma aba)</span></p>
                        <div class="export-opts-checks">
                            <label class="option"><input type="checkbox" class="export-opts-filters" checked><span>Filtros utilizados</span></label>
                            <label class="option"><input type="checkbox" class="export-opts-indice" checked><span>Índice do relatório</span></label>
                            <label class="option"><input type="checkbox" class="export-opts-distribuicao" checked><span>Distribuição do que foi exportado</span></label>
                        </div>
                    </div>
                    <div class="export-opts-actions">
                        <button type="button" class="btn btn-secondary export-opts-cancel">Cancelar</button>
                        <button type="button" class="btn btn-primary export-opts-confirm">Exportar</button>
                    </div>
                </div>
            </div>
            <div class="settings-overlay" hidden>
                <div class="settings-body">
                    <header>
                        <h3>Configurações do script</h3>
                        <button type="button" class="settings-close" title="Fechar">×</button>
                    </header>
                    <div class="settings-content">
                        <p class="settings-section-label">Equipes<button type="button" class="settings-suggested-toggle">Equipes sugeridas</button><button type="button" class="settings-team-add-toggle">+ Criar equipe</button></p>
                        <p class="settings-team-hint">Adotar uma equipe marca todas as GSEs dela nas suas GSEs padrão, abaixo. Você pode ajustar depois, sem afetar ninguém.</p>
                        <div class="team-pills" id="settingsUserTeams" hidden></div>
                        <div class="suggested-teams-box" id="suggestedTeamsBox" hidden>
                            <p class="settings-team-hint" style="margin-top:0">Equipes que já deixamos prontas — clique para adotar as GSEs dela como suas.</p>
                            <div class="team-pills" id="suggestedTeams"></div>
                        </div>
                        <div class="team-new-form" id="teamNewForm" hidden>
                            <div class="control"><label>Nome da equipe</label><input type="text" class="team-new-name" placeholder="Ex.: SGS 2.2.3"></div>
                            <div class="combo" id="teamNewGseCombo">
                                <div class="combo-box" tabindex="0"><span class="combo-placeholder">Buscar e marcar GSEs da equipe...</span><span class="combo-caret"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></span></div>
                                <div class="combo-panel">
                                    <div class="combo-search"><input type="text" placeholder="Ex.: sti, gmud, aciv..."></div>
                                    <div class="combo-toolbar"><span class="combo-count">0 selecionado(s)</span><button type="button" class="combo-clear">Desmarcar todos</button></div>
                                    <div class="combo-options"></div>
                                    <div class="combo-footer"><button type="button" class="combo-done">Concluído</button></div>
                                </div>
                            </div>
                            <div class="team-new-actions">
                                <button type="button" class="btn btn-secondary team-new-cancel">Cancelar</button>
                                <button type="button" class="btn btn-primary team-new-save">Salvar equipe</button>
                            </div>
                        </div>
                        <p class="settings-section-label" style="margin-top:16px">GSEs padrão</p>
                        <p class="settings-hint">Ficam marcadas toda vez que você abrir a pesquisa. Dá pra desmarcar ou adicionar outras pontualmente em cada busca (inclusive pela busca de "Outras GSEs") sem afetar essa configuração — e valem pras 3 abas (Termos, Semelhança e Estatística), que compartilham a mesma seleção.</p>
                        <div class="combo" id="settingsGseCombo">
                            <div class="combo-box" tabindex="0"><span class="combo-placeholder">Buscar e marcar GSEs...</span><span class="combo-caret"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"></path></svg></span></div>
                            <div class="combo-panel">
                                <div class="combo-search"><input type="text" placeholder="Ex.: sti, gmud, aciv..."></div>
                                <div class="combo-toolbar"><span class="combo-count">0 selecionado(s)</span><button type="button" class="combo-clear">Desmarcar todos</button></div>
                                <div class="combo-options"></div>
                                <div class="combo-footer"><button type="button" class="combo-done">Concluído</button></div>
                            </div>
                        </div>
                        <p class="settings-error" hidden>Selecione ao menos uma GSE antes de salvar.</p>
                        <p class="settings-section-label" style="margin-top:18px">Aparência</p>
                        <p class="settings-hint">Tamanho do modal e da fonte, cada um ajustável na hora — sem precisar clicar em Salvar. Fica guardado só neste navegador, não afeta mais ninguém.</p>
                        <div class="appearance-row">
                            <label>Tamanho do modal <span class="appearance-value modal-scale-value">100%</span></label>
                            <div class="appearance-control">
                                <input type="range" class="modal-scale-range" min="80" max="140" step="5" value="100">
                                <button type="button" class="btn btn-secondary appearance-reset modal-scale-reset" title="Voltar ao padrão (100%)">↺</button>
                            </div>
                        </div>
                        <div class="appearance-row">
                            <label>Tamanho da fonte <span class="appearance-value font-zoom-value">100%</span></label>
                            <div class="appearance-control">
                                <input type="range" class="font-zoom-range" min="80" max="140" step="5" value="100">
                                <button type="button" class="btn btn-secondary appearance-reset font-zoom-reset" title="Voltar ao padrão (100%)">↺</button>
                            </div>
                        </div>
                        <p class="settings-section-label storage-only" style="margin-top:18px">Acervo salvo em disco</p>
                        <p class="settings-hint storage-only">O que já está indexado neste navegador, por GSE. Apagar uma GSE libera o espaço dela e faz a próxima carga baixá-la inteira de novo — as demais continuam intactas. Nada aqui sai desta máquina.</p>
                        <div class="storage-panel storage-only">
                            <div class="storage-summary"></div>
                            <div class="storage-list"></div>
                            <label class="option" style="margin-bottom:8px"><input class="autosync-toggle" type="checkbox" checked><span>Manter o acervo atualizado sozinho (verifica a cada 5 min enquanto esta aba estiver aberta)</span></label>
                            <div class="storage-actions">
                                <button type="button" class="btn btn-secondary storage-refresh">Atualizar</button>
                                <button type="button" class="btn btn-danger storage-wipe">Apagar tudo</button>
                            </div>
                            <div class="storage-progress" hidden><div class="storage-progress-fill"></div></div>
                            <p class="storage-note"></p>
                        </div>
                    </div>
                    <footer>
                        <button type="button" class="btn btn-secondary settings-cancel">Cancelar</button>
                        <button type="button" class="btn btn-primary settings-save">Salvar</button>
                    </footer>
                </div>
            </div>
</div></section></div>`;

        ui = {
            launcher: shadow.querySelector(".launcher"), overlay: shadow.querySelector(".overlay"), close: shadow.querySelector(".close"), themeToggle: shadow.querySelector(".theme-toggle"),
            minimize: shadow.querySelector(".minimize"), restorePill: shadow.querySelector(".restore-pill"),
            settingsToggle: shadow.querySelector(".settings-toggle"), settingsOverlay: shadow.querySelector(".settings-overlay"), settingsClose: shadow.querySelector(".settings-close"),
            settingsGseComboRoot: shadow.getElementById("settingsGseCombo"), settingsError: shadow.querySelector(".settings-error"),
            settingsCancel: shadow.querySelector(".settings-cancel"), settingsSave: shadow.querySelector(".settings-save"),
            modalScaleRange: shadow.querySelector(".modal-scale-range"), modalScaleValue: shadow.querySelector(".modal-scale-value"), modalScaleReset: shadow.querySelector(".modal-scale-reset"),
            fontZoomRange: shadow.querySelector(".font-zoom-range"), fontZoomValue: shadow.querySelector(".font-zoom-value"), fontZoomReset: shadow.querySelector(".font-zoom-reset"),
            settingsUserTeams: shadow.getElementById("settingsUserTeams"), settingsTeamAddToggle: shadow.querySelector(".settings-team-add-toggle"),
            settingsSuggestedToggle: shadow.querySelector(".settings-suggested-toggle"), suggestedTeamsBox: shadow.getElementById("suggestedTeamsBox"), suggestedTeams: shadow.getElementById("suggestedTeams"),
            teamNewForm: shadow.getElementById("teamNewForm"), teamNewGseComboRoot: shadow.getElementById("teamNewGseCombo"), teamNewName: shadow.querySelector(".team-new-name"),
            teamNewCancel: shadow.querySelector(".team-new-cancel"), teamNewSave: shadow.querySelector(".team-new-save"),
            statsStrip: shadow.querySelector(".stats-strip"), statsCount: shadow.querySelector(".count"), statsLoadedAt: shadow.querySelector(".loaded-at"), statsRange: shadow.querySelector(".range"), statsGseList: shadow.querySelector(".stats-gse"),
            indexStrip: shadow.querySelector(".index-strip"), indexDot: shadow.querySelector(".index-dot"), indexLabel: shadow.querySelector(".index-label"),
            indexTrack: shadow.querySelector(".index-track"), indexFill: shadow.querySelector(".index-fill"), indexReset: shadow.querySelector(".index-reset"),
            indexMeasure: shadow.querySelector(".index-measure"), indexReport: shadow.querySelector(".index-report"),
            query: shadow.querySelector(".query"), search: shadow.querySelector(".search"), queryValidator: shadow.querySelector(".query-validator"),
            semanticQuery: shadow.querySelector(".semantic-query"), semanticSearch: shadow.querySelector(".semantic-search"), semanticLimit: shadow.querySelector(".semantic-limit"),
            fieldDescription: shadow.querySelector(".field-description"), fieldSolution: shadow.querySelector(".field-solution"), fieldDiscussion: shadow.querySelector(".field-discussion"),
            mode: shadow.querySelector(".mode"), sortSelect: shadow.querySelector(".sort-select"), fieldChecks: shadow.querySelector(".field-checks"),
            loadButton: shadow.querySelector(".load"), cancelLoad: shadow.querySelector(".cancel-load"), cancelSearch: shadow.querySelector(".cancel-search"),
            storageSummary: shadow.querySelector(".storage-summary"), storageList: shadow.querySelector(".storage-list"),
            storageRefresh: shadow.querySelector(".storage-refresh"), storageWipe: shadow.querySelector(".storage-wipe"),
            autoSyncToggle: shadow.querySelector(".autosync-toggle"),
            storageProgress: shadow.querySelector(".storage-progress"), storageProgressFill: shadow.querySelector(".storage-progress-fill"), storageNote: shadow.querySelector(".storage-note"),
            advancedToggleWrap: shadow.querySelector(".advanced-toggle-wrap"), advancedToggle: shadow.querySelector(".advanced-toggle"), advancedPanel: shadow.querySelector(".advanced-panel"),
            requestedForComboRoot: shadow.getElementById("requestedForCombo"), specialistComboRoot: shadow.getElementById("specialistCombo"), vipOnly: shadow.querySelector(".vip-only"), globalOnly: shadow.querySelector(".global-only"),
            statusComboRoot: shadow.getElementById("statusCombo"), statusOperacionalComboRoot: shadow.getElementById("statusOperacionalCombo"), unidadeComboRoot: shadow.getElementById("unidadeCombo"),
            statsSearch: shadow.querySelector(".stats-search"),
            dateMode: shadow.querySelector(".date-mode"), dateFrom: shadow.querySelector(".date-from"), dateTo: shadow.querySelector(".date-to"), dateDays: shadow.querySelector(".date-days"),
            dateFromWrap: shadow.querySelector(".date-from-wrap"), dateToWrap: shadow.querySelector(".date-to-wrap"), dateDaysWrap: shadow.querySelector(".date-days-wrap"), dateFromLabel: shadow.querySelector(".date-from-label"), dateToLabel: shadow.querySelector(".date-to-label"),
            solutionDateMode: shadow.querySelector(".solution-date-mode"), solutionDateFrom: shadow.querySelector(".solution-date-from"), solutionDateTo: shadow.querySelector(".solution-date-to"), solutionDateDays: shadow.querySelector(".solution-date-days"),
            solutionDateFromWrap: shadow.querySelector(".solution-date-from-wrap"), solutionDateToWrap: shadow.querySelector(".solution-date-to-wrap"), solutionDateDaysWrap: shadow.querySelector(".solution-date-days-wrap"), solutionDateFromLabel: shadow.querySelector(".solution-date-from-label"), solutionDateToLabel: shadow.querySelector(".solution-date-to-label"),
            gseList: shadow.querySelector(".gse-list"), gseTeams: shadow.getElementById("gseTeams"), gseTeamsTitle: shadow.getElementById("gseTeamsTitle"), ignoreGse: shadow.querySelector(".ignore-gse"), ignoreGseWrap: shadow.querySelector(".ignore-gse-wrap"), extraGseComboRoot: shadow.getElementById("extraGseCombo"), ignoreCase: shadow.querySelector(".ignore-case"), ignoreAccents: shadow.querySelector(".ignore-accents"),
            historyGseComboRoot: shadow.getElementById("historyGseCombo"), historyGseProgress: shadow.querySelector(".history-gse-progress"), historyGseProgressText: shadow.querySelector(".history-gse-progress-text"), historyTeams: shadow.getElementById("historyTeams"), historyTeamsTitle: shadow.getElementById("historyTeamsTitle"), historyTeamsHint: shadow.getElementById("historyTeamsHint"), historyGseExclude: shadow.querySelector(".history-gse-exclude"), historyGseHint: shadow.querySelector(".history-gse-hint"),
            copyButton: shadow.querySelector(".copy"), exportToggle: shadow.querySelector(".export-toggle"), exportWrap: shadow.querySelector(".export-wrap"), exportMenu: shadow.querySelector(".export-menu"),
            exportOptsOverlay: shadow.querySelector(".export-opts-overlay"), exportOptsName: shadow.querySelector(".export-opts-name"),
            exportOptsFilters: shadow.querySelector(".export-opts-filters"), exportOptsIndice: shadow.querySelector(".export-opts-indice"), exportOptsDistribuicao: shadow.querySelector(".export-opts-distribuicao"),
            exportOptsCancel: shadow.querySelector(".export-opts-cancel"), exportOptsConfirm: shadow.querySelector(".export-opts-confirm"),
            exportFieldsGrid: shadow.querySelector(".export-fields-grid"), exportFormatSeg: shadow.querySelector(".export-format-seg"), exportLayoutSeg: shadow.querySelector(".export-layout-seg"),
            exportDocOpts: shadow.querySelector(".export-doc-opts"), exportLayoutWrap: shadow.querySelector(".export-layout-wrap"), exportSheetsNote: shadow.querySelector(".export-sheets-note"),
            previousResult: shadow.querySelector(".previous-result"), nextResult: shadow.querySelector(".next-result"), focusResult: shadow.querySelector(".focus-result"), resultCounter: shadow.querySelector(".result-counter"),
            selectPageCheckbox: shadow.querySelector(".select-page-checkbox"), selectAllResultsButton: shadow.querySelector(".select-all-results"),
            selectionCount: shadow.querySelector(".selection-count"), clearSelectionButton: shadow.querySelector(".clear-selection"), openSelectedButton: shadow.querySelector(".open-selected"),
            statsViewToggle: shadow.querySelector(".stats-view-toggle"), cardStyleToggle: shadow.querySelector(".card-style-toggle"),
            progress: shadow.querySelector(".progress"), progressText: shadow.querySelector(".progress-text"), progressBar: shadow.querySelector(".fill"),
            status: shadow.querySelector(".status"), results: shadow.querySelector(".results"),
            pagination: shadow.querySelector(".pagination"), prevPage: shadow.querySelector(".prev-page"), nextPage: shadow.querySelector(".next-page"), pageInfo: shadow.querySelector(".page-info"),
            focusOverlay: shadow.querySelector(".focus-overlay"), focusBody: shadow.querySelector(".focus-body"),
            exportButton: shadow.querySelector(".export-toggle")
        };

        userDefaultGses = loadGseDefaults();
        userDefaultGses.forEach(entry => { GSE_NAME[entry.id] = entry.name; });
        buildGseList();
        gseListComboInstance = gseListCombo();
        renderTeamPillGroup(ui.gseTeams, ui.gseTeamsTitle, null, adoptedTeams(), gseListComboInstance);
        gseListComboInstance.onChange(() => renderTeamPillGroup(ui.gseTeams, ui.gseTeamsTitle, null, adoptedTeams(), gseListComboInstance));
        ui.settingsGseCombo = installGseCombobox(ui.settingsGseComboRoot, shadow);
        // Mudou a seleção de GSEs padrão (por qualquer via — chip removido,
        // "Desmarcar todos", etc.)? Reflete no estado dos selos de equipe, pra
        // "adotada/não adotada" nunca ficar desatualizado.
        ui.settingsGseCombo.onChange(() => {
            renderTeamTogglers(ui.settingsUserTeams, customTeams, ui.settingsGseCombo);
            renderTeamTogglers(ui.suggestedTeams, NATIVE_TEAMS, ui.settingsGseCombo);
        });
        customTeams = loadCustomTeams();
        getAllTeams().forEach(team => team.gses.forEach(g => { GSE_NAME[g.id] = g.name; }));
        // As equipes NÃO aparecem mais como atalhos fixos no painel de busca —
        // viraram sugestões acessíveis sob demanda nas Configurações/boas-vindas.
        ui.settingsSuggestedToggle.addEventListener("click", () => {
            const show = ui.suggestedTeamsBox.hidden;
            ui.suggestedTeamsBox.hidden = !show;
            ui.settingsSuggestedToggle.classList.toggle("open", show);
        });
        ui.settingsTeamAddToggle.addEventListener("click", () => {
            ui.teamNewForm.hidden = !ui.teamNewForm.hidden;
            if (!ui.teamNewForm.hidden) {
                if (!teamNewGseCombo) teamNewGseCombo = installGseCombobox(ui.teamNewGseComboRoot, shadow);
                ui.teamNewName.focus();
            }
        });
        ui.teamNewCancel.addEventListener("click", () => {
            ui.teamNewForm.hidden = true;
            ui.teamNewName.value = "";
            if (teamNewGseCombo) teamNewGseCombo.setSelected([]);
        });
        ui.teamNewSave.addEventListener("click", () => {
            const name = ui.teamNewName.value.trim();
            const gses = teamNewGseCombo ? teamNewGseCombo.getSelected() : [];
            if (!name || !gses.length) { setStatus("Dê um nome à equipe e marque ao menos uma GSE antes de salvar.", "warning"); return; }
            saveCustomTeams(customTeams.concat([{ id: `custom-${Date.now().toString(36)}`, name, gses: gses.map(o => ({ id: o.value, name: o.label })) }]));
            ui.teamNewForm.hidden = true;
            ui.teamNewName.value = "";
            teamNewGseCombo.setSelected([]);
            // Adota a equipe recém-criada na hora e mostra ela entre as do usuário.
            mergeTeamIntoCombo(ui.settingsGseCombo, { gses: gses.map(o => ({ id: o.value, name: o.label })) });
            renderTeamTogglers(ui.settingsUserTeams, customTeams, ui.settingsGseCombo);
            setStatus(`Equipe "${name}" criada e adotada — clique em Salvar para ela também aparecer como atalho em "Passou por GSE" e na lista de GSEs.`, "success");
        });
        renderQueryValidator();
        statsPreferences = loadPreferences();
        renderPreferencesBar();
        wirePreferencesEvents(shadow);

        // Ícone flutuante arrastável — posição salva por navegador. Um
        // "click" de verdade (sem arrastar) ainda abre o modal; só suprime
        // isso se o ponteiro se moveu mais que um pequeno limiar durante o
        // gesto, pra não abrir sozinho todo arraste.
        (function setupLauncherDrag() {
            const DRAG_THRESHOLD = 4;
            try {
                const saved = JSON.parse(localStorage.getItem(LAUNCHER_POS_STORAGE_KEY) || "null");
                if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) applyLauncherPosition(saved.left, saved.top);
            } catch (_) {}

            function applyLauncherPosition(left, top) {
                const maxLeft = Math.max(0, window.innerWidth - ui.launcher.offsetWidth - 4);
                const maxTop = Math.max(0, window.innerHeight - ui.launcher.offsetHeight - 4);
                const clampedLeft = Math.min(Math.max(0, left), maxLeft);
                const clampedTop = Math.min(Math.max(0, top), maxTop);
                ui.launcher.style.left = `${clampedLeft}px`;
                ui.launcher.style.top = `${clampedTop}px`;
                ui.launcher.style.right = "auto";
                return { left: clampedLeft, top: clampedTop };
            }

            let dragging = false, moved = false, startX = 0, startY = 0, originLeft = 0, originTop = 0;
            ui.launcher.addEventListener("mousedown", event => {
                if (event.button !== 0) return;
                dragging = true; moved = false;
                startX = event.clientX; startY = event.clientY;
                const rect = ui.launcher.getBoundingClientRect();
                originLeft = rect.left; originTop = rect.top;
                event.preventDefault();
            });
            document.addEventListener("mousemove", event => {
                if (!dragging) return;
                const dx = event.clientX - startX, dy = event.clientY - startY;
                if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) { moved = true; ui.launcher.classList.add("dragging"); }
                if (moved) applyLauncherPosition(originLeft + dx, originTop + dy);
            });
            document.addEventListener("mouseup", () => {
                if (!dragging) return;
                dragging = false;
                if (moved) {
                    ui.launcher.classList.remove("dragging");
                    const rect = ui.launcher.getBoundingClientRect();
                    try { localStorage.setItem(LAUNCHER_POS_STORAGE_KEY, JSON.stringify({ left: rect.left, top: rect.top })); } catch (_) {}
                }
            });
            ui.launcher.addEventListener("click", event => {
                if (moved) { event.preventDefault(); event.stopPropagation(); moved = false; return; }
                openMainPanel();
            });
        })();
        // Abrir o painel passa SEMPRE por aqui, pra a configuração obrigatória
        // de primeira vez ser verificada em qualquer caminho de abertura — antes
        // ela dependia só do clique no ícone, e num caso relatado (primeira
        // execução de um colega) a tela de boas-vindas simplesmente não vinha.
        function openMainPanel() {
            host.classList.add("open");
            if (!userDefaultGses.length) openSettingsModal(true);
        }
        ui.close.addEventListener("click", () => { host.classList.remove("open"); ui.restorePill.hidden = true; });
        ui.settingsToggle.addEventListener("click", () => openSettingsModal(false));
        ui.settingsClose.addEventListener("click", closeSettingsModal);
        ui.settingsCancel.addEventListener("click", closeSettingsModal);
        ui.settingsSave.addEventListener("click", saveGseSettings);
        ui.settingsOverlay.addEventListener("mousedown", event => { if (event.target === ui.settingsOverlay) closeSettingsModal(); });
        // Tema claro/escuro persiste por navegador (cada pessoa que usa o
        // script guarda a própria preferência) — não depende de servidor.
        try { if (localStorage.getItem(THEME_STORAGE_KEY) === "dark") host.classList.add("dark"); } catch (_) {}
        ui.themeToggle.addEventListener("click", () => {
            host.classList.toggle("dark");
            try { localStorage.setItem(THEME_STORAGE_KEY, host.classList.contains("dark") ? "dark" : "light"); } catch (_) {}
        });
        // Tamanho do modal e da fonte, mesmo padrão do tema: persiste por
        // navegador/pessoa, aplica na hora, sem precisar de "Salvar" (essas
        // duas configurações não afetam a carga do acervo, então não faz
        // sentido travar atrás do fluxo Salvar/Cancelar das GSEs). São
        // independentes uma da outra — mudar uma não move o número da outra
        // — mas como o zoom da fonte usa a propriedade CSS `zoom` no modal
        // inteiro, aumentar a fonte também deixa o modal um pouco maior na
        // tela (o mesmo que acontece com o zoom nativo do navegador,
        // Ctrl+/Ctrl-). Isso é esperado, não é bug.
        function clampAppearancePct(value) {
            const num = Number(value);
            return Number.isFinite(num) ? Math.min(140, Math.max(80, num)) : 100;
        }
        function applyModalScale(pct) {
            const clamped = clampAppearancePct(pct);
            host.style.setProperty("--v-modal-scale", (clamped / 100).toFixed(2));
            ui.modalScaleRange.value = String(clamped);
            ui.modalScaleValue.textContent = `${clamped}%`;
        }
        function applyFontZoom(pct) {
            const clamped = clampAppearancePct(pct);
            host.style.setProperty("--v-font-zoom", (clamped / 100).toFixed(2));
            ui.fontZoomRange.value = String(clamped);
            ui.fontZoomValue.textContent = `${clamped}%`;
        }
        let storedModalScale = 100, storedFontZoom = 100;
        try { storedModalScale = clampAppearancePct(localStorage.getItem(MODAL_SCALE_STORAGE_KEY) || 100); } catch (_) {}
        try { storedFontZoom = clampAppearancePct(localStorage.getItem(FONT_ZOOM_STORAGE_KEY) || 100); } catch (_) {}
        applyModalScale(storedModalScale);
        applyFontZoom(storedFontZoom);
        ui.modalScaleRange.addEventListener("input", () => {
            applyModalScale(ui.modalScaleRange.value);
            try { localStorage.setItem(MODAL_SCALE_STORAGE_KEY, ui.modalScaleRange.value); } catch (_) {}
        });
        ui.modalScaleReset.addEventListener("click", () => {
            applyModalScale(100);
            try { localStorage.setItem(MODAL_SCALE_STORAGE_KEY, "100"); } catch (_) {}
        });
        ui.fontZoomRange.addEventListener("input", () => {
            applyFontZoom(ui.fontZoomRange.value);
            try { localStorage.setItem(FONT_ZOOM_STORAGE_KEY, ui.fontZoomRange.value); } catch (_) {}
        });
        ui.fontZoomReset.addEventListener("click", () => {
            applyFontZoom(100);
            try { localStorage.setItem(FONT_ZOOM_STORAGE_KEY, "100"); } catch (_) {}
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
            openMainPanel();
            ui.restorePill.hidden = true;
        });
        // Clique fora do diálogo (na área escura) propositalmente NÃO fecha nem
        // minimiza — só o botão de fechar (ou, quando existir, o de minimizar)
        // deve controlar isso, pra evitar fechar sem querer.

        ui.loadButton.addEventListener("click", loadArchive);
        ui.cancelLoad.addEventListener("click", () => { archiveCancelled = true; });
        ui.cancelSearch.addEventListener("click", () => { searchCancelled = true; });

        // Marcar "Ignorar GSE" muda a intenção: você quer TUDO daquela pessoa,
        // não os últimos 180 dias. A busca nativa do SMAX se comporta assim
        // (o filtro dela é só RequestedForPerson, sem data), e manter o padrão
        // de período aqui fazia o script devolver bem menos que o SMAX para a
        // mesma pessoa — parecendo erro de busca quando era só a janela.
        // A mudança é visível no próprio controle de PERÍODO, não silenciosa.
        ui.ignoreGse.addEventListener("change", () => {
            if (!ui.ignoreGse.checked || ui.dateMode.value === "any") return;
            ui.dateMode.value = "any";
            updateDateControls();
            setStatus('Período mudado para "Qualquer data": buscando todo o histórico da pessoa, como faz a pesquisa do SMAX. Dá pra restringir de novo no controle de período.', "info");
        });

        ui.autoSyncToggle.addEventListener("change", () => {
            autoSyncEnabled = ui.autoSyncToggle.checked;
            try { localStorage.setItem(AUTOSYNC_STORAGE_KEY, autoSyncEnabled ? "1" : "0"); } catch (_) {}
            renderIndexStatus();
            if (autoSyncEnabled) tickAutoSync();
        });

        ui.storageRefresh.addEventListener("click", () => { if (!storageBusy) renderStoragePanel(); });

        ui.storageWipe.addEventListener("click", async () => {
            if (storageBusy) return;
            if (!window.confirm("Apagar TODO o acervo salvo em disco?\n\nTodas as GSEs indexadas serão removidas e a próxima pesquisa vai baixar tudo de novo.")) return;
            setStorageBusy(true, 0);
            ui.storageNote.textContent = "Apagando tudo...";
            try {
                await resetIndex();
                archive = [];
                results = [];
                selectedIds.clear();
                selectedRecords.clear();
                renderResults();
                renderStats();
                ui.storageNote.textContent = "Acervo em disco apagado.";
            } catch (error) {
                ui.storageNote.textContent = `Falha ao apagar: ${error.message || error}`;
            } finally {
                setStorageBusy(false);
                renderStoragePanel();
            }
        });

        // Fecha o relatório e devolve o botão ao estado normal. Antes, a única
        // forma de fechar era clicar de novo em "Medir espaço" — que ninguém
        // adivinha —, então na prática o relatório ficava preso na tela e só
        // saía recarregando a página. Agora há um × explícito e o botão troca
        // de rótulo enquanto está aberto.
        function closeIndexReport() {
            ui.indexReport.hidden = true;
            ui.indexReport.innerHTML = "";
            ui.indexMeasure.textContent = "Medir espaço";
        }
        ui.indexMeasure.addEventListener("click", async () => {
            if (!ui.indexReport.hidden) { closeIndexReport(); return; }
            ui.indexMeasure.disabled = true;
            ui.indexReport.hidden = false;
            ui.indexMeasure.textContent = "Ocultar medição";
            const shell = inner => `<div class="index-report-head"><span>Medição de espaço</span><button type="button" class="index-report-close" title="Fechar">×</button></div>${inner}`;
            ui.indexReport.innerHTML = shell('<div class="index-report-inner">Lendo uma amostra do que está salvo em disco...</div>');
            const wireClose = () => { const b = ui.indexReport.querySelector(".index-report-close"); if (b) b.addEventListener("click", closeIndexReport); };
            wireClose();
            try {
                ui.indexReport.innerHTML = shell(await measureIndexBreakdown());
            } catch (error) {
                ui.indexReport.innerHTML = shell(`<div class="index-report-inner">Não foi possível medir: ${escapeHtml(error.message || String(error))}</div>`);
            } finally { ui.indexMeasure.disabled = false; wireClose(); }
        });

        ui.indexReset.addEventListener("click", async () => {
            if (indexing) return setStatus("Aguarde a indexação em segundo plano terminar antes de reindexar do zero.", "warning");
            ui.indexReset.disabled = true;
            try {
                await resetIndex();
                archive = [];
                results = [];
                selectedIds.clear();
                selectedRecords.clear();
                renderResults();
                renderStats();
                setStatus("Índice em disco apagado. A próxima pesquisa vai baixar e indexar tudo de novo, como na primeira vez.", "success");
            } catch (error) {
                setStatus(`Não foi possível apagar o índice: ${error.message || error}`, "error");
            } finally { ui.indexReset.disabled = false; }
        });
        ui.search.addEventListener("click", () => { if (renderQueryValidator()) performSearch(); });
        ui.query.addEventListener("input", showQueryTyping);
        ui.query.addEventListener("blur", renderQueryValidator);
        ui.query.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); if (renderQueryValidator()) performSearch(); } });
        ui.mode.addEventListener("change", renderQueryValidator);
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
        // Estilo dos campos Descrição/Solução/Discussão (Termos/Semelhança) —
        // é só CSS (classe no host), então trocar não precisa re-renderizar nada.
        try { const savedStyle = localStorage.getItem(CARD_STYLE_STORAGE_KEY); if (savedStyle === "3b" || savedStyle === "3d") cardStyleMode = savedStyle; } catch (_) {}
        host.classList.toggle("card-style-3d", cardStyleMode === "3d");
        ui.cardStyleToggle.querySelectorAll(".view-btn").forEach(btn => {
            if (btn.dataset.cardStyle === cardStyleMode) btn.classList.add("active"); else btn.classList.remove("active");
            btn.addEventListener("click", () => {
                cardStyleMode = btn.dataset.cardStyle;
                ui.cardStyleToggle.querySelectorAll(".view-btn").forEach(b => b.classList.toggle("active", b === btn));
                host.classList.toggle("card-style-3d", cardStyleMode === "3d");
                try { localStorage.setItem(CARD_STYLE_STORAGE_KEY, cardStyleMode); } catch (_) {}
            });
        });

        // Na aba Estatística, GSE e Período saem do painel "Filtros
        // avançados" e ficam fixos na tela (você não roda essa busca sem
        // eles); Especialista/Solicitante/VIP viram tags — o campo continua
        // sendo o MESMO elemento (autocomplete e tudo), só muda de lugar na
        // tela. Ao sair da aba, tudo volta pro lugar de origem.
        const statsRelocatable = ["filterGseSection", "filterSpecialistControl", "filterRequestedForControl"];
        const statsOriginalSpot = new Map();
        function moveIntoStats() {
            const target = { filterGseSection: "statsGseSlot", filterSpecialistControl: "statsEspSlot", filterRequestedForControl: "statsSolSlot" };
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
            // Buscar sem GSE só existe aqui: as outras abas fazem busca textual,
            // que depende do acervo indexado — e indexar é ancorado em GSE.
            ui.ignoreGseWrap.hidden = false;
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
            // Só esconde. Desmarcar fica por conta de swapFilterState, que roda
            // depois — desmarcar aqui apagaria o estado antes de ele ser
            // guardado, e a Estatística esqueceria a opção ao voltar.
            ui.ignoreGseWrap.hidden = true;
            shadow.querySelectorAll(".sort-text-only").forEach(option => { option.hidden = false; });
        }
        shadow.querySelector("#tjspModeStats").addEventListener("change", () => { if (shadow.querySelector("#tjspModeStats").checked) { moveIntoStats(); enterResultsBucket("stats"); } });
        shadow.querySelector("#tjspModeTerms").addEventListener("change", () => { if (shadow.querySelector("#tjspModeTerms").checked) { restoreFromStats(); enterResultsBucket("text"); } });
        shadow.querySelector("#tjspModeSimilar").addEventListener("change", () => { if (shadow.querySelector("#tjspModeSimilar").checked) { restoreFromStats(); enterResultsBucket("text"); } });
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
            results.slice(start, start + PAGE_RESULTS).forEach(item => setSelection(item, ui.selectPageCheckbox.checked));
            renderResults();
        });
        ui.selectAllResultsButton.addEventListener("click", selectAllResults);
        ui.clearSelectionButton.addEventListener("click", clearSelection);
        ui.openSelectedButton.addEventListener("click", openSelectedInTabs);

        shadow.querySelectorAll(".operator").forEach(button => button.addEventListener("click", () => insertOperator(button.dataset.insert || "")));
        shadow.querySelector(".select-all").addEventListener("click", () => {
            ui.gseList.querySelectorAll("input").forEach(input => input.checked = true);
            // Checkbox marcado via código não dispara "change" sozinho — sem
            // isso os selos de equipe ficavam com o estado (marcado/
            // desmarcado) desatualizado depois de um clique aqui.
            if (gseListComboInstance) renderTeamPillGroup(ui.gseTeams, ui.gseTeamsTitle, null, adoptedTeams(), gseListComboInstance);
        });
        shadow.querySelector(".clear-gse").addEventListener("click", () => {
            ui.gseList.querySelectorAll("input").forEach(input => input.checked = false);
            if (ui.extraGseCombo) ui.extraGseCombo.setSelected([]);
            if (gseListComboInstance) renderTeamPillGroup(ui.gseTeams, ui.gseTeamsTitle, null, adoptedTeams(), gseListComboInstance);
        });
        ui.dateMode.addEventListener("change", updateDateControls);
        ui.solutionDateMode.addEventListener("change", updateSolutionDateControls);

        function closeAdvancedPanel() { ui.advancedPanel.hidden = true; ui.advancedToggle.setAttribute("aria-expanded", "false"); }
        ui.advancedToggle.addEventListener("click", () => {
            const willOpen = ui.advancedPanel.hidden;
            ui.advancedPanel.hidden = !willOpen;
            ui.advancedToggle.setAttribute("aria-expanded", String(willOpen));
        });

        function closeExportMenu() { ui.exportMenu.hidden = true; }
        ui.exportToggle.addEventListener("click", () => { ui.exportMenu.hidden = !ui.exportMenu.hidden; });
        shadow.querySelectorAll(".export-open").forEach(button => {
            button.addEventListener("click", () => { openExportOptionsModal(button.dataset.format); closeExportMenu(); });
        });
        ui.copyButton.addEventListener("click", copySummary);

        // Modal único de exportação: escolhe formato, campos e (só no HTML)
        // layout e seções. A seleção de campos vale para TODOS os formatos e
        // fica salva entre sessões.
        let exportFormat = "xlsx";
        let exportLayout = "cards";

        function closeExportOptionsModal() { ui.exportOptsOverlay.hidden = true; }

        function renderExportFieldChecks() {
            const selected = new Set(loadExportFieldSelection());
            ui.exportFieldsGrid.innerHTML = EXPORT_FIELDS.map(f =>
                `<label class="export-field${selected.has(f.key) ? " on" : ""}"><input type="checkbox" data-field="${f.key}"${selected.has(f.key) ? " checked" : ""}><span>${escapeHtml(f.label)}</span></label>`
            ).join("");
            ui.exportFieldsGrid.querySelectorAll("input[data-field]").forEach(input => {
                input.addEventListener("change", () => { input.closest(".export-field").classList.toggle("on", input.checked); });
            });
        }
        function readExportFieldSelection() {
            return Array.from(ui.exportFieldsGrid.querySelectorAll("input[data-field]:checked")).map(input => input.dataset.field);
        }

        function setExportFormat(format) {
            exportFormat = format;
            ui.exportFormatSeg.querySelectorAll(".fmt-btn").forEach(b => b.classList.toggle("active", b.dataset.format === format));
            // O bloco de opções de documento (layout + seções) vale para os três
            // formatos "de relatório"; Texto fica só com nome + campos.
            const isDoc = format === "html" || format === "md" || format === "xlsx";
            ui.exportDocOpts.hidden = !isDoc;
            // Layout Fichas/Tabela só faz sentido em HTML e Markdown — planilha
            // é sempre tabular.
            ui.exportLayoutWrap.hidden = format === "xlsx";
            // A nota "cada seção vira uma aba" só se aplica ao Excel.
            ui.exportSheetsNote.hidden = format !== "xlsx";
        }
        function setExportLayout(layout) {
            exportLayout = layout;
            ui.exportLayoutSeg.querySelectorAll(".lay-btn").forEach(b => b.classList.toggle("active", b.dataset.layout === layout));
        }
        ui.exportFormatSeg.querySelectorAll(".fmt-btn").forEach(b => b.addEventListener("click", () => setExportFormat(b.dataset.format)));
        ui.exportLayoutSeg.querySelectorAll(".lay-btn").forEach(b => b.addEventListener("click", () => setExportLayout(b.dataset.layout)));

        function openExportOptionsModal(format) {
            ui.exportOptsName.value = "";
            ui.exportOptsFilters.checked = true;
            ui.exportOptsIndice.checked = true;
            ui.exportOptsDistribuicao.checked = true;
            renderExportFieldChecks();
            setExportFormat(format || "xlsx");
            setExportLayout("cards");
            ui.exportOptsOverlay.hidden = false;
            ui.exportOptsName.focus();
        }
        ui.exportOptsCancel.addEventListener("click", closeExportOptionsModal);
        ui.exportOptsOverlay.addEventListener("mousedown", event => { if (event.target === ui.exportOptsOverlay) closeExportOptionsModal(); });
        ui.exportOptsName.addEventListener("keydown", event => { if (event.key === "Enter") ui.exportOptsConfirm.click(); });
        ui.exportOptsConfirm.addEventListener("click", () => {
            const keys = readExportFieldSelection();
            if (!keys.length) { setStatus("Marque ao menos um campo para exportar.", "warning"); return; }
            saveExportFieldSelection(keys);
            const fields = selectedExportFields(keys);
            const reportName = ui.exportOptsName.value;
            const docOpts = {
                reportName,
                layout: exportLayout,
                includeFilters: ui.exportOptsFilters.checked,
                includeIndice: ui.exportOptsIndice.checked,
                includeDistribuicao: ui.exportOptsDistribuicao.checked
            };
            closeExportOptionsModal();
            if (exportFormat === "xlsx") exportXlsx(fields, docOpts);
            else if (exportFormat === "txt") exportTxt(fields, reportName);
            else if (exportFormat === "md") exportMarkdown(fields, docOpts);
            else exportHtml(fields, docOpts);
        });

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
                if (!ui.settingsOverlay.hidden) closeSettingsModal();
                else if (!ui.exportOptsOverlay.hidden) closeExportOptionsModal();
                else if (focusedIndex >= 0) closeFocus();
                else if (!ui.exportMenu.hidden) closeExportMenu();
                else if (!ui.advancedPanel.hidden) closeAdvancedPanel();
                else host.classList.remove("open");
            }
        });

        updateDateControls();
        updateSolutionDateControls();
        updateNavigator();
        updateSelectionUi();
        ui.requestedForCombo = installPersonMultiAutocomplete(ui.requestedForComboRoot, shadow);
        // Sem vínculo de GSE: alguns colegas não estão devidamente
        // vinculados ao grupo no cadastro do SMAX (questão administrativa
        // interna), e ficavam de fora da busca. Como já mostramos a
        // matrícula, dá pra diferenciar homônimos sem precisar do PersonToGroup.
        ui.specialistCombo = installPersonMultiAutocomplete(ui.specialistComboRoot, shadow);
        ui.extraGseCombo = installGseCombobox(ui.extraGseComboRoot, shadow);
        ui.statusCombo = installStaticCombobox(ui.statusComboRoot, shadow, STATUS_LABELS);
        ui.statusOperacionalCombo = installStaticCombobox(ui.statusOperacionalComboRoot, shadow, STATUS_OPERACIONAL_LABELS);
        ui.unidadeCombo = installLocationCombobox(ui.unidadeComboRoot, shadow);
        ui.historyGseCombo = installGseCombobox(ui.historyGseComboRoot, shadow);
        // Mesmo atalho de equipe que já existe em Configurações, aplicado
        // aqui: um clique marca/desmarca todas as GSEs da equipe dentro
        // deste combo específico ("Passou por GSE"), sem mexer na seleção
        // principal de GSEs pra carregar o acervo. Depois de usar o atalho,
        // GSEs individuais continuam ajustáveis normalmente no combo.
        renderTeamPillGroup(ui.historyTeams, ui.historyTeamsTitle, ui.historyTeamsHint, adoptedTeams(), ui.historyGseCombo);
        ui.historyGseCombo.onChange(() => renderTeamPillGroup(ui.historyTeams, ui.historyTeamsTitle, ui.historyTeamsHint, adoptedTeams(), ui.historyGseCombo));
        if (ui.historyGseExclude && ui.historyGseHint) {
            const updateHistoryGseHint = () => {
                ui.historyGseHint.textContent = ui.historyGseExclude.checked
                    ? "Excludente — fora quem passou por qualquer uma das GSEs marcadas. Consulta o histórico de cada solicitação (pode levar alguns segundos)."
                    : "Lógica OU — basta ter passado por qualquer uma das GSEs marcadas. Consulta o histórico de cada solicitação (pode levar alguns segundos).";
            };
            ui.historyGseExclude.addEventListener("change", updateHistoryGseHint);
            updateHistoryGseHint();
        }
    }

    // Ao abrir a página, avisa se já existe acervo salvo em disco de sessões
    // anteriores — é o sinal de que a próxima carga vai ser incremental (rápida)
    // em vez de baixar tudo de novo.
    async function reportSavedIndexOnStartup() {
        try {
            await loadLastSync();
            const [count, groups] = await Promise.all([db.meta.count(), db.syncState.toArray()]);
            if (!count || !ui || !ui.indexStrip) return;
            ui.indexStrip.hidden = false;
            ui.indexDot.classList.add("ready");
            const quando = describeLastSync(lastSyncAt);
            ui.indexLabel.textContent = `${count.toLocaleString("pt-BR")} solicitação(ões) já indexadas em disco (${groups.length} GSE(s))${quando ? ` · atualizado ${quando}` : ""} — a próxima carga traz só o que for novo.`;
        } catch (_) { /* sem índice salvo ainda, ou IndexedDB indisponível */ }
    }

    function init() {
        if (document.getElementById("tjsp-archive-full-host")) return;
        buildUi();
        // Pede armazenamento permanente logo no início: sem isso o navegador
        // pode descartar o acervo indexado sem avisar quando o disco apertar.
        requestPersistentStorage();
        reportSavedIndexOnStartup();
        startAutoSync();
        console.log(`[TJSP] Pesquisa Avançada SMAX ${VERSION} carregada.`);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
    else init();
}());
