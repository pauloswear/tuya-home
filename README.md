# Tuya Dash

Painel web (FastAPI + SPA sem build) para ver e controlar tomadas, lâmpadas e outros
dispositivos da conta **Tuya Smart**: ligar/desligar, brilho/cor/temperatura,
temporizador, comportamento ao voltar a energia, LED indicador, bloqueio infantil,
potência/tensão/corrente em tempo real, histórico de consumo e custo, cenas.

## Como funciona

A conexão foi definida a partir da análise do app instalado no telefone
(`com.tuya.smart` 7.12.6, extraído via ADB):

- O manifesto registra o esquema `tuyaSmart`. O leitor de QR do app troca
  `xSmart--rota` por `xSmart://rota` antes de abrir a rota.
- A rota `qrLogin?token=…` abre `com.thingclips.smart.qrlogin.activity.QRCodeAuthActivity`
  ("Scan QR to login" → *Confirm login*). Um link `tuyaSmart://qrLogin` enviado
  de fora do app **não** abre essa tela; o QR precisa ser lido pelo scanner do app
  (câmera ou **Álbum**).
- É o fluxo de autorização usado pela integração Smart Life do Home Assistant.
  O backend usa `tuya-device-sharing-sdk` (REST + MQTT em tempo real), com o
  *client id* público dessa integração. Por isso, depois de conectado, o painel
  aparece em *Conta e segurança → Gerenciamento de autorização de terceiros* como
  "Home Assistant".

Não é preciso root, conta de desenvolvedor na Tuya IoT Platform nem senha.

## Rodar

```bash
./run.sh            # http://localhost:8765 (escuta em 0.0.0.0, acessível na LAN)
PORT=9000 ./run.sh
```

Primeiro acesso: no app, **Eu → ⚙ → Conta e segurança → Código de usuário**. Cole o
código no painel e leia o QR com o scanner do app (canto superior da aba *Eu* ou da
tela inicial). Depois toque em **Confirm login**.

## Dados

- `data/config.json`: sessão Tuya (tokens renovados automaticamente). Permissão 600. **Não compartilhe.**
- Histórico de potência e incrementos de `add_ele`: **MySQL/MariaDB** quando o `.env` define `MYSQL_HOST`;
  senão SQLite em `data/energy.db`. Se o MySQL estiver fora do ar na partida, o painel cai para o SQLite
  e avisa na tela.

`.env` (permissão 600, fora do git):

```
MYSQL_HOST=10.10.10.174
MYSQL_PORT=3311
MYSQL_USER=root
MYSQL_PASSWORD=…
MYSQL_DATABASE=tuya-app
```

### Migrações (SQLAlchemy + Alembic)

O esquema está em `app/db.py`. Ao iniciar, o servidor roda `alembic upgrade head` e cria ou altera as
tabelas. Para mudar o esquema:

```bash
# 1. edite as tabelas em app/db.py
.venv/bin/alembic revision --autogenerate -m "descreva a mudança"   # gera migrations/versions/…
# 2. revise o arquivo gerado
.venv/bin/alembic upgrade head        # ou só reinicie o painel
.venv/bin/alembic check              # confirma que código e banco batem
```

A API de compartilhamento não traz o histórico de consumo da nuvem. O painel
calcula o consumo a partir do que recebe enquanto estiver rodando:

- usa os incrementos `add_ele` reportados pela tomada, quando existem (aparece como "medida");
- senão, integra a potência ao longo do tempo (aparece como "estimada").

Deixe o painel rodando, por exemplo como serviço systemd, para acumular histórico.

## Segurança

- **Login por e-mail e senha.** No primeiro acesso, sem nenhum usuário cadastrado, o painel pede para
  criar um. A senha fica na tabela `users` em bcrypt (custo 12). A sessão é um cookie `HttpOnly`,
  `SameSite=Strict`, válido por 7 dias. O banco guarda só o SHA-256 do token, na tabela `sessions`.
- Toda a API e o fluxo ao vivo (`/api/events`) exigem sessão. Pedidos que alteram algo só são aceitos
  quando vêm do próprio site (checagem do cabeçalho `Origin`).
- 5 senhas erradas em 15 min bloqueiam o e-mail e o IP por 15 min.
- Se o MySQL estiver fora do ar, o painel não deixa criar usuário no SQLite de reserva.
- Para trocar a senha: `POST /api/session/password` com `{"current": "...", "new": "..."}`.
- As *local keys* aparecem na tela da tomada. Mesmo com login, prefira acessar pela LAN ou por VPN.

## Atualização ao vivo

A nuvem Tuya atualiza a potência a cada ~10 s, mas o MQTT da API de compartilhamento não repassa
essas leituras. O painel consulta o status de todas as tomadas a cada 5 s, numa única requisição.
Em caso de erro, o intervalo dobra até 60 s. O consumo (kWh) é calculado integrando essas leituras.

## API

| Método | Rota | |
|---|---|---|
| GET | `/api/devices` | casas + dispositivos (DPs normalizados) |
| GET | `/api/devices/{id}` | detalhes, incluindo IP e local key |
| POST | `/api/devices/{id}/commands` | `{"commands":[{"code":"switch_1","value":true}]}` |
| GET | `/api/devices/{id}/energy?range=24h` | série de potência/kWh (1h, 6h, 24h, 7d, 30d) |
| GET | `/api/energy/summary?range=24h` | consumo por dispositivo |
| GET | `/api/scenes` · POST `/api/scenes/{home}/{scene}/trigger` | cenas |
| GET | `/api/events` | SSE com atualizações em tempo real e eventos de leitura (`poll`) |
| GET/POST | `/api/session`, `/api/session/setup`, `/login`, `/logout`, `/password` | login do painel |
