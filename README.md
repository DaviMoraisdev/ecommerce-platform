# 🛒 E-Commerce Platform

Plataforma de e-commerce completa construída com arquitetura de microserviços.
Projeto educacional de portfólio desenvolvido para aprender backend, frontend,
bancos de dados, mensageria, segurança e infraestrutura na prática.

---

## 🏗️ Arquitetura

Cada domínio do negócio é um serviço independente com banco de dados próprio.
Os serviços se comunicam via REST (síncrono) e RabbitMQ (assíncrono).
Um API Gateway centraliza todo o acesso externo.
Cliente → API Gateway (Nginx)
├── auth-service        (PostgreSQL)
├── user-service        (PostgreSQL)
├── product-service     (MongoDB)
├── inventory-service   (PostgreSQL)
├── cart-service        (Redis)
├── order-service       (PostgreSQL)
├── payment-service     (PostgreSQL)
└── notification-service (RabbitMQ consumer)
---

## 🚀 Tecnologias

| Camada | Tecnologia |
|---|---|
| Backend | Node.js + Express.js |
| Frontend | React 18 + TypeScript + Tailwind CSS |
| Banco relacional | PostgreSQL 15 |
| Banco de documentos | MongoDB 7 |
| Cache | Redis 7 |
| Mensageria | RabbitMQ |
| Containerização | Docker + Docker Compose |
| API Gateway | Nginx |
| Autenticação | JWT + OAuth2 |
| CI/CD | GitHub Actions |

---

## ⚙️ Pré-requisitos

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) instalado e rodando
- [WSL2](https://learn.microsoft.com/pt-br/windows/wsl/install) com Ubuntu (Windows)
- [Node.js v22 LTS](https://nodejs.org/) via nvm
- [Git](https://git-scm.com/) configurado com SSH

---

## 🔧 Como rodar localmente

**1. Clone o repositório**
```bash
git clone git@github.com:DaviMoraisdev/ecommerce-platform.git
cd ecommerce-platform
```

**2. Configure as variáveis de ambiente**
```bash
cp .env.example .env
# Edite o .env com suas credenciais locais
```

**3. Suba a infraestrutura**
```bash
docker compose up -d
```

**4. Confirme que os containers estão rodando**
```bash
docker compose ps
```

---

## 📁 Estrutura de pastas
ecommerce-platform/
├── services/
│   ├── auth-service/
│   ├── user-service/
│   ├── product-service/
│   ├── inventory-service/
│   ├── cart-service/
│   ├── order-service/
│   ├── payment-service/
│   └── notification-service/
├── gateway/
├── frontend/
│   ├── web/
│   └── admin/
├── docs/
│   ├── architecture/
│   └── phase-reviews/
├── docker-compose.yml
├── .env.example
└── README.md

---

## 📋 Fases do projeto

- [x] **Fase 1** — Fundação e ambiente
- [ ] **Fase 2** — Serviço de autenticação
- [ ] **Fase 3** — Catálogo e estoque
- [ ] **Fase 4** — Carrinho e pedidos
- [ ] **Fase 5** — Pagamento
- [ ] **Fase 6** — Notificações
- [ ] **Fase 7** — API Gateway e segurança
- [ ] **Fase 8** — Frontend web
- [ ] **Fase 9** — Admin dashboard
- [ ] **Fase 10** — CI/CD, testes e documentação final

---

## 👨‍💻 Autor

**Davi Morais** — [@DaviMoraisdev](https://github.com/DaviMoraisdev)
