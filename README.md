# Organiza

Sistema pessoal de tarefas e demandas, no estilo do app Lembretes do iPhone, com captura automática de demandas enviadas em um grupo do WhatsApp.

- Tarefas ficam na lista até serem concluídas.
- Tarefas agendadas só entram na lista na data escolhida.
- Tarefas recorrentes (diárias, dias úteis, semanais, quinzenais, mensais, anuais ou personalizadas).
- Bot do WhatsApp: qualquer mensagem no grupo com o marcador (padrão `#demanda`) vira tarefa, com resposta de confirmação no grupo.
- Entende datas escritas em português: "até sexta", "amanhã", "15/10", "dia 20", "todo dia 5", "toda segunda".
- Interface web responsiva, instalável como app no celular (PWA), com modo claro e escuro.
- Um único processo Node.js, banco SQLite em arquivo, sem serviços externos.

## Requisitos

- Node.js 22.13 ou mais recente (usa o SQLite embutido do Node, sem compilação nativa).
- Um número de WhatsApp (o seu) para vincular o bot como "dispositivo conectado".

## Instalação

```bash
git clone <este repositório> organiza
cd organiza
npm install
cp .env.example .env     # opcional: ajuste porta, senha, fuso
npm start
```

Abra `http://localhost:3000`. Em outro aparelho da mesma rede, use o IP da máquina, por exemplo `http://192.168.0.10:3000`.

Para rodar os testes:

```bash
npm test
```

## Conectando o WhatsApp

1. Abra **Configurações** (ícone de engrenagem).
2. Clique em **Reconectar / gerar QR**. O QR code aparece na tela.
3. No celular: WhatsApp → **Dispositivos conectados** → **Conectar dispositivo** → aponte para o QR.
4. Quando o status ficar **Conectado**, escolha o **Grupo monitorado** na lista e clique em **Salvar**.

A sessão fica salva em `data/wa-auth/`. Nas próximas inicializações o bot conecta sozinho, sem QR.

### Como a chefe envia uma demanda

Qualquer mensagem no grupo que contenha o marcador vira tarefa. O marcador pode estar no início ou no fim, e não diferencia maiúsculas.

| Mensagem no grupo | Resultado |
|---|---|
| `#demanda Revisar contrato da Alfa até sexta` | Tarefa "Revisar contrato da Alfa" com prazo na sexta |
| `#demanda urgente Ligar para fornecedor amanhã` | Prioridade alta, prazo amanhã |
| `#demanda Fechar planilha todo dia 5` | Tarefa recorrente mensal |
| `#demanda Enviar relatório toda segunda` | Tarefa recorrente semanal |
| `#demanda Montar apresentação` + linhas seguintes | Primeira linha é o título, as demais viram observações |

O bot responde no grupo citando a mensagem: "✅ Anotado: Revisar contrato da Alfa (prazo 02/10/2026)". A resposta pode ser desligada ou personalizada nas Configurações.

Você também pode usar mais de um marcador, separados por vírgula, por exemplo `#demanda, !!`.

### Se o computador ficar desligado

O bot funciona como o WhatsApp Web. Mensagens enviadas enquanto ele estava fora do ar são entregues pelo WhatsApp quando ele reconecta, e as demandas são criadas normalmente. Cada mensagem tem um ID único, então nada é duplicado mesmo se o WhatsApp reenviar.

Limites:

- Depois de **14 dias** desconectado o WhatsApp desvincula o dispositivo e é preciso escanear o QR de novo.
- Se o bot ficar offline por mais tempo que o configurado (padrão 2 horas), a interface mostra um aviso com o período, para você conferir o grupo por segurança.
- Mensagens anteriores ao primeiro pareamento não são importadas.

## Rodando como serviço (liga sozinho com o computador)

### Windows (servidor do trabalho)

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd C:\caminho\para\organiza
pm2 start ecosystem.config.cjs
pm2 save
```

Comandos úteis: `pm2 status`, `pm2 logs organiza`, `pm2 restart organiza`.

Alternativa sem pm2: registrar como serviço do Windows com o [NSSM](https://nssm.cc/), apontando para `node` com os argumentos `--disable-warning=ExperimentalWarning src/index.js` e a pasta do projeto como diretório de trabalho.

### Linux

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # execute o comando que ele imprimir
```

## Instalar como app no celular

- **iPhone:** abra o endereço no Safari → botão Compartilhar → **Adicionar à Tela de Início**.
- **Android:** abra no Chrome → menu → **Instalar app**.

O celular precisa alcançar o servidor pela rede (mesma rede Wi-Fi, VPN da empresa ou um túnel como Tailscale). Se a interface ficar acessível para outras pessoas, defina `APP_PASSWORD` no `.env`.

## Backup

Tudo fica na pasta `data/`:

- `organiza.db` é o banco com as tarefas e configurações.
- `wa-auth/` é a sessão do WhatsApp. Trate como senha: quem tiver essa pasta tem acesso ao seu WhatsApp.

Copiar a pasta inteira com o serviço parado é suficiente para restaurar em outra máquina.

## API

A interface usa uma API REST simples que você pode chamar de outros lugares (atalhos do iPhone, scripts):

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/tasks?view=today\|scheduled\|all\|completed\|templates` | Lista tarefas e contadores |
| POST | `/api/tasks` | Cria. Aceita `{ "text": "Ligar para João amanhã" }` (interpreta a data) ou os campos completos `title, notes, start_date, due_date, priority, recurrence` |
| PATCH | `/api/tasks/:id` | Edita; `{ "completed": true }` conclui |
| DELETE | `/api/tasks/:id` | Exclui |
| POST | `/api/parse` | Pré-visualiza como um texto seria interpretado |
| GET/PUT | `/api/settings` | Configurações do bot |
| GET | `/api/whatsapp/status` | Status, QR code e grupos |
| POST | `/api/whatsapp/reconnect`, `/api/whatsapp/logout` | Controle da sessão |

Formato da recorrência: `"daily"`, `"weekdays"`, `"weekly"`, `"biweekly"`, `"monthly"`, `"yearly"` ou um objeto `{ "freq": "weekly", "interval": 2, "weekdays": [1, 3], "until": "2026-12-31" }` (0 = domingo).

## Como a recorrência funciona

Uma tarefa recorrente é um modelo. O sistema cria uma ocorrência quando a data chega e mantém no máximo uma ocorrência aberta por modelo. Se você não concluir, ela continua na lista como atrasada, sem acumular novas cópias. Ao concluir, a próxima surge na data certa. Se o computador ficou desligado por vários dias, só a ocorrência mais recente é criada. Um modelo pode ser pausado (marcar o círculo na lista Recorrentes) e reativado.

## Estrutura

```
src/
  index.js              servidor web, autenticação, inicialização
  config.js             variáveis de ambiente
  db/database.js        SQLite (node:sqlite), configurações, avisos
  services/tasks.js     regras de negócio das tarefas e recorrências
  services/recurrence.js motor de recorrência
  services/dateParser.js datas e recorrências escritas em português
  services/scheduler.js  criação diária das ocorrências
  whatsapp/client.js    conexão com o WhatsApp (Baileys), reconexão, aviso de offline
  whatsapp/parser.js    reconhece o marcador e extrai os campos da demanda
  routes/api.js         API REST
public/                 interface web (PWA)
tests/                  testes (node --test)
```

## Observações sobre o WhatsApp

A integração usa a biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys), que se conecta como um WhatsApp Web. Não é uma API oficial. Para uso pessoal com baixo volume funciona bem, mas há risco teórico de bloqueio da conta e, quando o WhatsApp muda o protocolo, pode ser preciso atualizar a biblioteca (`npm update @whiskeysockets/baileys`). Por isso o bot é um módulo separado: se um dia precisar trocar a forma de captura, o resto do sistema continua igual.
