# SOVÍ VAULT — loja com servidor Node.js + Supabase

1. Supabase → SQL Editor: rode `schema.sql` (cria tabelas, fecha o acesso direto e insere os 12 relógios).
2. Supabase → Authentication → Users: crie seu usuário admin (e-mail confirmado).
3. Copie `.env.example` para `.env` e preencha as 3 chaves + `ADMIN_EMAILS`.
4. `npm install` e `npm start` → http://localhost:3000
5. Deploy: Render / Railway (Start Command: `npm start`) ou Vercel (já tem `vercel.json`). Configure as mesmas variáveis de ambiente no painel da hospedagem.
6. Troque `SEU-DOMINIO.com` em `public/index.html`, `public/sitemap.xml` e `public/robots.txt`.

Nunca commite o `.env` nem exponha a `SUPABASE_SERVICE_ROLE_KEY`.

## Fotos e vídeo
- Rode também o trecho final do `schema.sql` (cria o bucket público `products`). As fotos enviadas pelo painel vão pra lá.
- Vídeo da home: coloque `public/media/intro.mp4` (veja `public/media/LEIA-ME.txt`).
  No Vercel, funções têm limite de ~4,5 MB por resposta: se o vídeo for maior, suba ele no bucket do Supabase e troque o `src` do `<source>` em `public/index.html` pela URL pública.

## WhatsApp e e-mail de confirmação
- Preencha `SELLER_WHATSAPP` no `.env` com o número da loja (só dígitos, com DDI+DDD). Ao confirmar a compra, o cliente é levado direto para uma conversa no WhatsApp já com o pedido escrito.
- Preencha `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM` para enviar um e-mail de confirmação ao cliente. Sem isso preenchido, o e-mail simplesmente não é enviado (o pedido continua sendo salvo normalmente).
- Rode a parte final do `schema.sql` (adiciona as colunas de nome/e-mail/telefone do cliente na tabela `orders`).
