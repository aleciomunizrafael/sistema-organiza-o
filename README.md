# Organiza

Sistema pessoal de tarefas e demandas, no estilo do app Lembretes do iPhone, com captura automática de demandas enviadas em um grupo do WhatsApp.

- Tarefas ficam na lista até serem concluídas.
- Duas listas sem prazo: **A fazer** (o que está na sua mesa agora) e **Sem data** (o que fica guardado para quando uma condição acontecer, como "comprar papel de outro fornecedor, quando o papel acabar").
- Tarefas agendadas só entram na lista na data escolhida.
- Tarefas recorrentes (diárias, dias úteis, semanais, quinzenais, mensais, anuais ou personalizadas).
- **Lembretes e notificações**: cada tarefa pode ter um lembrete com data e hora, enviado como mensagem do bot no seu próprio WhatsApp e como notificação do app no celular. Resumo diário opcional de manhã com as tarefas do dia e as atrasadas.
- **Bloco da semana**: uma tela só, com cara de bloco de papel, mostrando a semana dia a dia (prazos, agendadas e recorrências previstas) e, embaixo, as tarefas sem data, que aparecem sempre.
- Bot do WhatsApp: qualquer mensagem no grupo com o marcador (padrão `#demanda`) vira tarefa, com resposta de confirmação no grupo.
- Entende datas escritas em português: "até sexta", "amanhã", "15/10", "dia 20", "todo dia 5", "toda segunda".
- Interface web responsiva, instalável como app no celular (PWA), com modo claro e escuro.
- Um único processo Node.js, banco SQLite em arquivo, sem serviços externos.

## Requisitos

- Node.js 22.13 ou mais recente (usa o SQLite embutido do Node, sem compilação nativa).
- Um número de WhatsApp (o seu) para vincular o bot como "dispositivo conectado".

## Instalação

```bash
git clone https://github.com/aleciomunizrafael/sistema-organiza-o.git organiza
cd organiza
npm install
cp .env.example .env     # opcional: ajuste porta, senha, fuso (no Windows: copy .env.example .env)
npm start
```

Use o `git clone`, não o "Download ZIP" do GitHub: sem a pasta `.git` o comando de atualização abaixo não funciona.

Abra `http://localhost:3000`. Em outro aparelho da mesma rede, use o IP da máquina, por exemplo `http://192.168.0.10:3000`.

### Atualizando

Com o serviço parado (`pm2 stop organiza` ou `Ctrl+C`):

```bash
git pull
npm install
```

e inicie de novo. A pasta `data/` (banco e sessão do WhatsApp) e o arquivo `.env` não são tocados pela atualização; o banco recebe as mudanças de estrutura sozinho na primeira execução. No navegador, recarregue com `Ctrl+F5` para pegar a interface nova.

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

**Opção recomendada: serviço do Windows com o NSSM.** Sobe junto com o Windows mesmo sem ninguém fazer login na máquina, que é o cenário de um servidor reiniciado.

1. Baixe o [NSSM](https://nssm.cc/download), extraia e coloque o `nssm.exe` (pasta `win64`) em algum lugar fixo, por exemplo `C:\nssm\nssm.exe`.
2. Em um PowerShell **como administrador**:

```powershell
C:\nssm\nssm.exe install Organiza "C:\Program Files\nodejs\node.exe" "--disable-warning=ExperimentalWarning src\index.js"
C:\nssm\nssm.exe set Organiza AppDirectory "C:\caminho\para\organiza"
C:\nssm\nssm.exe set Organiza AppStdout "C:\caminho\para\organiza\logs\organiza.log"
C:\nssm\nssm.exe set Organiza AppStderr "C:\caminho\para\organiza\logs\organiza.log"
C:\nssm\nssm.exe set Organiza AppRotateFiles 1
C:\nssm\nssm.exe set Organiza AppRotateBytes 10485760
C:\nssm\nssm.exe set Organiza AppRestartDelay 5000
C:\nssm\nssm.exe start Organiza
```

Confira o caminho do `node.exe` com `where node`. Para parar, atualizar e religar: `nssm stop Organiza`, depois `git pull` e `npm install`, depois `nssm start Organiza`.

**Opção alternativa: pm2.** Mais simples, mas o `pm2-windows-startup` só inicia o Organiza quando o seu usuário faz login no Windows. Se o servidor reiniciar e ficar na tela de login, o bot fica parado até alguém entrar.

```powershell
npm install -g pm2 pm2-windows-startup
pm2-startup install
cd C:\caminho\para\organiza
pm2 start ecosystem.config.cjs
pm2 save
pm2 install pm2-logrotate    # evita que os logs cresçam sem limite
```

Comandos úteis: `pm2 status`, `pm2 logs organiza`, `pm2 restart organiza`. Os logs do pm2 ficam em `logs/`.

**Liberar a porta no firewall do Windows.** Sem isso o celular não alcança o servidor. Em um PowerShell como administrador:

```powershell
netsh advfirewall firewall add rule name="Organiza" dir=in action=allow protocol=TCP localport=3000
```

**IP fixo.** O endereço que você salva no celular é o IP do servidor. Se o roteador distribuir IPs automaticamente (DHCP), esse IP pode mudar e o atalho para de funcionar. Peça à TI para reservar o IP do servidor no roteador, ou use o nome da máquina (`http://NOME-DO-SERVIDOR:3000`) quando a rede resolver nomes.

### Linux

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # execute o comando que ele imprimir
pm2 install pm2-logrotate
```

## Hospedando em um VPS (acesso de qualquer lugar)

Para usar de qualquer aparelho, em qualquer rede, o sistema pode rodar em um servidor alugado na nuvem. O código e o banco são os mesmos; muda só onde rodam. A pasta `deploy/` tem tudo pronto.

### O que você precisa

1. **Um VPS Ubuntu 22.04 ou 24.04** com 1 GB de RAM já serve. Opções baratas: Hetzner (CX22, cerca de 4 euros por mês), DigitalOcean (6 dólares), ou a camada gratuita da Oracle Cloud. Na criação, escolha autenticação por chave SSH ou anote a senha de root.
2. **Um endereço (domínio) apontando para o IP do VPS.** Sem ele não há HTTPS, e sem HTTPS o app não instala no celular. Se não tiver um domínio, crie um grátis em [duckdns.org](https://www.duckdns.org): escolha um nome (ex.: `meuorganiza.duckdns.org`) e cole o IP do VPS. Leva um minuto.
3. **Uma senha forte** para o app. Na internet a senha é obrigatória.

### Instalação em um comando

Conecte no VPS (`ssh root@IP`) e rode:

```bash
curl -fsSL https://raw.githubusercontent.com/aleciomunizrafael/sistema-organiza-o/main/deploy/install-vps.sh -o install.sh
bash install.sh meuorganiza.duckdns.org "minha senha forte"
```

Em uns cinco minutos o script instala Node, Caddy (que cuida do HTTPS sozinho), cria o serviço que religa junto com a máquina, configura o firewall e agenda um backup diário. Ao final ele mostra o endereço: `https://meuorganiza.duckdns.org`, usuário `admin` e a senha informada.

Depois, no navegador: Configurações → Reconectar / gerar QR → escaneie com o WhatsApp → escolha o grupo → Salvar. Se você já usava o sistema no notebook, desconecte a sessão lá antes (ou copie a pasta `data/` para `/opt/organiza/data` no VPS com o serviço parado).

### No dia a dia

| Para | Comando no VPS |
|---|---|
| Ver se está rodando | `systemctl status organiza` |
| Ver o log ao vivo | `journalctl -u organiza -f` |
| Atualizar o sistema | `bash /opt/organiza/deploy/update.sh` |
| Reiniciar | `systemctl restart organiza` |
| Backups (últimos 14 dias) | `ls /opt/organiza/backups` |
| Baixar um backup para o seu PC | `scp root@IP:/opt/organiza/backups/organiza-DATA.tar.gz .` |

O serviço roda com um usuário sem privilégios, o app só escuta localmente (o Caddy faz a ponte com HTTPS) e o firewall libera apenas SSH, 80 e 443.

### Celular

Abra o endereço HTTPS, entre com a senha e instale como app (Safari: Compartilhar → Adicionar à Tela de Início; Chrome: menu → Instalar app). Funciona no 4G, em casa, em qualquer lugar.

## Instalar como app no celular

- **iPhone:** abra o endereço no Safari → botão Compartilhar → **Adicionar à Tela de Início**.
- **Android:** abra no Chrome → menu → **Instalar app**.

O celular precisa alcançar o servidor pela rede (mesma rede Wi-Fi, VPN da empresa ou um túnel como Tailscale). Se a interface ficar acessível para outras pessoas, defina `APP_PASSWORD` no `.env`.

## Senha e login

Com `APP_PASSWORD` definido no `.env`, o sistema mostra uma tela de login própria. Depois de entrar, a sessão fica salva naquele aparelho por 180 dias (cookie), então o app instalado no celular abre direto. Para encerrar a sessão de um aparelho: Configurações → Conta → Sair. Dez senhas erradas seguidas do mesmo endereço bloqueiam novas tentativas por 15 minutos.

Scripts e atalhos continuam podendo usar autenticação básica (`-u admin:senha` no curl).

## Backup

Tudo fica na pasta `data/`:

- `organiza.db` é o banco com as tarefas e configurações.
- `wa-auth/` é a sessão do WhatsApp. Trate como senha: quem tiver essa pasta tem acesso ao seu WhatsApp.

Copiar a pasta inteira **com o serviço parado** é suficiente para restaurar em outra máquina. Com o serviço rodando, o banco usa arquivos auxiliares (`organiza.db-wal` e `organiza.db-shm`) e a cópia pode sair inconsistente.

Nunca use a mesma pasta `wa-auth/` em duas máquinas ao mesmo tempo: o WhatsApp derruba uma conexão com a outra em sequência. Se isso acontecer, o bot avisa na interface ("sessão em uso por outra máquina") e fica parado até você desligar o outro e clicar em Reconectar.

## API

A interface usa uma API REST simples que você pode chamar de outros lugares (atalhos do iPhone, scripts):

| Método | Rota | Descrição |
|---|---|---|
| GET | `/api/tasks?view=today\|scheduled\|all\|completed\|templates\|someday` | Lista tarefas e contadores |
| GET | `/api/week?start=YYYY-MM-DD` | Visão semanal (dias, previstas, sem data, atrasadas); `start` é qualquer dia da semana desejada |
| POST | `/api/tasks` | Cria. Aceita `{ "text": "Ligar para João amanhã" }` (interpreta a data) ou os campos completos `title, notes, start_date, due_date, priority, recurrence, someday, trigger_text` |
| PATCH | `/api/tasks/:id` | Edita; `{ "completed": true }` conclui |
| DELETE | `/api/tasks/:id` | Exclui |
| POST | `/api/parse` | Pré-visualiza como um texto seria interpretado |
| GET/PUT | `/api/settings` | Configurações do bot |
| GET | `/api/whatsapp/status` | Status, QR code e grupos |
| POST | `/api/whatsapp/reconnect`, `/api/whatsapp/logout` | Controle da sessão |

Formato da recorrência: `"daily"`, `"weekdays"`, `"weekly"`, `"biweekly"`, `"monthly"`, `"yearly"` ou um objeto `{ "freq": "weekly", "interval": 2, "weekdays": [1, 3], "until": "2026-12-31" }` (0 = domingo).

## Bloco da semana

Na tela inicial, toque em **Bloco da semana**. A tela usa a largura inteira e tem duas folhas:

- **Folha principal, "A fazer"**: todas as tarefas abertas que não têm prazo, que são a maioria das demandas. Elas aparecem em qualquer semana. No fim da folha há uma linha para anotar uma nova demanda direto ali (digite e pressione Enter; datas escritas no texto são interpretadas).
- **Folha "Sem data"**, logo abaixo, menor e amarelada: tarefas guardadas para algum dia, sem prazo e sem pressa, cada uma com a condição em que deve ser feita ("quando o papel acabar"). A linha de escrita dessa folha entende o "quando": digitar `Comprar papel de outro fornecedor quando o papel acabar` separa o título da condição. Essas tarefas não aparecem em Hoje nem em Todas; ficam só aqui e na lista "Sem data" da tela inicial.
- **Folha da semana**, ao lado (ou abaixo, no celular): **Atrasadas** no topo, quando houver prazo vencido de semanas anteriores, e depois **segunda a domingo**, cada dia com as tarefas cujo prazo cai naquele dia, as agendadas para entrar naquele dia e as recorrências. Ocorrências futuras de recorrências aparecem em tom mais claro, como previsão, e entram na lista de verdade quando o dia chega. Tarefas concluídas ficam riscadas no dia.

As setas trocam de semana e o botão "Hoje" volta para a atual. O "+" ao lado de cada dia cria uma tarefa já com aquele prazo. Marcar o círculo conclui a tarefa na hora.

No editor de tarefa, o seletor **A fazer / Sem data** troca uma tarefa de lista. Em "Sem data" os campos de data e repetição somem e aparece o campo "Quando fazer". Dar um prazo a uma tarefa "Sem data" a traz de volta para "A fazer".

## Lembretes e notificações

No editor de tarefa, o campo **Lembrete** recebe data e hora. Na hora marcada o sistema avisa por dois canais, ligados em Configurações → Notificações:

- **WhatsApp**: o bot manda uma mensagem para o seu próprio número (aparece na conversa "Você"). Exige o bot conectado.
- **Notificação do app**: nos aparelhos onde você clicou em "Ativar notificações neste aparelho". Funciona no Android (Chrome) e no iPhone com o app instalado na tela de início (iOS 16.4 ou mais novo). Cada aparelho precisa ser ativado uma vez.

O botão "Enviar teste" dispara uma notificação pelos canais ativos para você conferir.

**Resumo diário**: defina um horário (ex.: 08:00) e os dias da semana. Nesse horário chega uma mensagem com as tarefas atrasadas, as de hoje e as que entram na lista hoje. Alterar o lembrete de uma tarefa reativa o aviso; concluir a tarefa cancela.

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

A integração usa a biblioteca [Baileys](https://github.com/WhiskeySockets/Baileys), que se conecta como um WhatsApp Web. Não é uma API oficial. Para uso pessoal com baixo volume funciona bem, mas há risco teórico de bloqueio da conta e, quando o WhatsApp muda o protocolo, pode ser preciso atualizar a biblioteca. A versão está fixada no `package.json`, então o comando é `npm install @whiskeysockets/baileys@latest` (e não `npm update`), seguido de reinício do serviço. Por isso o bot é um módulo separado: se um dia precisar trocar a forma de captura, o resto do sistema continua igual.
