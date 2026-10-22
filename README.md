# Godoy — conector de validação ImobiBrasil

Serviço de validação manual, somente leitura. **Não implementa nem ativa sincronização.**
Nenhum imóvel, lead, mensagem ou foto é incluído, alterado, excluído ou marcado como lido.

## Executar e testar

Node.js 22 ou superior; nenhuma dependência de terceiros.

```sh
npm test
npm start
```

Build no Render: `npm test`. Início: `npm start`. Host `0.0.0.0`, porta `PORT`.
Health check: `GET /healthz` (indica apenas que o servidor responde).

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
