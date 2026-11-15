# AGENTS.md — regras para agentes neste repositório

Guia para qualquer agente de IA (ou pessoa) que for mexer no Tuya Dash.

## O que é

Painel web para ver e controlar tomadas/lâmpadas inteligentes Tuya: liga/desliga,
brilho/cor, consumo (W, kWh, R$), comportamento (temporizador, estado ao voltar a
energia, LED, bloqueio infantil) e agendamentos. Stack:

- **Backend:** FastAPI (`app/`), Python 3.12. Servido por Uvicorn.
- **Frontend:** SPA em JavaScript puro, sem build (`static/`). Roteamento por hash.
- **Nuvem Tuya, dois canais:**
  - Controle e leitura em tempo real: `tuya-device-sharing-sdk` (login por QR, gateway
    `apigw.tuyaus.com`). Código em `app/tuya_service.py`.
  - Agendamentos (timers): **API Cloud oficial** da Tuya (`openapi.tuyaus.com`,
    assinatura HMAC-SHA256). Código em `app/tuya_cloud.py`.
- **Histórico de energia:** MySQL/MariaDB quando o `.env` define `MYSQL_HOST`, senão
  SQLite. Esquema e migrações em `app/db.py` + Alembic (`migrations/`).
- **Login do painel:** e-mail + senha (bcrypt), sessão por cookie. `app/auth.py`.

## Regra nº 1: segredos NUNCA no git

- Chaves, credenciais, senhas e tokens ficam **só no `.env`** (não versionado) e em
  `data/` (sessão Tuya, banco local). Ambos estão no `.gitignore`.
- Nunca faça commit de `.env`, `data/`, dumps de banco, APKs ou tokens.
- Nada de segredo embutido no código. Antes de qualquer commit, confira:
  `git diff --cached --name-only | grep -E '^\.env$|^data/'` deve voltar vazio.
- Ao adicionar uma variável de ambiente, documente-a no `.env.example` (sem valor).
- O `CLIENT_ID` em `app/tuya_service.py` é o identificador público da integração Home
  Assistant — não é segredo.

## Rodar e migrar

```bash
./run.sh                      # http://0.0.0.0:8765 (cria .venv e instala na 1ª vez)
.venv/bin/alembic upgrade head   # migrações (o servidor também aplica ao iniciar)
.venv/bin/alembic revision --autogenerate -m "..."   # após mudar o esquema em app/db.py
.venv/bin/alembic check       # confirma que código e banco batem
```

Credenciais da Tuya Cloud: projeto gratuito em platform.tuya.com (Data Center
*Western America*), aba Devices → Link App Account para vincular a conta por QR.

## Convenções

- **UI em português (pt-BR).** Textos, rótulos e mensagens de erro para o usuário.
- **Design:** telas de app no estilo "achromatic ledger" — interface em tinta, a única
  cor (`--data`, azul) vai no dado (potência/consumo). Sem gradientes, sombras em
  repouso, ícones em quadrados coloridos ou KPIs com sparkline. Números com
  `tabular-nums`, zeros como zero, valores ausentes como travessão.
- **Acessibilidade:** `<button>`/`<a>` semânticos, `aria-label` em ícones, foco
  visível, `prefers-reduced-motion` respeitado.
- **Sem dependências de front-end com build.** `static/vendor/` guarda CSS/JS copiados;
  o resto é escrito à mão.
- **Dados honestos:** não inventar consumo. O histórico vem das leituras reais; períodos
  sem dado aparecem vazios, não como zero.

## Tuya: o que NÃO fazer

- **Não** tente reverter/assinar a API móvel do app (`/api.json`, `libthing_security.so`,
  `t_s.bmp`). Investigado e descartado: exige imitar o app com chave presa ao certificado
  e uma sessão de login do app (a conta é só Google), viola os termos e arrisca banir a
  conta. Agendamentos usam a **API Cloud oficial**.
- Comandos que alteram estado passam por `POST /api/.../commands`; respeite a checagem de
  Origin do middleware em `app/main.py`.

## Ao terminar uma mudança

- Teste o que mexeu de verdade (subir o servidor, exercitar o endpoint).
- Mudou a UI? Verifique em 1440px e no celular (390px).
- Relate honestamente o que foi testado e o que não foi.
- Não faça commit/push sem o usuário pedir. Em repositório com branch padrão, crie um
  branch antes de propor PR.
