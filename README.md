# Godoy — conector de validação ImobiBrasil

Serviço de validação manual, somente leitura. **Não implementa nem ativa sincronização.**
Nenhum imóvel, lead, mensagem ou foto é incluído, alterado, excluído ou marcado como lido.

## Executar e testar

Node.js 22.23.4+, 24.22.1+ ou 26.12.1+, dentro da respectiva versão principal;
nenhuma dependência de terceiros. Versões anteriores às correções de 21/10/2026
e versões principais não listadas não fazem parte da configuração suportada.

```sh
npm test
npm start
```

Build no Render: `npm test`. Início: `npm start`. Host `0.0.0.0`, porta `PORT`.
Health check: `GET /healthz` (indica apenas que o servidor responde).

### Atualização de segurança — 27/10/2026

O intervalo em `engines.node` exclui as versões anteriores às correções divulgadas
para Node.js e certificados eMudhra. Isso define a versão solicitada pelo projeto;
não atualiza um processo já iniciado e, por padrão, o npm não impõe `engines` como
bloqueio de execução.

No Render, conferir primeiro o `NODE_VERSION` do serviço e eventuais arquivos
`.node-version` ou `.nvmrc`: todos têm precedência sobre `package.json`, nessa ordem.
Manter a versão principal já utilizada e selecionar pelo menos 22.23.4, 24.22.1 ou
26.12.1 conforme o caso, ou uma correção posterior da mesma linha. Confirmar a
versão efetiva nos logs do build e no processo em execução. Não presumir que o
serviço existe ou está corrigido apenas porque este repositório foi atualizado.

O Dashboard continua sendo a fonte de configuração do serviço. Não alterar flags
de diagnóstico ou sincronização durante a atualização de segurança. Antes de um
novo build, verificar que `IMOBIBRASIL_BUILD_PROBE` e `IMOBIBRASIL_READ_PROBE` estão
desativadas, pois o `posttest` pode fazer consultas reais quando habilitadas.
Rebuild e redeploy de produção precisam de autorização explícita; um simples
restart não recompila o runtime nem atualiza o armazenamento de certificados.
Depois da implantação autorizada, verificar a versão do Node.js, os certificados,
o health check e as funções que já estavam habilitadas.

O executor local `sync/worker.mjs` também usa Node.js e HTTPS. A versão instalada
no Windows precisa ser conferida separadamente; mudar este repositório não atualiza
o computador nem o processo do Robô Godoy. Preservar `state.sqlite` e seus arquivos
associados, credenciais e configuração. Não reinstalar sobre uma tarefa ativa.
O teste do instalador verifica a versão corrigida e a disponibilidade de SQLite
antes de solicitar credenciais; não substitui a verificação de uma instalação existente.
Nenhum componente PHP foi identificado neste repositório; isso não atesta outros
serviços, o site hospedado por terceiros ou o código completo do robô.

Referências oficiais:
- https://render.com/docs/advisory-emudhra
- https://render.com/docs/node-version
- https://nodejs.org/en/blog/vulnerability
- https://render.com/docs/advisory-php2shell

## Estado inicial

`IMOBIBRASIL_ENABLED=false` e `IMOBIBRASIL_CONTRACT_CONFIRMED=false`.
Sem `ADMIN_API_KEY`, rotas administrativas respondem 503; nenhuma comunicação com a ImobiBrasil ocorre.
O plano gratuito serve para esta validação inicial; a continuidade da operação exige revisar seus limites.
As variáveis do serviço no Dashboard Render são a fonte de configuração. Não usar Blueprint simultâneo.

## Configuração segura

Inserir segredos exclusivamente em **Render → serviço → Environment**. Não enviar senhas pelo chat,
não colocar em arquivos Git, URLs, imagens ou logs. Para `ADMIN_API_KEY`, usar **Generate** no Render
e manter o valor apenas em ambiente seguro. Mínimo 32 caracteres.

Antes de habilitar, confirmar com o suporte o tenant Godoy e os parâmetros restantes do contrato em `api1`,
o formato do login, os campos de credenciais, o caminho do token e a resposta de conta ativa.
A documentação do site que exige o cabeçalho `token` não comprova este contrato `X-Authorization`.

| Variável | Finalidade |
| --- | --- |
| `ADMIN_API_KEY` | Segredo para autenticar chamadas administrativas |
| `IMOBIBRASIL_USERNAME` | Usuário da API (segredo) |
| `IMOBIBRASIL_PASSWORD` | Senha da API (segredo) |
| `IMOBIBRASIL_USER_FIELD` | Nome exato do campo de usuário informado pelo suporte |
| `IMOBIBRASIL_PASSWORD_FIELD` | Nome exato do campo de senha informado pelo suporte |
| `IMOBIBRASIL_LOGIN_ENCODING` | `json` ou `form`, conforme contrato |
| `IMOBIBRASIL_TOKEN_POINTER` | JSON Pointer do token ou `auto` para um único token identificado na resposta |
| `IMOBIBRASIL_STATUS_POINTER` | JSON Pointer do indicador de conta ativa, conforme contrato |
| `IMOBIBRASIL_STATUS_EXPECTED_JSON` | Valor primitivo JSON que representa conta ativa, conforme contrato |
| `IMOBIBRASIL_CONTRACT_CONFIRMED` | `true` somente após confirmar todo o contrato, inclusive a rota de status |
| `IMOBIBRASIL_ENABLED` | `true` libera exclusivamente testes manuais de leitura |

Depois de salvar e implantar as variáveis, consultar `GET /v1/status` com
`Authorization: Bearer <ADMIN_API_KEY>` em um cliente seguro. `POST /v1/validate` faz login e uma
consulta de status de conta. Nunca enviar o segredo como query string. Nenhum corpo do request
é usado como credencial ou caminho da API. As respostas não contêm tokens nem dados cadastrais.

## Comportamento e limites

- Login fixo: `POST https://api1.imobibrasil.app/v1/app/account/login`, `manterLogin=true`, `origin=API`.
- Consulta fixa: `GET https://api1.imobibrasil.app/v1/app/account/status`, `X-Authorization: Bearer …`.
- Sem redirecionamentos, retries automáticos ou renovação automática; token apenas em memória durante cada teste.
- Cada teste faz login novo porque a validade do token ainda precisa ser confirmada.
- Uma validação por vez e intervalo mínimo de 6,1s entre chamadas de saída; 429 respeita `Retry-After`.
- 401/403 bloqueia novos testes até revisão de credenciais e reinício/redeploy.
- Limitador em memória é local a um processo: manter uma única instância. Não limita outros sistemas da conta.
- Reinício perde cooldown/checkpoints; não usar como limitador de sincronização de produção.
- Nenhum job, webhook, consulta de imóveis/leads ou armazenamento de dados foi implementado.

Próxima fase: validar identidade e permissões da conta, confirmar rotas e paginação,
definir destino/sentido da sincronização e implementar persistência, reconciliação e cota compartilhada
antes de liberar operações de produção.

## Descoberta manual no build

O operador pode habilitar `IMOBIBRASIL_BUILD_PROBE=true` exclusivamente para um build
supervisionado. O `posttest` executa um login com o JSON original do suporte
(`login`, `password`, `manterLogin=true`, `origin=API`) e, somente se houver um
token inequívoco, um GET de status da conta. Os três campos de formato de login
devem corresponder a esse contrato. As flags gerais podem continuar `false`.
O resultado registra apenas HTTP, caminho do token, indicadores de status
permitidos e correspondência booleana do domínio esperado; nunca token, credenciais,
corpo completo ou mensagens de erro do provedor. Não interpreta HTTP 200 como prova
de conta ativa. Não executa no início/reinício do servidor e não repete chamadas.
Desabilitar a flag assim que o build supervisionado registrar sua execução, antes
de novos builds. Este teste não ativa sincronização nem libera operações de escrita.

Com `IMOBIBRASIL_TOKEN_POINTER=auto`, a seleção ocorre somente quando existe um
único campo de token reconhecido, em uma busca com limites de tamanho e profundidade.
Múltiplos tokens bloqueiam a consulta. Nomes de contêineres desconhecidos são
ocultados dos logs, mas não impedem o uso do token em memória no GET autorizado.


## Validação supervisionada dos módulos

`IMOBIBRASIL_READ_PROBE=true` executa uma única passagem no pós-teste do build; não roda na inicialização do serviço. Requer `IMOBIBRASIL_ENABLED=false`, `IMOBIBRASIL_CONTRACT_CONFIRMED=false` e `IMOBIBRASIL_BUILD_PROBE=false`. Desative a flag imediatamente após a passagem para impedir execuções em builds futuros.

O diagnóstico segue a documentação do CRM indicada pelo suporte em 23/10/2026:
https://api1.imobibrasil.app/v1/documentacao/index.html
Usa API1 e X-Authorization: Bearer, com token e credenciais somente em memória.
Primeiro confirma o domínio em resultSet.user.site do login, consulta account/perfil
e confere o imóvel público Godoy 4306887/referência 369041 usando referenciaImovel.
Só depois consulta account/permissao, pessoa/lista com tipoCadastro=cliente na query,
lead/lista, negocio/lista e mensagem/lista. Amostras de uma linha, até oito chamadas,
intervalo de 6,1 s; sem escrita, logout ou marcação de leitura.
A documentação CRM torna os filtros codigoCliente/codigoCorretor opcionais nos negócios.
Não usa rotas legadas nem presume equivalência de IDs.

O antigo account/status não está no contrato CRM indicado; statusConta=false não
é mais tratado como prova de conta inativa no diagnóstico supervisionado, conforme
esclarecimento do suporte. Identidade e consultas documentadas passam a validar o acesso.
A rota administrativa antiga permanece desativada e ainda exige revisão antes de uso.

Interrompe por 401/403/429, status=false, identidade divergente ou cota restante zero;
sem repetição automática. Logs contêm somente rotas estáticas, status HTTP,
campos reconhecidos, contagem da amostra e cabeçalhos numéricos de limite.
Não registra corpos, nomes, contatos, IDs privados ou tokens. Lista vazia confirma
somente a resposta da rota, não leitura de um registro existente.
Não implementa sincronização, importação ou deduplicação.
# Sincronização dos novos leads do robô

O executor em `sync/worker.mjs` é uma aplicação **local separada** para Windows,
com estado SQLite durável. Ele não é iniciado pelo serviço de validação do Render.
Lê a exportação `acompanhamento.json` já existente, estabelece um marco inicial sem
importar histórico e insere somente novos leads WhatsApp não qualificados que
não tenham telefone correspondente em pessoas, leads ou histórico do CRM.

Estado da entrega: código e testes preparados; instalação no Windows, primeira
inclusão real e ativação operacional ainda pendentes. A autorização do usuário
não equivale a acesso remoto ao computador. Não há credenciais neste repositório.

A origem 3 (WhatsApp Lead) é conferida na lista oficial de origens a cada login.
O executor registra a conta que recebeu o contato. Não infere origem de campanha
a partir de links compartilhados. Facebook, Instagram, formulários e portais
necessitam de metadados e conexões próprias para atribuição confiável.

O pacote de instalação deve conter `probe.js` e `package.json` na raiz; também
`Install.ps1`, `Run.ps1`, `INSTALAR.bat`, `PAUSAR.bat` e `LEIA-ME.txt` copiados de
`sync/`; os módulos `core.mjs`, `worker.mjs` e o teste ficam na subpasta `sync/`.
Consulte `sync/LEIA-ME.txt` para instalação, limites, proteção de credenciais,
conferência de ativação e pausa. O instalador não substitui o código do robô.

Os testes usam dados sintéticos. Incluem reinício, resposta perdida após POST,
contatos existentes, duas contas com o mesmo contato, exclusão de números
internos, paginação incompleta e interrupção em 401/403/429. Nenhum teste cria
cadastros na conta real. Como a API não documenta idempotência nativa, inclusões
simultâneas por outros sistemas precisam ser coordenadas. Resultado ambíguo
interrompe o executor para conferência; nunca dispara um segundo POST automático.


