# Agendamentos: por que não espelham no app (e como retomar)

> Nota de investigação para continuar depois. Resume o que foi descoberto, com evidências,
> e os caminhos possíveis para fazer os agendamentos do painel aparecerem no app Tuya.

## O problema

Objetivo desejado: criar agendamentos (dia da semana + horário) no painel que **apareçam e
sincronizem com o "Agendamento" do app Tuya Smart**.

Resultado: **não sincroniza.** Um timer criado pela API Cloud oficial executa de verdade
(a nuvem liga/desliga a tomada no horário), mas **não aparece na tela de Agendamento do app**,
e os agendamentos feitos no app **não aparecem** para a API Cloud.

## Por quê: são dois sistemas separados

A Tuya mantém dois mecanismos de agendamento que nunca foram ligados um ao outro:

1. **Agendamento do app** — para essas tomadas (categoria `cz`), o app grava o horário como um
   **timer local, na própria tomada** (funciona offline). É criado pelo canal interno do app
   (mobile `/api.json`) e/ou codificado nos DPs locais `cycle_time` / `random_time`, que vêm em
   **formato binário não documentado**. O app lê apenas esse armazenamento.

2. **API Cloud oficial** (`/v1.0/devices/{device_id}/timers`) — um **agendador no servidor da
   Tuya**. A nuvem guarda o timer e, na hora, envia o comando ao dispositivo. É outro
   armazenamento, separado. A resposta de leitura traz `is_app_push: false`, ou seja, a Tuya não
   empurra esse timer para o app.

Nenhuma API que temos autorização para usar (device-sharing SDK **ou** Cloud oficial) expõe o
armazenamento local que o app usa. Por isso o painel só alcança a "caixa da nuvem".

### Evidências coletadas (15/11/2026)

- `GET /v1.0/devices/{id}/timers` funciona e lista timers da nuvem; retorna `is_app_push: false`.
- Timer de teste criado na Ventilador (09:15 diário) **executou na nuvem mas não apareceu no app**
  (confirmado visualmente pelo usuário).
- Os DPs da tomada incluem `cycle_time` e `random_time` (agenda cíclica/aleatória), ambos binários.
- A reversa do app (`/api.json`) foi investigada e **descartada**: a assinatura é nativa
  (`doCommandNative`, chave presa ao certificado em `assets/t_s.bmp`) e exige uma **sessão de login
  do app**; a conta é **só Google**, então não há como obter a sessão sem automatizar/guardar o
  login do Google. Ver histórico no README/AGENTS.

## O que ESTÁ implementado hoje

- **Agendamentos do painel** (`app/tuya_cloud.py` + `/api/schedules/*` em `app/main.py`): criar,
  listar e apagar timers da **nuvem**. Funcionam (executam no dispositivo), mas são independentes
  do app. A UI deixa isso explícito.
- **Histórico de consumo pela nuvem** (`backfill_cloud_history` em `app/main.py`): importa ~7 dias
  de `add_ele` (energia) e potência via `report-logs`. **Isso funciona bem** e é o ganho real da
  integração Cloud.

## Caminhos para fazer espelhar no app (futuro)

### Opção A — Escrever o timer local via DP (`cycle_time` / `random_time`)
- **Ideia:** reproduzir o formato binário que o app grava nesses DPs e enviá-lo por
  `send_commands` (canal que já temos). Aí o agendamento viveria na tomada e o app o leria.
- **Risco:** formato binário **sem documentação** — precisa de engenharia reversa (capturar o que o
  app grava, decodificar). Esses DPs são mais ligados aos modos cíclico/aleatório; o agendamento
  semanal simples pode usar outro DP/estrutura. Incerto.
- **Como atacar:** criar um agendamento no app, ler o valor de `cycle_time`/`random_time` pela API
  (`GET .../status` ou report-logs), variar os parâmetros no app e comparar os bytes. Decodificar o
  layout (dias, hora, ação, ativo).

### Opção B — Imitar o app pelo `/api.json`
- **Descartado** nesta conta: exige a sessão de login do app (Google-only) e a assinatura nativa
  presa ao certificado. Só viabilizaria se a conta tivesse **senha de e-mail** própria na Tuya.

## Referência técnica da API Cloud de timer (confirmada ao vivo)

```
GET    /v1.0/devices/{id}/timers
  -> [ { category:{category,status},
         groups:[ { id, timers:[ {timer_id, time, loops, date,
                    functions:[{code,value}], status, alias_name, timezone_id, is_app_push} ] } ] } ]

POST   /v1.0/devices/{id}/timers            -> { group_id }
  body: { category, loops, time_zone, timezone_id,
          instruct:[ { time:"HH:MM", functions:[{code,value}], date? } ], alias_name? }

DELETE /v1.0/devices/{id}/timers            (corpo, NÃO na URL)
  body: { category, group_id }
```

- `loops`: 7 dígitos **segunda..domingo** (índice 0 = segunda). Ex.: `0100000` = terça;
  `1111100` = dias úteis. Com `date` (one-time), `loops` deve ser `0000000`.
- `time_zone` (offset, ex.: `-03:00`) **e** `timezone_id` (IANA) são ambos obrigatórios.
- Ativar/desativar (status 0/1/2): **caminho ainda não encontrado** (o PUT em `/timers/{id}` e em
  `/timers` deu `1108 uri path invalid`). Por ora, desativar = apagar.
- Assinatura HMAC: os parâmetros de query precisam ir **ordenados por chave** no string-to-sign
  (corrigido em `TuyaCloud._canonical_path`).

## Histórico / estatísticas na nuvem

- `GET /v1.0/devices/{id}/report-logs?codes=add_ele,cur_power,...&start_time=&end_time=&size=100`
  funciona (coberto pelos serviços assinados); pagina com `last_row_key`; retém **~7 dias**.
- Escalas: `add_ele` /1000 (kWh), `cur_power` /10 (W), `cur_voltage` /10 (V), `cur_current` /1000 (A).
- `GET /v1.0/devices/{id}/statistics/*` (agregados dias/meses) → `28841101 not subscribed`
  (precisaria assinar o produto de estatísticas no console).
